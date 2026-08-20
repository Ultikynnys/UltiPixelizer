import {
  AmbientLight,
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
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type NormalMapTypes,
} from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { flipRowsVertically, pixelsToCanvas } from './canvas';
import { DEFAULT_SMOOTH_ANGLE } from './defaults';
import { createBoundedLru } from './lru';

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

export function cloneModelScene(source: Object3D): Object3D {
  const clone = cloneSkeleton(source);
  const textures = new Map<Texture, Texture>();
  const cloneMaterial = (sourceMaterial: Material): Material => {
    const material = sourceMaterial.clone();
    for (const [property, value] of Object.entries(material)) {
      if (!(value instanceof Texture)) continue;
      if (value.image == null) {
        // Loader placeholder — the texture never decoded (missing file or
        // undefined filename). Cloning it would bump its version while the
        // image stays null, so the renderer would warn
        // "Texture marked for update but no image data found" every frame.
        // A material slot without a map is the correct rendering for it.
        (material as unknown as Record<string, unknown>)[property] = null;
        continue;
      }
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

export type HeightSampler = (u: number, v: number) => number;

/** The no-model fallback: a flat quad facing up (normal +Y) with UVs spanning
 * 0..1. The bake layer substitutes it when no model is loaded so AO/lightmap
 * bakes still produce a result, and the viewports hold it so the 3D view has
 * geometry without a model. Each call returns a fresh instance — the bake
 * layer keeps one as a cache-identity singleton (see getFallbackQuadScene),
 * the viewports need their own per-scene instance (three.js parenting forbids
 * sharing one Object3D).
 * PlaneGeometry lies in the XY plane facing +Z; rotateX(-π/2) turns its
 * normal up to +Y, so the default sun (which travels downward) lights it.
 * `tessellation` subdivides the plane (segments per side) so displacement has
 * vertices to work with. `grid` arranges nine tiles around the origin: the
 * middle tile is the bake surface, while the eight neighbors are marked
 * `userData.occluderOnly` — they cast shadows on the middle tile's bake but
 * never rasterize into it (their UVs span the same 0..1 region, so writing
 * them would clobber the middle tile's texture). `collectBakeScene` reads the
 * marker; every other consumer (viewports, displacement, texture application)
 * ignores it. */
export function createFallbackQuadScene(tessellation = 1, grid = false): Object3D {
  // One geometry per scene, shared by every tile — the tiles differ only by
  // position, so grid mode's nine PlaneGeometry allocations collapse to one.
  const geometry = new PlaneGeometry(1, 1, tessellation, tessellation);
  geometry.rotateX(-Math.PI / 2);
  const tile = (x: number, z: number): Mesh => {
    // DoubleSide: displacement raises cliffs whose far faces point away from
    // the viewport camera — with the default FrontSide those backfaces get
    // culled and the plane reads as having holes ("gaps") even though the
    // geometry is watertight.
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
    mesh.position.set(x, 0, z);
    return mesh;
  };
  if (!grid) return tile(0, 0);
  const root = new Object3D();
  for (let x = -1; x <= 1; x += 1) {
    for (let z = -1; z <= 1; z += 1) {
      const mesh = tile(x, z);
      if (x !== 0 || z !== 0) mesh.userData.occluderOnly = true;
      root.add(mesh);
    }
  }
  return root;
}

/** Memoized fallback quad scenes for the bake layer, keyed by the
 * (tessellation, grid) parameters. The bake quad is the one consumer that can
 * hold a stable Object3D identity — the viewports need per-scene instances
 * (three.js forbids sharing one Object3D across parents), so re-selecting a
 * previous tessellation/grid returns the exact same scene and the bake-scene
 * cache (keyed by scene identity, see bakeSceneCache) hits without
 * re-collecting the tessellated mesh. Displacement mutates vertices in place
 * and is idempotent, so the cached scene survives repeated displacement
 * applications. Bounded LRU: dragging the tessellation slider can visit many
 * densities, and each entry holds a full 3×3 grid's geometry at that density.
 * Evicted scenes are simply dropped (no dispose) — they were never handed to
 * the WebGL renderer, so their GPU buffers are released with them. */
const FALLBACK_QUAD_CACHE_SIZE = 4;
const fallbackQuadCache = createBoundedLru<string, Object3D>(FALLBACK_QUAD_CACHE_SIZE);
export function getFallbackQuadScene(tessellation: number, grid: boolean): Object3D {
  const key = `${tessellation}:${grid ? 'grid' : 'tile'}`;
  const cached = fallbackQuadCache.get(key);
  if (cached) {
    // Bump recency — delete + re-set moves the entry to the map's tail.
    fallbackQuadCache.delete(key);
    fallbackQuadCache.set(key, cached);
    return cached;
  }
  const created = createFallbackQuadScene(tessellation, grid);
  fallbackQuadCache.set(key, created);
  return created;
}

// Pristine vertex data per geometry, captured on first displacement so every
// subsequent application (and restore) is computed from the original shape —
// never from an already-displaced snapshot. Keyed weakly: clones (viewport
// models, AO scenes, the bake quad) each cache their own base on first use.
const displacementBase = new WeakMap<BufferGeometry, { position: Float32Array; normal: Float32Array }>();

/** Displaces every mesh's vertices along their original normals by the
 * heightmap sample at each vertex's UV: `(height − 0.5) × 2 × strength`, so
 * mid-gray leaves the mesh untouched, white pushes out, black pulls in.
 * Vertex normals are recomputed after displacement so the lightmap bake (and
 * the viewport) shade the bumps. Passing null (or zero strength) restores the
 * pristine geometry. Applies in place — safe to call repeatedly, and safe on
 * any clone of a displaced scene since the base is cached per geometry. */
export function applyDisplacement(root: Object3D, height: HeightSampler | null, strength: number): void {
  const sampler = height !== null && strength !== 0 ? height : null;
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const geometry = child.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    if (!position || !normal || !uv) return;
    let base = displacementBase.get(geometry);
    if (!base) {
      base = { position: new Float32Array(position.count * 3), normal: new Float32Array(normal.count * 3) };
      for (let i = 0; i < position.count; i += 1) {
        base.position[i * 3] = position.getX(i);
        base.position[i * 3 + 1] = position.getY(i);
        base.position[i * 3 + 2] = position.getZ(i);
        base.normal[i * 3] = normal.getX(i);
        base.normal[i * 3 + 1] = normal.getY(i);
        base.normal[i * 3 + 2] = normal.getZ(i);
      }
      displacementBase.set(geometry, base);
    }
    for (let i = 0; i < position.count; i += 1) {
      const offset = sampler ? (sampler(uv.getX(i), uv.getY(i)) - 0.5) * 2 * strength : 0;
      const o = i * 3;
      position.setXYZ(i, base.position[o] + base.normal[o] * offset, base.position[o + 1] + base.normal[o + 1] * offset, base.position[o + 2] + base.normal[o + 2] * offset);
    }
    position.needsUpdate = true;
    if (sampler) {
      geometry.computeVertexNormals();
    } else {
      for (let i = 0; i < normal.count; i += 1) {
        normal.setXYZ(i, base.normal[i * 3], base.normal[i * 3 + 1], base.normal[i * 3 + 2]);
      }
      normal.needsUpdate = true;
    }
    geometry.computeBoundingSphere();
  });
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

// Lazy singleton renderer shared by every mesh-slot thumbnail — one offscreen
// WebGL context for all small previews instead of one per model or per render.
let thumbnailRenderer: WebGLRenderer | null = null;
let thumbnailCamera: PerspectiveCamera | null = null;

/** Renders a model into a small square canvas for the ribbon's mesh slot. The
 * Lambert materials the pipeline converts to need a light to be visible, so the
 * model renders under a full-white ambient — the same lighting the viewports
 * use. The renderer's canvas is never composited (it stays offscreen), so the
 * pixels are read straight out of the GL drawing buffer: `finish()` waits for
 * the frame to complete, then `readPixels` copies it (rows flipped, since GL
 * is bottom-up) into the returned canvas. */
export function renderModelThumbnail(model: Object3D, size = 40): HTMLCanvasElement {
  let renderer = thumbnailRenderer;
  if (!renderer) {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    thumbnailRenderer = renderer;
    thumbnailCamera = new PerspectiveCamera(45, 1, 0.01, 1000);
  }
  // Renderer and camera are created together, so a cached renderer implies a
  // cached camera.
  const camera = thumbnailCamera!;
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  // Fit the framing (center / near / far), then aim the camera at the classic
  // 3/4 portrait angle — 45° above the horizon and 45° around, looking down at
  // the model from its front-right — so the thumbnail always reads as a
  // three-quarter view instead of a straight-on or top-down shot.
  const center = fitCameraToObject(camera, model, 1);
  const distance = camera.position.distanceTo(center);
  const elevation = Math.PI / 4;
  const azimuth = Math.PI / 4;
  camera.position.copy(center).add(new Vector3(
    Math.cos(elevation) * Math.sin(azimuth) * distance,
    Math.sin(elevation) * distance,
    Math.cos(elevation) * Math.cos(azimuth) * distance,
  ));
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  const scene = new Scene();
  scene.add(model, new AmbientLight(0xffffff, Math.PI));
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.render(scene, camera);
  scene.remove(model);
  const gl = renderer.getContext();
  // Block until the GPU has finished drawing, then read the framebuffer
  // directly — drawing the canvas element instead can return an untouched
  // (white) bitmap, since the offscreen canvas is never presented.
  gl.finish();
  const raw = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const pixels = new Uint8ClampedArray(raw.buffer);
  // readPixels is bottom-up, so flip the copy to match the DOM's top-left.
  const flipped = new Uint8ClampedArray(pixels);
  flipRowsVertically(flipped, size, size);
  return pixelsToCanvas(flipped, size, size);
}
