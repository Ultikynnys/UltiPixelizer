import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { serializeBakeScene } from '../src/lib/aoRaster';
import { ceilingQuad, flatNormalMap, planeScene } from './helpers/bakeFixtures';
import { installWorkerScope } from './helpers/workerScope';

/** A valid serialized band request backed by a real plane scene. */
function bandRequest(width = 8, height = 8): Record<string, unknown> {
  const scene = planeScene();
  const serialized = serializeBakeScene(collectBakeScene(scene), 4);
  return { ...serialized, type: 'band', jobId: 0, width, height, yStart: 0, yEnd: height };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AO worker', () => {
  it('ignores messages that are not band requests', async () => {
    const scope = installWorkerScope();
    await import('../src/lib/aoWorker.worker.ts');
    scope.listeners[0]({ data: { type: 'progress' } });
    scope.listeners[0]({ data: undefined });
    expect(scope.postMessage).not.toHaveBeenCalled();
  });

  it('rasterizes a band request and posts the result', async () => {
    const scope = installWorkerScope();
    await import('../src/lib/aoWorker.worker.ts');
    scope.listeners[0]({ data: bandRequest() });

    const result = scope.postMessage.mock.calls
      .map((call) => call[0])
      .find((message) => message.type === 'result');
    expect(result).toBeDefined();
    expect(result.factors).toHaveLength(64);
    expect(result.written).toHaveLength(64);
  });

  it('darkens occluded geometry through the worker path with a normal map', async () => {
    const scope = installWorkerScope();
    await import('../src/lib/aoWorker.worker.ts');

    const scene = planeScene();
    // Occluder-only ceiling (no UVs) so it shadows the plane but never bakes itself.
    scene.add(ceilingQuad());

    const flat = flatNormalMap();
    const serialized = serializeBakeScene(collectBakeScene(scene, 2), 16, { map: flat, strength: 1, flipY: false });

    scope.listeners[0]({ data: { ...serialized, type: 'band', jobId: 0, width: 8, height: 8, yStart: 0, yEnd: 8 } });

    const result = scope.postMessage.mock.calls
      .map((call) => call[0] as { type: string })
      .find((message) => message.type === 'result') as { factors: Uint8ClampedArray } | undefined;
    expect(result).toBeDefined();
    let min = 255;
    for (const factor of result!.factors) min = Math.min(min, factor);
    expect(min).toBeLessThan(255);
  });
});
