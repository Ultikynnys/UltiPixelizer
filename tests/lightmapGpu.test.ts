import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { computeSunVisibilityGpu } from '../src/lib/lightmapGpu';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { serializeBakeScene } from '../src/lib/aoRaster';
import { serializedPlaneScene } from './helpers/bakeFixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('computeSunVisibilityGpu', () => {
  it('rejects scenes without vertices so the caller falls back', async () => {
    vi.stubGlobal('navigator', {});
    const input = serializeBakeScene(collectBakeScene(new Scene(), 2), 4);
    await expect(computeSunVisibilityGpu(input, [0, 0, -1], 1)).rejects.toThrow('no vertices');
  });

  it('rejects when WebGPU is unavailable so the caller falls back', async () => {
    vi.stubGlobal('navigator', {});
    await expect(computeSunVisibilityGpu(serializedPlaneScene(), [0, 0, -1], 1)).rejects.toThrow('WebGPU');
  });

  it('attempts the GPU even when only an adapter is mockable', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    // The mocked adapter yields no device, so the request fails loudly and
    // the caller falls back to the CPU/worker path — like a real GPU miss.
    await expect(computeSunVisibilityGpu(serializedPlaneScene(), [0, 0, -1], 1)).rejects.toThrow('WebGPU adapter unavailable');
    expect(requestAdapter).toHaveBeenCalled();
  });
});
