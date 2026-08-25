import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { serializeBakeScene } from '../src/lib/aoRaster';
import { bakeMeshLightmap } from '../src/lib/lightmapBake';
import type { NormalMapSource } from '../src/lib/normal';
import { installWorkerScope } from './helpers/workerScope';
import { planeScene } from './helpers/bakeFixtures';

/** 2×2 map that perturbs every texel to tangent-space +X (sx = 1, sz = 0). */
const xNormalMap: NormalMapSource = {
  data: new Uint8ClampedArray([
    255, 128, 255, 255, 255, 128, 255, 255,
    255, 128, 255, 255, 255, 128, 255, 255,
  ]),
  width: 2,
  height: 2,
};

/** A valid serialized bake request backed by a real plane scene, with the
 * same shape bakeLightmapAsync posts to the worker. */
function bakeRequest(): Record<string, unknown> {
  const scene = planeScene();
  const serialized = serializeBakeScene(collectBakeScene(scene), 2, { map: xNormalMap, strength: 1, flipY: false });
  return {
    ...serialized,
    type: 'bake',
    jobId: 1,
    width: 8,
    height: 8,
    options: {
      sunDirection: [0, 0, -1],
      sunColor: [1, 1, 1],
      sunIntensity: 1,
      ambientColor: [0, 0, 0],
      ambientIntensity: 0,
    },
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lightmap worker', () => {
  it('rasterizes a bake request and posts the result', async () => {
    const scope = installWorkerScope();
    await import('../src/lib/lightmapWorker.worker.ts');
    scope.listeners[0]({ data: bakeRequest() });

    const result = scope.postMessage.mock.calls
      .map((call) => call[0])
      .find((message) => message.type === 'result');
    expect(result).toBeDefined();
    expect(result.pixels).toHaveLength(8 * 8 * 4);
  });

  it('consumes the cached tangent bases with the transferred normal map', async () => {
    const scope = installWorkerScope();
    await import('../src/lib/lightmapWorker.worker.ts');
    scope.listeners[0]({ data: bakeRequest() });

    const result = scope.postMessage.mock.calls
      .map((call) => call[0])
      .find((message) => message.type === 'result');
    // The worker raster must match the sync bake byte-for-byte  both read
    // the same collected tangent bases, so the +X perturbation lands identically.
    const scene = planeScene();
    const expected = bakeMeshLightmap(scene, 8, 8, {
      sunDirection: { x: 0, y: 0, z: -1 },
      sunColor: '#ffffff',
      sunIntensity: 1,
      ambientColor: '#000000',
      ambientIntensity: 0,
      normalMap: xNormalMap,
      normalStrength: 1,
      normalFlipY: false,
    });
    expect(result.pixels).toEqual(expected);
    // The +X normals point perpendicular to the downward sun, so the baked
    // map must be dimmer than the unperturbed face  proving the map actually
    // traveled to the worker and reoriented the shading.
    const lit = bakeMeshLightmap(scene, 8, 8, {
      sunDirection: { x: 0, y: 0, z: -1 },
      sunColor: '#ffffff',
      sunIntensity: 1,
      ambientColor: '#000000',
      ambientIntensity: 0,
    });
    expect([...result.pixels].some((byte, i) => i % 4 === 0 && byte < lit[i * 4]))
      .toBe(true);
  });
});
