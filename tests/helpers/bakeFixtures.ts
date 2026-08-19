import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Scene } from 'three';
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

/** Serialized bake scene for a plain plane — the shared fixture for the GPU
 * and worker raster tests. */
export function serializedPlaneScene(samples = 4, distance = 2): SerializedBakeScene {
  return serializeBakeScene(collectBakeScene(planeScene(), distance), samples);
}

/** Occluder-only ceiling quad (no UVs) at z = 0.5 spanning ±`half`, so it
 * occludes bake surfaces but is never baked itself. */
export function ceilingQuad(half = 2): Mesh {
  const ceiling = new BufferGeometry();
  ceiling.setAttribute('position', new Float32BufferAttribute([
    -half, -half, 0.5,  half, -half, 0.5,  half, half, 0.5,
    -half, -half, 0.5,  half, half, 0.5,  -half, half, 0.5,
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

/** The 3×3 fallback grid with the +Z neighbor raised to y = 0.6 — the
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
