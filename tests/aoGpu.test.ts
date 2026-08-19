import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakeAOWithGpu } from '../src/lib/aoGpu';
import { serializedPlaneScene } from './helpers/bakeFixtures';
import { stubNoWebGpu, stubWebGpuAdapter } from './helpers/webgpu';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bakeAOWithGpu', () => {
  it('rejects when navigator.gpu is absent so the caller falls back', async () => {
    stubNoWebGpu();
    await expect(bakeAOWithGpu(serializedPlaneScene(), 64, 64)).rejects.toThrow('WebGPU');
  });

  it('attempts the GPU even for tiny maps (no size threshold)', async () => {
    const requestAdapter = vi.fn();
    stubWebGpuAdapter(requestAdapter);
    // The 8×8 map is far below the old threshold: the device request must
    // still fire (the mock adapter then fails with "adapter unavailable").
    await expect(bakeAOWithGpu(serializedPlaneScene(), 8, 8)).rejects.toThrow('WebGPU adapter unavailable');
    expect(requestAdapter).toHaveBeenCalled();
  });
});
