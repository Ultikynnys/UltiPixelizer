import { afterEach, describe, expect, it, vi } from 'vitest';
import { webgpuUsable } from '../src/lib/gpuCommon';
import { stubNoWebGpu, stubWebGpuAdapter } from './helpers/webgpu';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webgpuUsable', () => {
  it('is false when navigator.gpu is absent', () => {
    stubNoWebGpu();
    expect(webgpuUsable()).toBe(false);
  });

  it('is true when navigator.gpu is present and no request has failed yet', () => {
    stubWebGpuAdapter(vi.fn());
    expect(webgpuUsable()).toBe(true);
  });
});
