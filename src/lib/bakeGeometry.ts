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
};

/**
 * Walks the scene and collects everything a UV-space bake needs:
 * world-space occluder positions, deduplicated per-vertex samples (position +
 * normal), bake triangles, and a BVH over the occluders.
 *
 * Every mesh contributes to occlusion; only meshes that carry both a `uv` and a
 * `normal` attribute are baked. Meshes missing normals are recomputed via
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

    let uv = geometry.getAttribute('uv') as BufferAttribute | undefined;
    let normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
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
      if (!uv || !normal) return;
      const uva: UvPair = [uv.getX(ia), uv.getY(ia)];
      const uvb: UvPair = [uv.getX(ib), uv.getY(ib)];
      const uvc: UvPair = [uv.getX(ic), uv.getY(ic)];
      const det = (uvb[0] - uva[0]) * (uvc[1] - uva[1]) - (uvc[0] - uva[0]) * (uvb[1] - uva[1]);
      if (Math.abs(det) <= 1e-12) return;

      const corners = [pa, pb, pc];
      const verts: [number, number, number] = [ia, ib, ic].map((vi, cornerIndex) => {
        const corner = corners[cornerIndex];
        n.fromBufferAttribute(normal, vi).applyMatrix3(normalMatrix).normalize();
        const key = [corner.x, corner.y, corner.z, n.x, n.y, n.z].map((value) => value.toFixed(6)).join(',');
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

  const occluderPositions = new Float32Array(worldPositions);
  const occluder = new BufferGeometry();
  occluder.setAttribute('position', new BufferAttribute(occluderPositions, 3));
  occluder.computeBoundingSphere();
  const radius = occluder.boundingSphere!.radius;
  const maxDistance = radius * distance;
  const epsilon = Math.max(radius * 1e-3, 1e-4);
  const bvh = worldPositions.length ? new MeshBVH(occluder) : null;

  return { vertices, triangles, bvh, epsilon, radius, maxDistance, occluderPositions };
}

const _occlusionRay = new Ray();
const _hitPoint = new Vector3();
const _triA = new Vector3();
const _triB = new Vector3();
const _triC = new Vector3();

/**
 * Occluder raycast shared by the AO and lightmap bakes: offsets the ray origin
 * along the surface normal by `epsilon` (avoiding self-intersection) and tests
 * against the bake BVH. Reuses a module-level Ray so hot bake loops don't
 * allocate. `near`/`far` keep each caller's intersection bounds.
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
  return rayHitsOccluders(bvh, _occlusionRay, near, far);
}

/**
 * First-hit ray test over the bake BVH. Boolean occlusion never needs the
 * closest hit, so this uses shapecast to stop the traversal at the first
 * triangle intersection instead of raycastFirst's closest-hit search (which
 * has to test every candidate triangle). The node-bound slab test and the
 * triangle test mirror three-mesh-bvh's own near/far and DoubleSide semantics,
 * so the answer matches `raycastFirst(ray, DoubleSide, near, far)`.
 */
function rayHitsOccluders(bvh: MeshBVH, ray: Ray, near: number, far: number): boolean {
  const position = bvh.geometry.getAttribute('position') as BufferAttribute;
  const index = bvh.geometry.index as BufferAttribute | null;
  return bvh.shapecast({
    intersectsBounds: (box) => rayBoxIntersects(ray, box, near, far),
    intersectsRange: (offset, count) => {
      for (let triangle = offset; triangle < offset + count; triangle += 1) {
        let a = triangle * 3;
        let b = a + 1;
        let c = a + 2;
        if (index) {
          a = index.getX(a);
          b = index.getX(b);
          c = index.getX(c);
        }
        _triA.fromBufferAttribute(position, a);
        _triB.fromBufferAttribute(position, b);
        _triC.fromBufferAttribute(position, c);
        // DoubleSide semantics: both faces occlude (backfaceCulling = false).
        if (ray.intersectTriangle(_triA, _triB, _triC, false, _hitPoint) === null) continue;
        const distance = ray.origin.distanceTo(_hitPoint);
        if (distance < near || distance > far) continue;
        return true;
      }
      return false;
    },
  });
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
 * so V is flipped here.
 */
export function rasterizeBake<T extends { uv: [UvPair, UvPair, UvPair] }>(
  width: number,
  height: number,
  triangles: readonly T[],
  writePixel: (px: number, py: number, w0: number, w1: number, w2: number, triangle: T) => void,
): void {
  for (const triangle of triangles) {
    const [uva, uvb, uvc] = triangle.uv;
    const ax = uva[0] * width;
    const ay = (1 - uva[1]) * height;
    const bx = uvb[0] * width;
    const by = (1 - uvb[1]) * height;
    const cx = uvc[0] * width;
    const cy = (1 - uvc[1]) * height;

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (denominator === 0) continue;

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const x = px + 0.5;
        const y = py + 0.5;
        const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        writePixel(px, py, w0, w1, w2, triangle);
      }
    }
  }
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
    pixelOffset: number,
  ) => void,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * channels).fill(255);
  const written = new Uint8Array(width * height);
  rasterizeBake(width, height, triangles, (px, py, w0, w1, w2, triangle) => {
    written[py * width + px] = 1;
    writePixel(pixels, px, py, w0, w1, w2, triangle, (py * width + px) * channels);
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
