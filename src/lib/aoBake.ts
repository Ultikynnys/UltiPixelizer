import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Matrix3,
  Mesh,
  Object3D,
  Ray,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export type BakeAOMLOptions = {
  /** Hemisphere samples per vertex. Higher = smoother, slower. */
  samples?: number;
  /** Occlusion reach as a multiple of the mesh bounding-sphere radius. Default 2. */
  distance?: number;
  /** Random source for sample directions (inject a seeded PRNG for tests). */
  random?: () => number;
};

type UvPair = [number, number];
type UniqueVertex = { position: Vector3; normal: Vector3; ao: number };
type BakeTriangle = { uv: [UvPair, UvPair, UvPair]; verts: [number, number, number] };

const _ray = new Ray();
const _direction = new Vector3();

function stratifiedHemisphereKernel(samples: number, random: () => number): Vector3[] {
  const side = Math.ceil(Math.sqrt(samples));
  return Array.from({ length: samples }, (_, index) => {
    const u = ((index % side) + random()) / side;
    const v = (Math.floor(index / side) + random()) / side;
    const cosTheta = Math.sqrt(Math.max(u, 1e-6));
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const phi = 2 * Math.PI * v;
    return new Vector3(sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta);
  });
}

function orthonormalBasis(normal: Vector3): [Vector3, Vector3] {
  const reference = Math.abs(normal.z) < 0.999 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
  const tangent = new Vector3().crossVectors(normal, reference).normalize();
  const bitangent = new Vector3().crossVectors(normal, tangent).normalize();
  return [tangent, bitangent];
}

/**
 * Bakes per-vertex ambient occlusion from a mesh into a `width × height`
 * grayscale factor map (255 = unoccluded/bright, 0 = occluded/dark), sampled at
 * the mesh's UV coordinates so it aligns with the dithered texture.
 *
 * Every mesh contributes to occlusion; only meshes that carry both a `uv` and a
 * `normal` attribute are baked. May call `computeVertexNormals` on geometries
 * missing normals, so pass a disposable scene (a clone) if you need to keep the
 * original untouched.
 */
export function bakeMeshAO(scene: Object3D, width: number, height: number, options: BakeAOMLOptions = {}): Uint8ClampedArray {
  const samples = Math.max(1, Math.floor(options.samples ?? 24));
  const random = options.random ?? Math.random;
  const sampleKernel = stratifiedHemisphereKernel(samples, random);

  scene.updateMatrixWorld(true);

  const worldPositions: number[] = [];
  const bakeTriangles: BakeTriangle[] = [];
  const uniqueVertices: UniqueVertex[] = [];
  const vertexIndexByKey = new Map<string, number>();
  const normalMatrix = new Matrix3();

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
    const v = new Vector3();
    const n = new Vector3();

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
            resolved = uniqueVertices.length;
            uniqueVertices.push({ position: v.clone(), normal: n.clone(), ao: 1 });
            vertexIndexByKey.set(key, resolved);
          }
          return resolved;
        }) as [number, number, number];
        bakeTriangles.push({
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
  const maxDistance = radius * (options.distance ?? 2);
  const epsilon = Math.max(radius * 1e-3, 1e-4);

  const bvh = worldPositions.length ? new MeshBVH(occluder) : null;

  for (const vertex of uniqueVertices) {
    if (!bvh) break;
    const [tangent, bitangent] = orthonormalBasis(vertex.normal);
    let occluded = 0;
    for (const sample of sampleKernel) {
      _direction.set(0, 0, 0)
        .addScaledVector(tangent, sample.x)
        .addScaledVector(bitangent, sample.y)
        .addScaledVector(vertex.normal, sample.z)
        .normalize();
      _ray.origin.copy(vertex.position).addScaledVector(vertex.normal, epsilon);
      _ray.direction.copy(_direction);
      if (bvh.raycastFirst(_ray, DoubleSide, 0, maxDistance)) occluded += 1;
    }
    vertex.ao = (samples - occluded) / samples;
  }

  const factors = new Uint8ClampedArray(width * height).fill(255);
  for (const tri of bakeTriangles) {
    const [uva, uvb, uvc] = tri.uv;
    const aoa = uniqueVertices[tri.verts[0]].ao;
    const aob = uniqueVertices[tri.verts[1]].ao;
    const aoc = uniqueVertices[tri.verts[2]].ao;

    // UV (0,0) is the texture bottom-left; the canvas is top-left, so flip V.
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
        factors[py * width + px] = Math.round((w0 * aoa + w1 * aob + w2 * aoc) * 255);
      }
    }
  }

  return factors;
}
