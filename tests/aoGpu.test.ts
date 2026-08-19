import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';
import { bakeAOWithGpu } from '../src/lib/aoGpu';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { serializeBakeScene } from '../src/lib/aoRaster';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bakeAOWithGpu', () => {
  it('rejects when navigator.gpu is absent so the caller falls back', async () => {
    vi.stubGlobal('navigator', {});
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial()));
    const input = serializeBakeScene(collectBakeScene(scene, 2), 4);
    await expect(bakeAOWithGpu(input, 64, 64)).rejects.toThrow('WebGPU');
  });

  it('attempts the GPU even for tiny maps (no size threshold)', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial()));
    const input = serializeBakeScene(collectBakeScene(scene, 2), 4);
    // The 8×8 map is far below the old threshold: the device request must
    // still fire (the mock adapter then fails with "adapter unavailable").
    await expect(bakeAOWithGpu(input, 8, 8)).rejects.toThrow('WebGPU adapter unavailable');
    expect(requestAdapter).toHaveBeenCalled();
  });
});
