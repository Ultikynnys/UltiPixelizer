import {
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Mesh,
  Object3D,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';

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
};

/**
 * Walks the scene and collects everything a UV-space bake needs:
 * world-space occluder positions, deduplicated per-vertex samples (position +
 * normal), bake triangles, and a BVH over the occluders.
 *
 * Every mesh contributes to occlusion; only meshes that carry both a `uv` and a
 * `normal` attribute are baked. May call `computeVertexNormals` on geometries
 * missing normals, so pass a disposable scene (a clone) if you need to keep the
 * original untouched.
 */
export function collectBakeScene(scene: Object3D, distance = 2): BakeScene {
  scene.updateMatrixWorld(true);

  const worldPositions: number[] = [];
  const vertices: BakeVertex[] = [];
  const triangles: BakeTriangle[] = [];
  const vertexIndexByKey = new Map<string, number>();
  const normalMatrix = new Matrix3();
  const v = new Vector3();
  const n = new Vector3();

  scene.traverse((child) => {
    if (!(child instanceof Mesh) || !child.visible) return;
    const geometry = child.geometry as BufferGeometry;
    const position = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!position) return;

    const uv = geometry.getAttribute('uv') as BufferAttribute | undefined;
    let normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
    if (uv && !normal) {
      geometry.computeVertexNormals();
      normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
    }

    const world = child.matrixWorld;
    normalMatrix.getNormalMatrix(world);
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;

    for (let tri = 0; tri < triangleCount; tri += 1) {
      const ia = index ? index.getX(tri * 3) : tri * 3;
      const ib = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
      const ic = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;

      // Occluder triangles (world space) — every mesh contributes.
      for (const vi of [ia, ib, ic]) {
        v.fromBufferAttribute(position, vi).applyMatrix4(world);
        worldPositions.push(v.x, v.y, v.z);
      }

      // Bakeable surface — needs UVs and normals.
      if (uv && normal) {
        const verts: [number, number, number] = [ia, ib, ic].map((vi) => {
          v.fromBufferAttribute(position, vi).applyMatrix4(world);
          n.fromBufferAttribute(normal, vi).applyMatrix3(normalMatrix).normalize();
          const key = [v.x, v.y, v.z, n.x, n.y, n.z].map((value) => value.toFixed(6)).join(',');
          let resolved = vertexIndexByKey.get(key);
          if (resolved === undefined) {
            resolved = vertices.length;
            vertices.push({ position: v.clone(), normal: n.clone() });
            vertexIndexByKey.set(key, resolved);
          }
          return resolved;
        }) as [number, number, number];
        triangles.push({
          uv: [[uv.getX(ia), uv.getY(ia)], [uv.getX(ib), uv.getY(ib)], [uv.getX(ic), uv.getY(ic)]],
          verts,
        });
      }
    }
  });

  const occluder = new BufferGeometry();
  occluder.setAttribute('position', new BufferAttribute(new Float32Array(worldPositions), 3));
  occluder.computeBoundingSphere();
  const radius = occluder.boundingSphere?.radius ?? 1;
  const maxDistance = radius * distance;
  const epsilon = Math.max(radius * 1e-3, 1e-4);
  const bvh = worldPositions.length ? new MeshBVH(occluder) : null;

  return { vertices, triangles, bvh, epsilon, radius, maxDistance };
}

/**
 * Rasterizes bake triangles into a `width × height` grid, invoking `writePixel`
 * with the barycentric weights for every covered pixel. UV (0,0) is the texture
 * bottom-left; the canvas is top-left, so V is flipped here.
 */
export function rasterizeBake(
  width: number,
  height: number,
  triangles: BakeTriangle[],
  writePixel: (px: number, py: number, w0: number, w1: number, w2: number, triangle: BakeTriangle) => void,
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
