import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakeMeshAO, bakeMeshAOAsync } from '../src/lib/aoBake';
import { planeScene } from './helpers/bakeFixtures';
import { installWorkerGlobal, MockWorker } from './helpers/workerScope';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bakeMeshAOAsync', () => {
  it('falls back to a single-threaded bake when workers are unavailable', async () => {
    installWorkerGlobal(false);
    const scene = planeScene();
    const expected = bakeMeshAO(scene, 8, 8, { samples: 4 });
    expect(await bakeMeshAOAsync(scene, 8, 8, { samples: 4 })).toEqual(expected);
  });

  it('rasterizes row bands across workers and assembles the result', async () => {
    installWorkerGlobal();
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    const progress = vi.fn();
    const scene = planeScene();

    const promise = bakeMeshAOAsync(scene, 8, 32, { samples: 4 }, progress);

    const workers = MockWorker.instances;
    expect(workers).toHaveLength(2);
    expect(workers[0].postMessage).toHaveBeenCalledOnce();
    expect(workers[1].postMessage).toHaveBeenCalledOnce();

    workers[0].onmessage!({ data: { type: 'progress', jobId: 0, rowsDone: 8 } });
    expect(progress).toHaveBeenCalledWith(25);

    const band0 = new Uint8ClampedArray(128).fill(200);
    const band1 = new Uint8ClampedArray(128).fill(100);
    workers[0].onmessage!({ data: { type: 'result', jobId: 0, factors: band0, written: new Uint8Array(128).fill(1) } });
    workers[1].onmessage!({ data: { type: 'result', jobId: 1, factors: band1, written: new Uint8Array(128).fill(1) } });

    const result = await promise;
    expect(Array.from(result.slice(0, 128))).toEqual(new Array(128).fill(200));
    expect(Array.from(result.slice(128))).toEqual(new Array(128).fill(100));
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(workers[1].terminate).toHaveBeenCalled();
  });

  it('falls back to the main thread when a worker errors', async () => {
    installWorkerGlobal();
    vi.stubGlobal('navigator', { hardwareConcurrency: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const scene = planeScene();
    const expected = bakeMeshAO(scene, 8, 8, { samples: 4 });

    const promise = bakeMeshAOAsync(scene, 8, 8, { samples: 4 });
    const worker = MockWorker.instances[0];
    expect(worker).toBeDefined();

    worker.onerror!({ message: 'worker exploded' });
    expect(await promise).toEqual(expected);
  });
});
