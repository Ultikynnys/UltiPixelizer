import type { Object3D } from 'three';
import { collectBakeScene, type BakeScene } from './bakeGeometry';

/**
 * Cache for collected bake scenes. `collectBakeScene` walks the whole model
 * (world transforms, per-corner dedup, BVH build) and costs hundreds of
 * milliseconds on 60k-tri models  but its result is a pure function of the
 * scene's *geometry*, which only changes when the model is imported/closed,
 * the UV channel or LOD level changes, or the world axis rotates. Lightmap
 * and AO bakes re-run on every sun/ambient/normal-map change, so caching the
 * collected scene turns those re-bakes from ~600ms into a lookup.
 *
 * The cache is keyed by scene identity AND the occlusion `distance` (which
 * drives epsilon/maxDistance/radius). Callers must call
 * `invalidateBakeSceneCache()` after mutating a scene in place (UV channel
 * swaps, LOD visibility, world-axis rotation)  the identity key cannot
 * detect those.
 *
 * Note: skinned/morph animation never reaches these cached world positions 
 * three.js skinning and morphs run on the GPU, leaving the CPU-side position
 * attribute untouched.
 */
const cache = new Map<Object3D, Map<number, BakeScene>>();

export function getBakeScene(scene: Object3D | null, distance = 2): BakeScene | null {
  if (!scene) return null;
  let byDistance = cache.get(scene);
  if (!byDistance) {
    byDistance = new Map();
    cache.set(scene, byDistance);
  }
  let bakeScene = byDistance.get(distance);
  if (!bakeScene) {
    bakeScene = collectBakeScene(scene, distance);
    byDistance.set(distance, bakeScene);
  }
  return bakeScene;
}

/** Drops every cached bake scene  call after any in-place scene mutation
 * (UV channel, LOD visibility, world-axis rotation) or model close. */
export function invalidateBakeSceneCache(): void {
  cache.clear();
}
