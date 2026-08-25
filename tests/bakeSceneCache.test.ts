import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { getBakeScene, invalidateBakeSceneCache } from '../src/lib/bakeSceneCache';
import { bakeMeshLightmap } from '../src/lib/lightmapBake';
import { getFallbackQuadScene } from '../src/lib/modelScene';
import { uvTriangle } from './helpers/bakeFixtures';

function triangleScene(): Object3D {
  const scene = new Object3D();
  scene.add(uvTriangle());
  return scene;
}

const lightOptions = {
  sunDirection: { x: -0.5, y: -Math.SQRT1_2, z: -0.5 },
  sunColor: '#ffffff',
  sunIntensity: 1,
  ambientColor: '#ffffff',
  ambientIntensity: 0.4,
};

describe('bakeSceneCache', () => {
  it('reuses the collected scene across calls with the same scene and distance', () => {
    const scene = triangleScene();
    const first = getBakeScene(scene, 2);
    expect(getBakeScene(scene, 2)).toBe(first);
    expect(getBakeScene(scene)).toBe(first); // default distance is 2
    // The per-triangle tangent bases live on the collected scene, so re-bakes
    // share the exact same array  the map's geometric mapping is prepared
    // once, never recomputed per bake.
    expect(first!.tangentBases).not.toBeNull();
    expect(getBakeScene(scene, 2)!.tangentBases).toBe(first!.tangentBases);
  });

  it('keyed by scene identity and distance', () => {
    const sceneA = triangleScene();
    const sceneB = triangleScene();
    const a = getBakeScene(sceneA, 2);
    const b = getBakeScene(sceneB, 2);
    expect(b).not.toBe(a);
    // A different distance recomputes even for the same scene.
    const far = getBakeScene(sceneA, 4)!;
    expect(far).not.toBe(a);
    expect(far.maxDistance).toBeCloseTo(far.radius * 4);
    // And the cached distance-2 result is untouched.
    expect(getBakeScene(sceneA, 2)).toBe(a);
  });

  it('matches a fresh collectBakeScene and survives invalidation', () => {
    const scene = triangleScene();
    const cached = getBakeScene(scene, 2);
    expect(cached?.vertices).toHaveLength(3);
    expect(cached?.triangles).toHaveLength(1);
    const fresh = collectBakeScene(scene, 2);
    expect(cached?.vertices).toEqual(fresh.vertices);
    expect(cached?.triangles).toEqual(fresh.triangles);

    invalidateBakeSceneCache();
    expect(getBakeScene(scene, 2)).not.toBe(cached);
  });

  it('returns null for a null scene', () => {
    expect(getBakeScene(null)).toBeNull();
  });

  it('hits when the memoized fallback quad is revisited', () => {
    // getFallbackQuadScene returns the SAME scene instance for a previously
    // visited (tessellation, grid), so the collected bake scene is reused
    // without re-walking the tessellated mesh.
    const first = getBakeScene(getFallbackQuadScene(4, false), 2);
    expect(getBakeScene(getFallbackQuadScene(4, false), 2)).toBe(first);
    // And it still responds to an explicit invalidation.
    invalidateBakeSceneCache();
    expect(getBakeScene(getFallbackQuadScene(4, false), 2)).not.toBe(first);
  });

  it('lets a cached scene drive an identical lightmap bake', () => {
    const scene = triangleScene();
    const fresh = bakeMeshLightmap(scene, 8, 8, lightOptions);
    const cached = getBakeScene(scene, 2);
    const viaCache = bakeMeshLightmap(scene, 8, 8, lightOptions, cached ?? undefined);
    expect(viaCache).toEqual(fresh);
  });
});
