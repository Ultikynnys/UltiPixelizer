import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, PlaneGeometry, Scene, Vector3 } from 'three';
import { buildLinearBVH, type LinearBVH } from '../src/lib/aoBvh';
import { castBakeRay, collectBakeScene } from '../src/lib/bakeGeometry';
import { symmetricHemisphereKernel } from '../src/lib/aoRaster';

/** A horizontal tessellated plane at z = 0.5 that acts purely as an occluder. */
function occluderScene(): Scene {
  const scene = new Scene();
  const plane = new Mesh(new PlaneGeometry(4, 4, 3, 3), new MeshBasicMaterial());
  plane.position.z = 0.5;
  scene.add(plane);
  return scene;
}

/** Sorts 9-float triangle groups lexicographically so two buffers can be
 * compared as permutations of the same triangles. */
function sortedTriangleGroups(data: Float32Array): Float32Array {
  const groups: Float32Array[] = [];
  for (let i = 0; i < data.length; i += 9) groups.push(data.slice(i, i + 9));
  groups.sort((a, b) => {
    for (let k = 0; k < 9; k += 1) {
      if (a[k] !== b[k]) return a[k] - b[k];
    }
    return 0;
  });
  const out = new Float32Array(data.length);
  groups.forEach((group, index) => out.set(group, index * 9));
  return out;
}

// Reference traversal mirroring the WGSL shader (doubles instead of f32), used
// to validate the flat BVH build against three-mesh-bvh's castBakeRay.
function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross3(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function slabHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, bmin: number[], bmax: number[], maxDist: number): boolean {
  let tNear = 0;
  let tFar = maxDist;
  const axes: Array<[number, number, number, number]> = [
    [dx, ox, bmin[0], bmax[0]],
    [dy, oy, bmin[1], bmax[1]],
    [dz, oz, bmin[2], bmax[2]],
  ];
  for (const [d, o, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return false;
    } else {
      const inv = 1 / d;
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tNear) tNear = t1;
      if (t2 < tFar) tFar = t2;
      if (tNear > tFar) return false;
    }
  }
  return true;
}

function mtHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, v0: number[], v1: number[], v2: number[], maxDist: number): boolean {
  const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  const d = [dx, dy, dz];
  const h = cross3(d, e2);
  const a = dot3(e1, h);
  if (Math.abs(a) < 1e-9) return false;
  const f = 1 / a;
  const s = [ox - v0[0], oy - v0[1], oz - v0[2]];
  const u = f * dot3(s, h);
  if (u < 0 || u > 1) return false;
  const q = cross3(s, e1);
  const v = f * dot3(d, q);
  if (v < 0 || u + v > 1) return false;
  const t = f * dot3(e2, q);
  return t >= 0 && t <= maxDist;
}

function traceRay(bvh: LinearBVH, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): boolean {
  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop() as number;
    const base = node * 6;
    const bmin = [bvh.bounds[base], bvh.bounds[base + 1], bvh.bounds[base + 2]];
    const bmax = [bvh.bounds[base + 3], bvh.bounds[base + 4], bvh.bounds[base + 5]];
    if (!slabHit(ox, oy, oz, dx, dy, dz, bmin, bmax, maxDist)) continue;
    const linkBase = node * 2;
    const leftFirst = bvh.links[linkBase];
    const count = bvh.links[linkBase + 1];
    if (count === 0) {
      stack.push(leftFirst, node + 1); // pop order: left child first (DFS)
    } else {
      for (let i = 0; i < count; i += 1) {
        const tb = (leftFirst + i) * 9;
        const v0 = [bvh.triangles[tb], bvh.triangles[tb + 1], bvh.triangles[tb + 2]];
        const v1 = [bvh.triangles[tb + 3], bvh.triangles[tb + 4], bvh.triangles[tb + 5]];
        const v2 = [bvh.triangles[tb + 6], bvh.triangles[tb + 7], bvh.triangles[tb + 8]];
        if (mtHit(ox, oy, oz, dx, dy, dz, v0, v1, v2, maxDist)) return true;
      }
    }
  }
  return false;
}

describe('buildLinearBVH', () => {
  it('builds a structurally valid flat BVH covering every triangle', () => {
    const bakeScene = collectBakeScene(occluderScene(), 2);
    const positions = bakeScene.occluderPositions;
    const triangleCount = positions.length / 9;
    const bvh = buildLinearBVH(positions);

    expect(bvh.nodeCount).toBeGreaterThanOrEqual(1);
    expect(bvh.bounds.length).toBe(bvh.nodeCount * 6);
    expect(bvh.links.length).toBe(bvh.nodeCount * 2);
    expect(bvh.triangles.length).toBe(triangleCount * 9);

    let leafTriCount = 0;
    for (let node = 0; node < bvh.nodeCount; node += 1) {
      const leftFirst = bvh.links[node * 2];
      const count = bvh.links[node * 2 + 1];
      if (count === 0) {
        expect(node + 1).toBeLessThan(bvh.nodeCount);
        expect(leftFirst).toBeLessThan(bvh.nodeCount);
      } else {
        expect(count).toBeGreaterThan(0);
        expect(leftFirst + count).toBeLessThanOrEqual(triangleCount);
        leafTriCount += count;
      }
    }
    expect(leafTriCount).toBe(triangleCount);
    // The reordered triangles are exactly a permutation of the input.
    expect(sortedTriangleGroups(bvh.triangles)).toEqual(sortedTriangleGroups(positions));
  });

  it('returns an empty BVH for an empty input', () => {
    const bvh = buildLinearBVH(new Float32Array(0));
    expect(bvh.nodeCount).toBe(0);
    expect(bvh.bounds.length).toBe(0);
    expect(bvh.links.length).toBe(0);
    expect(bvh.triangles.length).toBe(0);
  });

  it('traverses to the same hits as castBakeRay', () => {
    const bakeScene = collectBakeScene(occluderScene(), 2);
    const bvh = bakeScene.bvh!;
    const flat = buildLinearBVH(bakeScene.occluderPositions);
    const kernel = symmetricHemisphereKernel(32);
    const normal = new Vector3(0, 0, 1);

    let comparisons = 0;
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        const position = new Vector3(-1.2 + i * 0.6, -1.2 + j * 0.6, 0);
        for (let s = 0; s < kernel.length; s += 3) {
          const dir = new Vector3(kernel[s], kernel[s + 1], kernel[s + 2]);
          const cpuHit = castBakeRay(bvh, position, normal, dir, bakeScene.epsilon, 0, bakeScene.maxDistance);
          const origin = position.clone().addScaledVector(normal, bakeScene.epsilon);
          const gpuHit = traceRay(flat, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, bakeScene.maxDistance);
          expect(gpuHit).toBe(cpuHit);
          comparisons += 1;
        }
      }
    }
    expect(comparisons).toBeGreaterThan(0);
  });
});
