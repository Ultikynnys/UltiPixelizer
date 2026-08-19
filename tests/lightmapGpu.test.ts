import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';
import { computeSunVisibilityGpu } from '../src/lib/lightmapGpu';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { serializeBakeScene } from '../src/lib/aoRaster';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('computeSunVisibilityGpu', () => {
  it('rejects scenes without vertices so the caller falls back', async () => {
    vi.stubGlobal('navigator', {});
    const scene = new Scene();
    const input = serializeBakeScene(collectBakeScene(scene, 2), 4);
    await expect(computeSunVisibilityGpu(input, [0, 0, -1], 1)).rejects.toThrow('no vertices');
  });

  it('rejects when WebGPU is unavailable so the caller falls back', async () => {
    vi.stubGlobal('navigator', {});
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial()));
    const input = serializeBakeScene(collectBakeScene(scene, 2), 4);
    await expect(computeSunVisibilityGpu(input, [0, 0, -1], 1)).rejects.toThrow('WebGPU');
  });

  it('attempts the GPU even when only an adapter is mockable', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial()));
    const input = serializeBakeScene(collectBakeScene(scene, 2), 4);
    // The mocked adapter yields no device, so the request fails loudly and
    // the caller falls back to the CPU/worker path — like a real GPU miss.
    await expect(computeSunVisibilityGpu(input, [0, 0, -1], 1)).rejects.toThrow('WebGPU adapter unavailable');
    expect(requestAdapter).toHaveBeenCalled();
  });
});
