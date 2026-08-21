import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Mesh,
  Object3D,
  Ray,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { computeSmoothNormals, forEachTriangle, triangleNormal } from './modelScene';

export type UvPair = [number, number];
export type BakeVertex = { position: Vector3; normal: Vector3 };
export type BakeTriangle = { uv: [UvPair, UvPair, UvPair]; verts: [number, number, number] };

export type BakeScene = {
  vertices: BakeVertex[];
  triangles: BakeTriangle[];
  bvh: MeshBVH | null;
  /** Offset applied to ray origins to avoid self-intersection. */
  epsilon: number;
  /** Occlusion reach as a multiple of the mesh bounding-sphere radius. */
  radius: number;
  maxDistance: number;
  /** Flat world-space occluder triangle positions, 9 floats per triangle. */
  occluderPositions: Float32Array;
  /** Per-triangle MikkTSpace tangent bases, [tangent.xyz, bitangent.xyz] per
   * triangle — a pure function of the collected geometry, computed once here
   * and shared by the lightmap and AO bakes (which reuse the cached scene
   * instead of rebuilding the bases on every sun/strength re-bake). */
  tangentBases: Float32Array | null;
};

/**
 * Builds an orthonormal tangent/bitangent basis for a triangle from its
 * world-space positions and UVs (MikkTSpace-style). Tangent and bitangent follow
 * the UV gradients and are re-orthogonalized against the triangle face normal;
 * the shading normal is interpolated from per-vertex normals by the caller, so
 * light (and AO hemispheres) respect source / smoothed normals rather than the
 * flat face normal. Throws for degenerate triangles — callers skip those before
 * reaching here.
 */
export function computeTangentBasis(
  p0: Vector3,
  p1: Vector3,
  p2: Vector3,
  uv0: UvPair,
  uv1: UvPair,
  uv2: UvPair,
): [Vector3, Vector3] {
  const e1 = new Vector3().subVectors(p1, p0);
  const e2 = new Vector3().subVectors(p2, p0);
  const normal = triangleNormal(p0, p1, p2, new Vector3());
  const du1 = uv1[0] - uv0[0];
  const dv1 = uv1[1] - uv0[1];
  const du2 = uv2[0] - uv0[0];
  const dv2 = uv2[1] - uv0[1];
  const det = du1 * dv2 - du2 * dv1;
  if (normal.lengthSq() === 0 || Math.abs(det) <= 1e-12) {
    throw new Error('Cannot build a tangent basis for a degenerate triangle.');
  }
  normal.normalize();
  const f = 1 / det;
  const tangent = new Vector3(
    f * (dv2 * e1.x - dv1 * e2.x),
    f * (dv2 * e1.y - dv1 * e2.y),
    f * (dv2 * e1.z - dv1 * e2.z),
  );
  const bitangent = new Vector3(
    f * (-du2 * e1.x + du1 * e2.x),
    f * (-du2 * e1.y + du1 * e2.y),
    f * (-du2 * e1.z + du1 * e2.z),
  );
  tangent.addScaledVector(normal, -tangent.dot(normal)).normalize();
  bitangent.addScaledVector(normal, -bitangent.dot(normal)).normalize();
  return [tangent, bitangent];
}

/**
 * Walks the scene and collects everything a UV-space bake needs:
 * world-space occluder positions, deduplicated per-vertex samples (position +
 * normal), bake triangles, and a BVH over the occluders.
 *
 * Every mesh contributes to occlusion; only meshes that carry both a `uv` and a
 * `normal` attribute are baked. Meshes marked `userData.occluderOnly === true`
 * (e.g. the fallback grid's neighbor tiles) block light but never rasterize —
 * their UVs span the same 0..1 region as the middle tile, so writing them
 * would clobber its texture. Meshes missing normals are recomputed via
 * `computeSmoothNormals`, so pass a disposable scene (a clone) if you need to
 * keep the original untouched. Degenerate triangles (zero world area, or
 * collapsed UVs) are skipped — they have no surface to light.
 */
export function collectBakeScene(scene: Object3D, distance = 2): BakeScene {
  scene.updateMatrixWorld(true);

  const worldPositions: number[] = [];
  const vertices: BakeVertex[] = [];
  const triangles: BakeTriangle[] = [];
  const vertexIndexByKey = new Map<string, number>();
  const normalMatrix = new Matrix3();
  const n = new Vector3();
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const faceNormal = new Vector3();

  scene.traverse((child) => {
    if (!(child instanceof Mesh) || !child.visible) return;
    let geometry = child.geometry as BufferGeometry;
    if (!geometry.getAttribute('position')) return;
    // Occluder-only meshes (the fallback grid's neighbor tiles) block light
    // but are never rasterized into the bake — their UVs span the same 0..1
    // region as the middle tile, so writing them would clobber its texture.
    const occluderOnly = child.userData?.occluderOnly === true;

    let uv: BufferAttribute | undefined;
    let normal: BufferAttribute | undefined;
    if (!occluderOnly) {
      uv = geometry.getAttribute('uv') as BufferAttribute | undefined;
      normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
      if (uv && !normal) {
        const flat = computeSmoothNormals(geometry);
        if (flat !== geometry) {
          child.geometry = flat;
          geometry.dispose();
          geometry = flat;
        }
        uv = geometry.getAttribute('uv') as BufferAttribute | undefined;
        normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
      }
    }

    const position = geometry.getAttribute('position') as BufferAttribute;
    const world = child.matrixWorld;
    normalMatrix.getNormalMatrix(world);

    forEachTriangle(geometry, (ia, ib, ic) => {
      // World-space corners. A zero-area triangle has no surface to light or
      // occlude, so it is skipped entirely.
      pa.fromBufferAttribute(position, ia).applyMatrix4(world);
      pb.fromBufferAttribute(position, ib).applyMatrix4(world);
      pc.fromBufferAttribute(position, ic).applyMatrix4(world);
      if (triangleNormal(pa, pb, pc, faceNormal).lengthSq() === 0) return;

      // Occluder triangles (world space) — every mesh contributes.
      worldPositions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z);

      // Bakeable surface — needs UVs, normals, and a non-degenerate UV footprint.
      if (occluderOnly || !uv || !normal) return;
      const uva: UvPair = [uv.getX(ia), uv.getY(ia)];
      const uvb: UvPair = [uv.getX(ib), uv.getY(ib)];
      const uvc: UvPair = [uv.getX(ic), uv.getY(ic)];
      const det = (uvb[0] - uva[0]) * (uvc[1] - uva[1]) - (uvc[0] - uva[0]) * (uvb[1] - uva[1]);
      if (Math.abs(det) <= 1e-12) return;

      const corners = [pa, pb, pc];
      const verts: [number, number, number] = [ia, ib, ic].map((vi, cornerIndex) => {
        const corner = corners[cornerIndex];
        n.fromBufferAttribute(normal, vi).applyMatrix3(normalMatrix).normalize();
        // Dedup key: values quantized to 1e-6 integers instead of
        // `toFixed(6)` strings — same grouping (both round at 6 decimals),
        // ~1.8× faster on 60k-tri models (180k+ corner keys).
        const key = `${Math.round(corner.x * 1e6)}|${Math.round(corner.y * 1e6)}|${Math.round(corner.z * 1e6)}|${Math.round(n.x * 1e6)}|${Math.round(n.y * 1e6)}|${Math.round(n.z * 1e6)}`;
        let resolved = vertexIndexByKey.get(key);
        if (resolved === undefined) {
          resolved = vertices.length;
          vertices.push({ position: corner.clone(), normal: n.clone() });
          vertexIndexByKey.set(key, resolved);
        }
        return resolved;
      }) as [number, number, number];
      triangles.push({ uv: [uva, uvb, uvc], verts });
    });
  });

  // Per-triangle MikkTSpace tangent bases — a pure function of the world
  // positions and UVs, so they're computed once per collected scene and shared
  // by the lightmap and AO bakes (each re-bake reuses the cached scene rather
  // than rebuilding the bases on every sun/strength tweak). The collection
  // loop above already skipped degenerate triangles (zero world area or
  // collapsed UVs), so computeTangentBasis cannot throw here.
  const tangentBases = new Float32Array(triangles.length * 6);
  for (let i = 0; i < triangles.length; i += 1) {
    const triangle = triangles[i];
    const [tangent, bitangent] = computeTangentBasis(
      vertices[triangle.verts[0]].position,
      vertices[triangle.verts[1]].position,
      vertices[triangle.verts[2]].position,
      triangle.uv[0], triangle.uv[1], triangle.uv[2],
    );
    const offset = i * 6;
    tangentBases[offset] = tangent.x;
    tangentBases[offset + 1] = tangent.y;
    tangentBases[offset + 2] = tangent.z;
    tangentBases[offset + 3] = bitangent.x;
    tangentBases[offset + 4] = bitangent.y;
    tangentBases[offset + 5] = bitangent.z;
  }

  const occluderPositions = new Float32Array(worldPositions);
  const occluder = new BufferGeometry();
  occluder.setAttribute('position', new BufferAttribute(occluderPositions, 3));
  occluder.computeBoundingSphere();
  const radius = occluder.boundingSphere!.radius;
  const maxDistance = radius * distance;
  const epsilon = Math.max(radius * 1e-3, 1e-4);
  const bvh = worldPositions.length ? new MeshBVH(occluder) : null;

  return { vertices, triangles, bvh, epsilon, radius, maxDistance, occluderPositions, tangentBases };
}

const _occlusionRay = new Ray();
const _hitPoint = new Vector3();

// Module-level state + callbacks for the occlusion shapecast. The AO bake fires
// one occlusion test per sample (hundreds of millions at 1k resolution), so the
// callbacks are hoisted here instead of allocating a closure pair per ray. The
// shared ray, near/far bounds, and hit scratch are set per cast.
let _castRay: Ray = _occlusionRay;
let _castNear = 0;
let _castFar = Number.POSITIVE_INFINITY;

function _occlusionBounds(box: Box3): boolean {
  return rayBoxIntersects(_castRay, box, _castNear, _castFar);
}

/** Boolean triangle test within [near, far]. three-mesh-bvh pre-populates a
 * pooled `ExtendedTriangle` for each leaf triangle (its `.a/.b/.c` are plain
 * Vector3s), so no `fromBufferAttribute` copies are needed here. */
function _occlusionTriangle(triangle: { a: Vector3; b: Vector3; c: Vector3 }): boolean {
  if (_castRay.intersectTriangle(triangle.a, triangle.b, triangle.c, false, _hitPoint) === null) return false;
  const distance = _castRay.origin.distanceTo(_hitPoint);
  return distance >= _castNear && distance <= _castFar;
}

const _occlusionCallbacks = {
  intersectsBounds: _occlusionBounds,
  intersectsTriangle: _occlusionTriangle,
};

/**
 * Occluder raycast shared by the AO and lightmap bakes: offsets the ray origin
 * along the surface normal by `epsilon` (avoiding self-intersection) and tests
 * against the bake BVH. Reuses a module-level Ray so hot bake loops don't
 * allocate. `near`/`far` keep each caller's intersection bounds.
 *
 * First-hit traversal: boolean occlusion never needs the closest hit, so this
 * uses shapecast to stop at the first triangle intersection instead of
 * raycastFirst's closest-hit search (which tests every candidate triangle). The
 * node-bound slab test and the triangle test mirror three-mesh-bvh's own
 * near/far and DoubleSide semantics, so the answer matches
 * `raycastFirst(ray, DoubleSide, near, far)`.
 */
export function castBakeRay(
  bvh: MeshBVH,
  position: Vector3,
  normal: Vector3,
  direction: Vector3,
  epsilon: number,
  near = 0,
  far = Number.POSITIVE_INFINITY,
): boolean {
  _occlusionRay.origin.copy(position).addScaledVector(normal, epsilon);
  _occlusionRay.direction.copy(direction);
  _castRay = _occlusionRay;
  _castNear = near;
  _castFar = far;
  return bvh.shapecast(_occlusionCallbacks);
}

/**
 * Slab test mirroring three-mesh-bvh's `intersectsNodeBounds` so this
 * traversal descends into exactly the nodes raycastFirst would visit: the ray's
 * [tmin, tmax] overlap with the box must span the [near, far] interval. Handles
 * origins inside the box (negative tmin) and infinite far the same way.
 */
function rayBoxIntersects(ray: Ray, box: Box3, near: number, far: number): boolean {
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const invx = 1 / ray.direction.x;
  const invy = 1 / ray.direction.y;
  const invz = 1 / ray.direction.z;
  let tmin: number;
  let tmax: number;
  if (invx >= 0) {
    tmin = (box.min.x - ox) * invx;
    tmax = (box.max.x - ox) * invx;
  } else {
    tmin = (box.max.x - ox) * invx;
    tmax = (box.min.x - ox) * invx;
  }
  let tymin: number;
  let tymax: number;
  if (invy >= 0) {
    tymin = (box.min.y - oy) * invy;
    tymax = (box.max.y - oy) * invy;
  } else {
    tymin = (box.max.y - oy) * invy;
    tymax = (box.min.y - oy) * invy;
  }
  if (tmin > tymax || tymin > tmax) return false;
  if (tymin > tmin || isNaN(tmin)) tmin = tymin;
  if (tymax < tmax || isNaN(tmax)) tmax = tymax;
  let tzmin: number;
  let tzmax: number;
  if (invz >= 0) {
    tzmin = (box.min.z - oz) * invz;
    tzmax = (box.max.z - oz) * invz;
  } else {
    tzmin = (box.max.z - oz) * invz;
    tzmax = (box.min.z - oz) * invz;
  }
  if (tmin > tzmax || tzmin > tmax) return false;
  if (tzmin > tmin || tmin !== tmin) tmin = tzmin;
  if (tzmax < tmax || tmax !== tmax) tmax = tzmax;
  return tmin <= far && tmax >= near;
}

/**
 * Rasterizes triangles into a `width × height` grid, invoking `writePixel`
 * with the barycentric weights for every covered pixel. Generic over triangle
 * shape — the bake (BakeTriangle) and UV-overlap (UVTriangle) rasterizers are
 * the same math. UV (0,0) is the texture bottom-left; the canvas is top-left,
 * so V is flipped here. The flat serialized-scene sibling is
 * `rasterizeBakeBand` (band-clipped, progress-aware); both share one
 * barycentric core.
 */
/** Shared barycentric core for the two UV rasterizers: clips the triangle's
 * screen-space bbox to `[0, width − 1] × [yStart, yEnd − 1]`, tests the
 * denominator, and invokes `perPixel` for every pixel whose center falls
 * inside the triangle. `onRow` fires once per visited row (before its pixels)
 * so the band rasterizer can track progress. Both `rasterizeBake` and
 * `rasterizeBakeBand` funnel through here, so the UV-overlap detector and
 * every bake raster share one bbox clamp and one w0/w1/w2 expression and
 * can't drift. */
function rasterizeTrianglePixels(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  width: number,
  yStart: number,
  yEnd: number,
  perPixel: (px: number, py: number, w0: number, w1: number, w2: number) => void,
  onRow?: (py: number) => void,
): void {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(yStart, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(yEnd - 1, Math.ceil(Math.max(ay, by, cy)));
  const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (denominator === 0) return;
  for (let py = minY; py <= maxY; py += 1) {
    onRow?.(py);
    for (let px = minX; px <= maxX; px += 1) {
      const x = px + 0.5;
      const y = py + 0.5;
      const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
      const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      perPixel(px, py, w0, w1, w2);
    }
  }
}

/** Maps one normalized model UV into the top-left-origin texture-pixel space
 * shared by UV overlap, bakes, and the vector wireframe overlay. */
export function uvToTexturePoint(uv: UvPair, width: number, height: number): UvPair {
  return [uv[0] * width, (1 - uv[1]) * height];
}

export function rasterizeBake<T extends { uv: [UvPair, UvPair, UvPair] }>(
  width: number,
  height: number,
  triangles: readonly T[],
  writePixel: (px: number, py: number, w0: number, w1: number, w2: number, triangle: T, triangleIndex: number) => void,
): void {
  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
    const triangle = triangles[triangleIndex];
    const [a, b, c] = triangle.uv.map((uv) => uvToTexturePoint(uv, width, height));
    rasterizeTrianglePixels(
      a[0],
      a[1],
      b[0],
      b[1],
      c[0],
      c[1],
      width,
      0,
      height,
      (px, py, w0, w1, w2) => writePixel(px, py, w0, w1, w2, triangle, triangleIndex),
    );
  }
}

/**
 * Band-aware barycentric UV rasterizer over the flat serialized triangle
 * layout (`triangleUVs` / `triangleVerts` from `serializeBakeScene`): the
 * serialized-scene sibling of `rasterizeBake`, clipped to the `[yStart, yEnd)`
 * row band. Every UV-space bake raster (AO factor bands, AO GPU data, lightmap
 * CPU/worker/GPU) funnels through here so the paths stay byte-identical by
 * construction. `written` marks covered texels (band-local row-major index);
 * `perTexel` receives the barycentric weights plus the triangle offsets;
 * `onRowsComplete` reports unique rows touched for progress.
 */
export function rasterizeBakeBand(
  width: number,
  height: number,
  yStart: number,
  yEnd: number,
  triangleUVs: Float32Array,
  triangleVerts: Uint32Array,
  written: Uint8Array,
  perTexel: (
    px: number,
    py: number,
    w0: number,
    w1: number,
    w2: number,
    /** Band-local texel index (row-major within [yStart, yEnd)). */
    index: number,
    triangleIndex: number,
    /** triangleIndex * 6: this triangle's UVs start in `triangleUVs`. */
    uvOffset: number,
    /** triangleIndex * 3: this triangle's vertex indices start in `triangleVerts`. */
    vertOffset: number,
    /** Vertex offsets into the interleaved 6-float vertex array (index * 6). */
    v0: number,
    v1: number,
    v2: number,
  ) => void,
  onRowsComplete?: (rows: number) => void,
): void {
  const triangleCount = triangleVerts.length / 3;
  const bandHeight = yEnd - yStart;
  // Progress counts UNIQUE rows touched in this band, not (triangle, row)
  // visits — the raster is triangle-major, so overlapping triangles would
  // otherwise overcount rows and push the reported percent past 100.
  const rowTouched = onRowsComplete ? new Uint8Array(bandHeight) : null;
  const reportEvery = onRowsComplete ? Math.max(1, Math.floor(bandHeight / 128)) : 0;
  let rowsDone = 0;
  let lastReported = 0;
  const reportProgress = (): void => {
    if (!onRowsComplete || rowsDone - lastReported < reportEvery) return;
    lastReported = rowsDone;
    onRowsComplete(rowsDone);
  };

  const onRow = onRowsComplete
    ? (py: number): void => {
        const touched = rowTouched;
        if (!touched) return;
        const bandRow = py - yStart;
        if (touched[bandRow]) return;
        touched[bandRow] = 1;
        rowsDone += 1;
        reportProgress();
      }
    : undefined;

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const uvOffset = triangleIndex * 6;
    const vertOffset = triangleIndex * 3;
    const v0 = triangleVerts[vertOffset] * 6;
    const v1 = triangleVerts[vertOffset + 1] * 6;
    const v2 = triangleVerts[vertOffset + 2] * 6;
    rasterizeTrianglePixels(
      triangleUVs[uvOffset] * width,
      (1 - triangleUVs[uvOffset + 1]) * height,
      triangleUVs[uvOffset + 2] * width,
      (1 - triangleUVs[uvOffset + 3]) * height,
      triangleUVs[uvOffset + 4] * width,
      (1 - triangleUVs[uvOffset + 5]) * height,
      width,
      yStart,
      yEnd,
      (px, py, w0, w1, w2) => {
        const index = (py - yStart) * width + px;
        written[index] = 1;
        perTexel(px, py, w0, w1, w2, index, triangleIndex, uvOffset, vertOffset, v0, v1, v2);
      },
      onRow,
    );
  }
  if (onRowsComplete && rowsDone > lastReported) onRowsComplete(rowsDone);
}

/** Blank bake buffers: the `fill(255)` pixel map (bright background = unwritten)
 * plus the parallel written mask (1 = covered by a bake triangle). Every UV
 * bake allocates this pair up front, so the mark-then-dilate pipeline gets one
 * allocator instead of repeating the two-line idiom at each call site. */
export function blankBakeBuffers(width: number, height: number, channels: number): { pixels: Uint8ClampedArray; written: Uint8Array } {
  return {
    pixels: new Uint8ClampedArray(width * height * channels).fill(255),
    written: new Uint8Array(width * height),
  };
}

/**
 * Rasterizes bake triangles into a fresh `255`-filled buffer, marking covered
 * texels and dilating the UV islands' edges outward afterward. Every UV-space
 * bake (AO, lightmap) goes through here so the mark-then-pad pipeline stays
 * identical. `writePixel` receives the target buffer and the per-texel pixel
 * offset so callers write their channel layout directly.
 */
export function rasterizeBakedPixels(
  width: number,
  height: number,
  triangles: readonly BakeTriangle[],
  channels: number,
  writePixel: (
    pixels: Uint8ClampedArray,
    px: number,
    py: number,
    w0: number,
    w1: number,
    w2: number,
    triangle: BakeTriangle,
    triangleIndex: number,
    pixelOffset: number,
  ) => void,
): Uint8ClampedArray {
  const { pixels, written } = blankBakeBuffers(width, height, channels);
  rasterizeBake(width, height, triangles, (px, py, w0, w1, w2, triangle, triangleIndex) => {
    written[py * width + px] = 1;
    writePixel(pixels, px, py, w0, w1, w2, triangle, triangleIndex, (py * width + px) * channels);
  });
  dilateUVBake(pixels, written, width, height, channels);
  return pixels;
}

/** Texels of padding spread around UV islands after a bake. The rasterizer only
 * covers texels whose centers fall inside a triangle, so the sub-texel fringe
 * along island edges would otherwise keep the bright background fill and show
 * up as light bleed at UV seams. */
export const BAKE_PAD_TEXELS = 2;

/**
 * Dilates a baked UV-space map outward by up to `padTexels`: texels the raster
 * never wrote (they kept their background fill) inherit the average of their
 * already-filled 8 neighbors, one ring per pass. `written` (1 = covered by a
 * bake triangle) is updated in place; `pixels` holds `channels` bytes per
 * texel. Texels farther than `padTexels` from any island keep the fill.
 */
export function dilateUVBake(
  pixels: Uint8ClampedArray,
  written: Uint8Array,
  width: number,
  height: number,
  channels: number,
  padTexels = BAKE_PAD_TEXELS,
): void {
  if (padTexels <= 0 || width * height === 0) return;
  const previous = new Uint8Array(width * height);
  const sums = new Float64Array(channels);
  for (let pass = 0; pass < padTexels; pass += 1) {
    previous.set(written);
    for (let py = 0; py < height; py += 1) {
      const rowOffset = py * width;
      const yMin = Math.max(0, py - 1);
      const yMax = Math.min(height - 1, py + 1);
      for (let px = 0; px < width; px += 1) {
        const index = rowOffset + px;
        if (previous[index]) continue;
        const xMin = Math.max(0, px - 1);
        const xMax = Math.min(width - 1, px + 1);
        let count = 0;
        sums.fill(0);
        for (let ny = yMin; ny <= yMax; ny += 1) {
          const neighborRow = ny * width;
          for (let nx = xMin; nx <= xMax; nx += 1) {
            const neighbor = neighborRow + nx;
            if (!previous[neighbor]) continue;
            const pixelOffset = neighbor * channels;
            for (let c = 0; c < channels; c += 1) sums[c] += pixels[pixelOffset + c];
            count += 1;
          }
        }
        if (count === 0) continue;
        const pixelOffset = index * channels;
        for (let c = 0; c < channels; c += 1) {
          pixels[pixelOffset + c] = Math.round(sums[c] / count);
        }
        written[index] = 1;
      }
    }
  }
}
