import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';
import { bakeMeshAO, bakeMeshAOAsync } from '../src/lib/aoBake';

/** A fake `Worker` that captures its handler props so tests can drive the
 * message/error callbacks the production code assigns. */
class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor(_url: URL | string, _options?: unknown) {
    MockWorker.instances.push(this);
  }
}

function planeScene(): Scene {
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
  return scene;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  MockWorker.instances = [];
});

describe('bakeMeshAOAsync', () => {
  it('falls back to a single-threaded bake when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const scene = planeScene();
    const expected = bakeMeshAO(scene, 8, 8, { samples: 4 });
    expect(await bakeMeshAOAsync(scene, 8, 8, { samples: 4 })).toEqual(expected);
  });

  it('rasterizes row bands across workers and assembles the result', async () => {
    vi.stubGlobal('Worker', MockWorker);
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
    vi.stubGlobal('Worker', MockWorker);
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
