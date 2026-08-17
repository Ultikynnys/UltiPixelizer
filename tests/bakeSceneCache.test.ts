import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { getBakeScene, invalidateBakeSceneCache } from '../src/lib/bakeSceneCache';
import { bakeMeshLightmap } from '../src/lib/lightmapBake';

function triangleScene(): Object3D {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  const scene = new Object3D();
  scene.add(new Mesh(geometry, new MeshBasicMaterial()));
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

  it('lets a cached scene drive an identical lightmap bake', () => {
    const scene = triangleScene();
    const fresh = bakeMeshLightmap(scene, 8, 8, lightOptions);
    const cached = getBakeScene(scene, 2);
    const viaCache = bakeMeshLightmap(scene, 8, 8, lightOptions, cached ?? undefined);
    expect(viaCache).toEqual(fresh);
  });
});
