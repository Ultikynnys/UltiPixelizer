import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Scene } from 'three';
import { expect } from 'vitest';
import { collectBakeScene } from '../../src/lib/bakeGeometry';
import { serializeBakeScene, type SerializedBakeScene } from '../../src/lib/aoRaster';
import { createFallbackQuadScene } from '../../src/lib/modelScene';
import type { NormalMapSource } from '../../src/lib/normal';

/** Scene with a single 1×1 plane at the origin. */
export function planeScene(): Scene {
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
  return scene;
}

/** Serialized bake scene for a plain plane  the shared fixture for the GPU
 * and worker raster tests. */
export function serializedPlaneScene(samples = 4, distance = 2): SerializedBakeScene {
  return serializeBakeScene(collectBakeScene(planeScene(), distance), samples);
}

/** Occluder-only ceiling quad (no UVs) at z = 0.5 spanning ±`half`, so it
 * occludes bake surfaces but is never baked itself. `mirror` clips the quad
 * to the positive-x half when set to 1 (or negative-x when -1); 0 (default)
 * keeps the full ±`half` span  the mirrored half-quad form the AO mirror
 * tests bake. */
export function ceilingQuad(half = 2, mirror: -1 | 0 | 1 = 0): Mesh {
  const x0 = mirror === 0 ? -half : 0;
  const x1 = mirror === 0 ? half : half * mirror;
  const ceiling = new BufferGeometry();
  ceiling.setAttribute('position', new Float32BufferAttribute([
    x0, -half, 0.5,  x1, -half, 0.5,  x1, half, 0.5,
    x0, -half, 0.5,  x1, half, 0.5,  x0, half, 0.5,
  ], 3));
  return new Mesh(ceiling, new MeshBasicMaterial());
}

/** Single-triangle UV island covering UV 0.4..0.6. */
export function uvIsland(): BufferGeometry {
  const island = new BufferGeometry();
  island.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  island.setAttribute('uv', new Float32BufferAttribute([0.4, 0.4, 0.6, 0.4, 0.4, 0.6], 2));
  return island;
}

/** A unit triangle whose UVs match its local XY (uv (0,0),(1,0),(0,1))  the
 * shared fixture for cache/raster tests that need one full-UV triangle. */
export function uvTriangle(): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  return new Mesh(geometry, new MeshBasicMaterial());
}

/** The 3×3 fallback grid with the +Z neighbor raised to y = 0.6  the
 * displacement scenario shared by the AO and lightmap bake tests. */
export function raisedNeighborScene(): Object3D {
  const scene = createFallbackQuadScene(4, true);
  const neighbor = scene.children.find((child) => child.position.x === 0 && child.position.z === 1) as Mesh;
  neighbor.position.y = 0.6;
  return scene;
}

/** 1×1 flat-blue normal map (tangent-space +Z). */
export function flatNormalMap(): NormalMapSource {
  return { data: new Uint8ClampedArray([128, 128, 255, 255]), width: 1, height: 1 };
}

/** Asserts the shared fallback-quad contract: a flat +Y-facing quad whose UVs
 * span the whole 0..1 unit square, so a bake covers the full texture rather
 * than a corner island. Shared by the factory test (modelScene) and the bake
 * wiring test (bake.ts) so the two layers can't drift apart. */
export function expectFallbackQuad(scene: Object3D | Mesh): void {
  const quad = scene as Mesh;
  const normals = quad.geometry.getAttribute('normal');
  for (let i = 0; i < normals.count; i += 1) {
    expect(normals.getX(i)).toBeCloseTo(0);
    expect(normals.getY(i)).toBeCloseTo(1);
    expect(normals.getZ(i)).toBeCloseTo(0);
  }
  const uv = quad.geometry.getAttribute('uv');
  let minU = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < uv.count; i += 1) {
    minU = Math.min(minU, uv.getX(i));
    maxU = Math.max(maxU, uv.getX(i));
    minV = Math.min(minV, uv.getY(i));
    maxV = Math.max(maxV, uv.getY(i));
  }
  expect(minU).toBe(0);
  expect(maxU).toBe(1);
  expect(minV).toBe(0);
  expect(maxV).toBe(1);
}
