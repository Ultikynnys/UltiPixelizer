import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  type NormalMapTypes,
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

const _faceEdge = new Vector3();

/** Face normal for triangle (A, B, C) via (B − A) × (C − A). Magnitude = 2 ×
 * triangle area; winding matches Three's `computeVertexNormals`. */
export function triangleNormal(pA: Vector3, pB: Vector3, pC: Vector3, target: Vector3): Vector3 {
  _faceEdge.subVectors(pC, pA);
  return target.subVectors(pB, pA).cross(_faceEdge);
}

/** Resolves the three vertex indices of triangle `tri` in `geometry`'s index
 * buffer, or the sequential indices for non-indexed geometry. */
export function triangleIndices(geometry: BufferGeometry, tri: number): [number, number, number] {
  const index = geometry.getIndex();
  return [
    index ? index.getX(tri * 3) : tri * 3,
    index ? index.getX(tri * 3 + 1) : tri * 3 + 1,
    index ? index.getX(tri * 3 + 2) : tri * 3 + 2,
  ];
}

/** Iterates every triangle of `geometry` (indexed or not), passing the three
 * vertex indices and the triangle ordinal. Shared by the bake scene collector,
 * UV overlap detector, and the overlap highlight. */
export function forEachTriangle(
  geometry: BufferGeometry,
  callback: (ia: number, ib: number, ic: number, triangleIndex: number) => void,
): void {
  const position = geometry.getAttribute('position') as BufferAttribute | undefined;
  if (!position) return;
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;
  for (let tri = 0; tri < triangleCount; tri += 1) {
    const [ia, ib, ic] = triangleIndices(geometry, tri);
    callback(ia, ib, ic, tri);
  }
}

/** Iterates every Mesh in a subtree in depth-first order, passing the mesh and
 * its traversal index. The index counts *all* meshes (visible or not) so it
 * stays stable across identical-topology clones — the UV-overlap detector and
 * the 3D overlap overlay both depend on this shared ordering. */
export function forEachMeshIndexed(object: Object3D, callback: (mesh: Mesh, index: number) => void): void {
  let index = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const meshIndex = index;
    index += 1;
    callback(child, meshIndex);
  });
}

/** Recomputes vertex normals with angle-based smoothing, discarding any existing
 * normal attribute. Adjacent faces sharing an edge are smoothed (share a normal)
 * only when the angle between their face normals is below `angleDeg`; otherwise
 * the edge stays hard. Indexed geometry is expanded to non-indexed so hard edges
 * can own separate vertices; non-indexed geometry (FBX/OBJ exports duplicate
 * every face corner) is welded by position first so shared vertices smooth
 * across. Returns the geometry to use — the same object, or a new de-indexed
 * geometry the caller should substitute in. */
export function computeSmoothNormals(geometry: BufferGeometry, angleDeg = DEFAULT_SMOOTH_ANGLE): BufferGeometry {
  geometry.deleteAttribute('normal');
  const position = geometry.getAttribute('position') as BufferAttribute | undefined;
  if (!position) return geometry;

  const index = geometry.index;
  const cornerCount = index ? index.count : position.count;
  const triangleCount = cornerCount / 3;

  // `vertexOf` maps each corner to the position it reads; `groupOf` maps each
  // corner to the shared vertex it belongs to. For indexed geometry both are the
  // index entry. Non-indexed geometry (FBX/OBJ exports duplicate every face
  // corner), so `vertexOf` is the identity while `groupOf` welds identical
  // positions back into shared vertices.
  const vertexOf = new Int32Array(cornerCount);
  const groupOf = new Int32Array(cornerCount);
  if (index) {
    for (let i = 0; i < cornerCount; i += 1) {
      vertexOf[i] = index.getX(i);
      groupOf[i] = index.getX(i);
    }
  } else {
    const weld = new Map<string, number>();
    for (let i = 0; i < cornerCount; i += 1) {
      vertexOf[i] = i;
      const key = `${position.getX(i).toFixed(6)},${position.getY(i).toFixed(6)},${position.getZ(i).toFixed(6)}`;
      let group = weld.get(key);
      if (group === undefined) {
        group = weld.size;
        weld.set(key, group);
      }
      groupOf[i] = group;
    }
  }

  const cosThreshold = Math.cos((angleDeg * Math.PI) / 180);

  const faceNormals = new Float32Array(cornerCount);
  const faceAreas = new Float32Array(triangleCount);
  const pA = new Vector3();
  const pB = new Vector3();
  const pC = new Vector3();
  const cb = new Vector3();

  for (let tri = 0; tri < triangleCount; tri += 1) {
    const base = tri * 3;
    pA.fromBufferAttribute(position, vertexOf[base]);
    pB.fromBufferAttribute(position, vertexOf[base + 1]);
    pC.fromBufferAttribute(position, vertexOf[base + 2]);
    triangleNormal(pA, pB, pC, cb);
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
      const vertexA = groupOf[base + k];
      const vertexB = groupOf[base + ((k + 1) % 3)];
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

  const output = index ? geometry.toNonIndexed() : geometry;
  const normalAttribute = new BufferAttribute(new Float32Array(cornerCount * 3), 3);
  normalAttribute.needsUpdate = true;
  for (let corner = 0; corner < cornerCount; corner += 1) {
    const root = find(corner);
    const x = accX[root];
    const y = accY[root];
    const z = accZ[root];
    const length = Math.sqrt(x * x + y * y + z * z) || 1;
    normalAttribute.setXYZ(corner, x / length, y / length, z / length);
  }
  output.setAttribute('normal', normalAttribute);
  return output;
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

/**
 * Subdivides every triangle into `segments²` subtriangles on a uniform
 * barycentric grid, interpolating `position` and every `uv*` attribute, and
 * returns a non-indexed geometry. `segments <= 1` returns the input unchanged.
 * Normals and other non-interpolatable attributes (tangents, vertex colors,
 * skinning) are intentionally dropped — the caller recomputes normals and
 * re-applies the active UV channel afterward. Material groups are scaled by
 * `segments²` so multi-material meshes keep their assignments.
 */
export function tessellateGeometry(geometry: BufferGeometry, segments: number): BufferGeometry {
  if (segments <= 1) return geometry;
  const position = geometry.getAttribute('position') as BufferAttribute | undefined;
  if (!position) return geometry;

  const uvNames = Object.keys(geometry.attributes).filter((name) => uvPattern.test(name));
  const uvAttrs = uvNames.map((name) => geometry.getAttribute(name) as BufferAttribute);
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;

  const positions: number[] = [];
  const uvs: number[][] = uvAttrs.map(() => []);
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const p = new Vector3();
  const uvCorners = uvAttrs.map(() => [0, 0, 0, 0, 0, 0]);

  for (let tri = 0; tri < triangleCount; tri += 1) {
    const [ia, ib, ic] = triangleIndices(geometry, tri);
    pa.fromBufferAttribute(position, ia);
    pb.fromBufferAttribute(position, ib);
    pc.fromBufferAttribute(position, ic);
    for (let c = 0; c < uvAttrs.length; c += 1) {
      const attr = uvAttrs[c];
      uvCorners[c][0] = attr.getX(ia);
      uvCorners[c][1] = attr.getY(ia);
      uvCorners[c][2] = attr.getX(ib);
      uvCorners[c][3] = attr.getY(ib);
      uvCorners[c][4] = attr.getX(ic);
      uvCorners[c][5] = attr.getY(ic);
    }

    // Lattice vertices on the barycentric grid, computed once per triangle so
    // shared grid nodes resolve to identical positions for position welding.
    const latticePositions: number[] = [];
    const latticeUVs: number[][] = uvAttrs.map(() => []);
    const latticeIndex: number[][] = [];
    for (let j = 0; j <= segments; j += 1) {
      latticeIndex[j] = [];
      for (let i = 0; i <= segments - j; i += 1) {
        latticeIndex[j][i] = latticePositions.length / 3;
        const k = segments - i - j;
        const wA = i / segments;
        const wB = j / segments;
        const wC = k / segments;
        p.set(0, 0, 0).addScaledVector(pa, wA).addScaledVector(pb, wB).addScaledVector(pc, wC);
        latticePositions.push(p.x, p.y, p.z);
        for (let c = 0; c < uvAttrs.length; c += 1) {
          const [ax, ay, bx, by, cx, cy] = uvCorners[c];
          latticeUVs[c].push(ax * wA + bx * wB + cx * wC, ay * wA + by * wB + cy * wC);
        }
      }
    }

    const emit = (lattice: number): void => {
      positions.push(latticePositions[lattice * 3], latticePositions[lattice * 3 + 1], latticePositions[lattice * 3 + 2]);
      for (let c = 0; c < uvAttrs.length; c += 1) {
        uvs[c].push(latticeUVs[c][lattice * 2], latticeUVs[c][lattice * 2 + 1]);
      }
    };
    // Up-facing subtriangles, one per grid node with i + j ≤ segments − 1.
    for (let j = 0; j < segments; j += 1) {
      for (let i = 0; i + j <= segments - 1; i += 1) {
        emit(latticeIndex[j][i]);
        emit(latticeIndex[j][i + 1]);
        emit(latticeIndex[j + 1][i]);
      }
    }
    // Down-facing subtriangles, one per grid node with i + j ≤ segments − 2.
    for (let j = 0; j < segments - 1; j += 1) {
      for (let i = 0; i + j <= segments - 2; i += 1) {
        emit(latticeIndex[j][i + 1]);
        emit(latticeIndex[j + 1][i + 1]);
        emit(latticeIndex[j + 1][i]);
      }
    }
  }

  const output = new BufferGeometry();
  output.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  uvNames.forEach((name, c) => output.setAttribute(name, new BufferAttribute(new Float32Array(uvs[c]), 2)));
  const segmentSquared = segments * segments;
  for (const group of geometry.groups) {
    output.addGroup(group.start * segmentSquared, group.count * segmentSquared, group.materialIndex);
  }
  return output;
}

/**
 * Returns the pristine base geometry for a mesh — the original `position`, UV
 * channels, and index before any tessellation or de-indexing. Cached in
 * `userData.ultiPixelizerBase`; three.js clones `userData` by reference, so
 * every geometry cloned from this mesh shares the same base and re-tessellation
 * rebuilds from the original rather than a compounded copy.
 */
export function baseGeometryOf(geometry: BufferGeometry): BufferGeometry {
  const cached = geometry.userData.ultiPixelizerBase as BufferGeometry | undefined;
  if (cached) return cached;
  const base = new BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name === 'position' || uvPattern.test(name)) base.setAttribute(name, (attribute as BufferAttribute).clone());
  }
  if (geometry.index) base.setIndex(geometry.index.clone());
  geometry.userData.ultiPixelizerBase = base;
  return base;
}

/**
 * Rebuilds every mesh's surface from its pristine base geometry: optionally
 * tessellating to `tessellation` segments per edge, then recomputing smooth
 * vertex normals at `angleDeg`. The base is cached per mesh, so a later call at
 * a different tessellation level rebuilds from the original geometry rather than
 * compounding subdivision. Returns the mesh count.
 */
export function prepareSurfaceNormals(object: Object3D, angleDeg = DEFAULT_SMOOTH_ANGLE, tessellation = 1): number {
  let meshCount = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const base = baseGeometryOf(child.geometry);
    const tessellated = tessellateGeometry(base, tessellation);
    const smoothed = computeSmoothNormals(tessellated, angleDeg);
    smoothed.userData.ultiPixelizerBase = base;
    const previous = child.geometry;
    child.geometry = smoothed;
    if (previous !== smoothed) previous.dispose();
    if (tessellated !== base && tessellated !== smoothed) tessellated.dispose();
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

const _white = new Color(0xffffff);

/**
 * Builds the matte Lambert equivalent of a source material, preserving every
 * diffuse-relevant channel and dropping every specular / gloss channel by
 * construction. `MeshLambertMaterial` has no specular term in its shader, so a
 * black albedo renders black under any light. Returns the source unchanged when
 * it is already matte: `MeshLambertMaterial`, or `MeshBasicMaterial` (glTF
 * unlit — deliberately ignores lights). Custom `ShaderMaterial`s pass through
 * untouched — their shading is author-controlled.
 */
function lambertFromMaterial(material: Material): Material {
  if (material instanceof MeshLambertMaterial || material instanceof MeshBasicMaterial) return material;
  if (material instanceof ShaderMaterial) return material;
  const source = material as Material & {
    color?: Color;
    map?: Texture | null;
    alphaMap?: Texture | null;
    emissive?: Color;
    emissiveIntensity?: number;
    emissiveMap?: Texture | null;
    aoMap?: Texture | null;
    aoMapIntensity?: number;
    bumpMap?: Texture | null;
    bumpScale?: number;
    normalMap?: Texture | null;
    normalMapType?: NormalMapTypes;
    normalScale?: Vector2;
    vertexColors?: boolean;
    flatShading?: boolean;
  };
  const lambert = new MeshLambertMaterial();
  lambert.color.copy(source.color ?? _white);
  if (source.map) lambert.map = source.map;
  if (source.alphaMap) lambert.alphaMap = source.alphaMap;
  if (source.emissive) lambert.emissive.copy(source.emissive);
  if (source.emissiveIntensity !== undefined) lambert.emissiveIntensity = source.emissiveIntensity;
  if (source.emissiveMap) lambert.emissiveMap = source.emissiveMap;
  if (source.aoMap) {
    lambert.aoMap = source.aoMap;
    if (source.aoMapIntensity !== undefined) lambert.aoMapIntensity = source.aoMapIntensity;
  }
  if (source.bumpMap) {
    lambert.bumpMap = source.bumpMap;
    if (source.bumpScale !== undefined) lambert.bumpScale = source.bumpScale;
  }
  if (source.normalMap) {
    lambert.normalMap = source.normalMap;
    if (source.normalMapType !== undefined) lambert.normalMapType = source.normalMapType;
    if (source.normalScale) lambert.normalScale.copy(source.normalScale);
  }
  if (source.vertexColors !== undefined) lambert.vertexColors = source.vertexColors;
  if (source.flatShading !== undefined) lambert.flatShading = source.flatShading;
  lambert.transparent = material.transparent;
  lambert.opacity = material.opacity;
  lambert.side = material.side;
  lambert.alphaTest = material.alphaTest;
  lambert.alphaHash = material.alphaHash;
  lambert.depthTest = material.depthTest;
  lambert.depthWrite = material.depthWrite;
  return lambert;
}

/**
 * Replaces every material in a model subtree with its matte Lambert equivalent,
 * so the model renders with pure diffuse shading — a black albedo stays black
 * under any light. Loader materials (Phong / Standard / Physical) always carry a
 * specular response that per-property stripping cannot fully remove — three r185
 * `MeshStandardMaterial` hardcodes a 4% dielectric F0 (white at grazing angles),
 * which shows up as a sheen on black surfaces. Returns the conversion count.
 */
export function convertToLambertShading(object: Object3D): number {
  let materialCount = 0;
  const disposed = new Set<Material>();
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const converted = materialsOf(child).map((material) => {
      const lambert = lambertFromMaterial(material);
      if (lambert === material) return material;
      if (!disposed.has(material)) {
        disposed.add(material);
        material.dispose();
      }
      materialCount += 1;
      return lambert;
    });
    child.material = converted.length === 1 ? converted[0] : converted;
  });
  return materialCount;
}

export function applyTextureToMaterial(material: Material, texture: Texture): void {
  const textured = material as Material & {
    map?: Texture | null;
    color?: Color;
    transparent?: boolean;
  };
  if (!('map' in textured)) return;
  textured.map = texture;
  textured.color?.set(0xffffff);
  textured.transparent = true;
  textured.side = DoubleSide;
  textured.needsUpdate = true;
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
