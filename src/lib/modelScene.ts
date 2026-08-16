import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Material,
  Mesh,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { DEFAULT_SMOOTH_ANGLE } from './defaults';

const uvPattern = /^uv(\d*)$/;

export function uvChannelIndex(name: string): number {
  if (name === 'uv') return 0;
  const match = name.match(uvPattern);
  return match?.[1] ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function geometryUVChannels(object: Object3D): string[] {
  const channels = new Set<string>();
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    Object.keys(child.geometry.attributes).filter((name) => uvPattern.test(name)).forEach((name) => channels.add(name));
  });
  return Array.from(channels).sort((left, right) => uvChannelIndex(left) - uvChannelIndex(right));
}

function storedUVAttributes(mesh: Mesh): Record<string, BufferAttribute> {
  const stored = mesh.geometry.userData.ultiPixelizerUVs as Record<string, BufferAttribute> | undefined;
  if (stored) return stored;
  const attributes = Object.fromEntries(
    Object.entries(mesh.geometry.attributes).filter(([name]) => uvPattern.test(name)),
  ) as Record<string, BufferAttribute>;
  mesh.geometry.userData.ultiPixelizerUVs = attributes;
  return attributes;
}

export function applyUVChannel(object: Object3D, requested: string): { fallbackMeshes: number; missingMeshes: number } {
  let fallbackMeshes = 0;
  let missingMeshes = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const attributes = storedUVAttributes(child);
    const available = Object.keys(attributes).sort((left, right) => uvChannelIndex(left) - uvChannelIndex(right));
    const selected = attributes[requested] ?? attributes[available[0]];
    if (!selected) {
      child.geometry.deleteAttribute('uv');
      missingMeshes += 1;
      return;
    }
    if (!attributes[requested]) fallbackMeshes += 1;
    child.geometry.setAttribute('uv', selected);
  });
  return { fallbackMeshes, missingMeshes };
}

export function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Recomputes vertex normals with angle-based smoothing, discarding any existing
 * normal attribute. Adjacent faces sharing an edge are smoothed (share a normal)
 * only when the angle between their face normals is below `angleDeg`; otherwise
 * the edge stays hard. Indexed geometry is expanded to non-indexed so hard edges
 * can own separate vertices. Returns the geometry to use — the same object, or a
 * new de-indexed geometry the caller should substitute in. */
export function computeSmoothNormals(geometry: BufferGeometry, angleDeg = DEFAULT_SMOOTH_ANGLE): BufferGeometry {
  geometry.deleteAttribute('normal');
  const position = geometry.getAttribute('position') as BufferAttribute | undefined;
  if (!position) return geometry;

  const index = geometry.index;
  if (!index) {
    // Non-indexed geometry has no shared vertices to smooth across, so every
    // triangle keeps its own flat face normal.
    geometry.computeVertexNormals();
    return geometry;
  }

  const cornerCount = index.count;
  const triangleCount = cornerCount / 3;
  const cosThreshold = Math.cos((angleDeg * Math.PI) / 180);

  const faceNormals = new Float32Array(cornerCount);
  const faceAreas = new Float32Array(triangleCount);
  const pA = new Vector3();
  const pB = new Vector3();
  const pC = new Vector3();
  const cb = new Vector3();
  const ab = new Vector3();

  for (let tri = 0; tri < triangleCount; tri += 1) {
    const base = tri * 3;
    pA.fromBufferAttribute(position, index.getX(base));
    pB.fromBufferAttribute(position, index.getX(base + 1));
    pC.fromBufferAttribute(position, index.getX(base + 2));
    cb.subVectors(pC, pB);
    ab.subVectors(pA, pB);
    cb.cross(ab);
    const area = cb.length();
    if (area > 1e-12) cb.divideScalar(area);
    else cb.set(0, 0, 0);
    faceAreas[tri] = area;
    faceNormals[base] = cb.x;
    faceNormals[base + 1] = cb.y;
    faceNormals[base + 2] = cb.z;
  }

  const parent = new Int32Array(cornerCount);
  for (let i = 0; i < cornerCount; i += 1) parent[i] = i;
  const find = (value: number): number => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const edges = new Map<string, { cornerMin: number; cornerMax: number; fx: number; fy: number; fz: number }>();
  for (let tri = 0; tri < triangleCount; tri += 1) {
    const base = tri * 3;
    const fx = faceNormals[base];
    const fy = faceNormals[base + 1];
    const fz = faceNormals[base + 2];
    for (let k = 0; k < 3; k += 1) {
      const vertexA = index.getX(base + k);
      const vertexB = index.getX(base + ((k + 1) % 3));
      const minVertex = Math.min(vertexA, vertexB);
      const maxVertex = Math.max(vertexA, vertexB);
      const key = `${minVertex}:${maxVertex}`;
      const cornerA = base + k;
      const cornerB = base + ((k + 1) % 3);
      const cornerMin = vertexA === minVertex ? cornerA : cornerB;
      const cornerMax = vertexA === minVertex ? cornerB : cornerA;
      const existing = edges.get(key);
      if (existing) {
        const dot = fx * existing.fx + fy * existing.fy + fz * existing.fz;
        if (dot > cosThreshold) {
          union(cornerMin, existing.cornerMin);
          union(cornerMax, existing.cornerMax);
        }
      } else {
        edges.set(key, { cornerMin, cornerMax, fx, fy, fz });
      }
    }
  }

  const accX = new Float32Array(cornerCount);
  const accY = new Float32Array(cornerCount);
  const accZ = new Float32Array(cornerCount);
  for (let tri = 0; tri < triangleCount; tri += 1) {
    const base = tri * 3;
    const weight = faceAreas[tri];
    const fx = faceNormals[base] * weight;
    const fy = faceNormals[base + 1] * weight;
    const fz = faceNormals[base + 2] * weight;
    for (let k = 0; k < 3; k += 1) {
      const root = find(base + k);
      accX[root] += fx;
      accY[root] += fy;
      accZ[root] += fz;
    }
  }

  const nonIndexed = geometry.toNonIndexed();
  const normalAttribute = new BufferAttribute(new Float32Array(cornerCount * 3), 3);
  for (let corner = 0; corner < cornerCount; corner += 1) {
    const root = find(corner);
    const x = accX[root];
    const y = accY[root];
    const z = accZ[root];
    const length = Math.sqrt(x * x + y * y + z * z) || 1;
    normalAttribute.setXYZ(corner, x / length, y / length, z / length);
  }
  nonIndexed.setAttribute('normal', normalAttribute);
  return nonIndexed;
}

/** Rebuilds vertex normals from triangle winding for every mesh, discarding any
 * exporter-provided normals (often broken or smooth) and applying angle-based
 * smoothing. Returns the mesh count. */
export function recomputeVertexNormals(object: Object3D, angleDeg = DEFAULT_SMOOTH_ANGLE): number {
  let meshCount = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const source = child.geometry;
    const geometry = computeSmoothNormals(source, angleDeg);
    if (geometry !== source) {
      child.geometry = geometry;
      source.dispose();
    }
    meshCount += 1;
  });
  return meshCount;
}

export function cloneModelScene(source: Object3D): Object3D {
  const clone = cloneSkeleton(source);
  const textures = new Map<Texture, Texture>();
  const cloneMaterial = (sourceMaterial: Material): Material => {
    const material = sourceMaterial.clone();
    for (const [property, value] of Object.entries(material)) {
      if (!(value instanceof Texture)) continue;
      let texture = textures.get(value);
      if (!texture) {
        texture = value.clone();
        textures.set(value, texture);
      }
      (material as unknown as Record<string, unknown>)[property] = texture;
    }
    return material;
  };
  clone.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry = child.geometry.clone();
    child.material = Array.isArray(child.material)
      ? child.material.map(cloneMaterial)
      : cloneMaterial(child.material);
  });
  return clone;
}

function createNearestCanvasTexture(image: CanvasImageSource): CanvasTexture<CanvasImageSource> {
  const texture = new CanvasTexture(image);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function createPixelTexture(image: CanvasImageSource): CanvasTexture<CanvasImageSource> {
  const texture = createNearestCanvasTexture(image);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function applyTextureToMaterial(material: Material, texture: Texture): void {
  const textured = material as Material & {
    map?: Texture | null;
    color?: Color;
    transparent?: boolean;
    specular?: Color;
    shininess?: number;
    metalness?: number;
    roughness?: number;
    clearcoat?: number;
    specularIntensity?: number;
  };
  if (!('map' in textured)) return;
  textured.map = texture;
  textured.color?.set(0xffffff);
  textured.transparent = true;
  textured.side = DoubleSide;
  if ('specular' in textured) textured.specular?.set(0x000000);
  if ('shininess' in textured) textured.shininess = 0;
  if ('metalness' in textured) textured.metalness = 0;
  if ('roughness' in textured) textured.roughness = 1;
  if ('clearcoat' in textured) textured.clearcoat = 0;
  if ('specularIntensity' in textured) textured.specularIntensity = 0;
  textured.needsUpdate = true;
}

export function applyTextureToModel(object: Object3D, texture: Texture): number {
  let materialCount = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    materialsOf(child).forEach((material) => {
      applyTextureToMaterial(material, texture);
      materialCount += 1;
    });
  });
  return materialCount;
}

export function fitCameraToObject(camera: PerspectiveCamera, object: Object3D, aspect: number): Vector3 {
  const bounds = new Box3().setFromObject(object);
  const center = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3());
  const size = bounds.isEmpty() ? new Vector3(1, 1, 1) : bounds.getSize(new Vector3());
  const radius = Math.max(size.length() * 0.5, 0.01);
  camera.aspect = aspect || 1;
  camera.near = Math.max(radius / 100, 0.001);
  camera.far = Math.max(radius * 100, 100);
  camera.position.copy(center).add(new Vector3(radius * 1.1, radius * 0.65, radius * 1.6));
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}

export function disposeModel(object: Object3D): void {
  const textures = new Set<Texture>();
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.dispose();
    materialsOf(child).forEach((material) => {
      Object.values(material).forEach((value) => { if (value instanceof Texture) textures.add(value); });
      material.dispose();
    });
  });
  textures.forEach((texture) => texture.dispose());
}
