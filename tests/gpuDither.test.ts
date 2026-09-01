import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processImageData } from '../src/lib/dither';
import { ditherImageDataGpu, gpuDitherCovers, processImageDataAsync } from '../src/lib/gpuDither';
import { FakeImageData, installDomStubs } from './helpers/domStubs';
import { stubNoWebGpu, stubWebGpuAdapter } from './helpers/webgpu';

beforeEach(() => {
  installDomStubs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function imageData(pixels: number[][], width: number): ImageData {
  return new FakeImageData(new Uint8ClampedArray(pixels.flat()), width, pixels.length / width) as ImageData;
}

const options = (mode: 'floyd' | 'atkinson' | 'ordered') => ({
  palette: ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffffff', '#808080', '#ff8800', '#00ffff'],
  mode,
  strength: 1,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  stripeAngle: 45,
  seed: 1,
});

const source = (): ImageData => imageData([
  [10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255], [100, 110, 120, 255],
  [130, 140, 150, 255], [160, 170, 180, 255], [190, 200, 210, 255], [220, 230, 240, 255],
  [15, 25, 35, 255], [45, 55, 65, 255], [75, 85, 95, 255], [105, 115, 125, 255],
], 4);

describe('gpuDitherCovers', () => {
  it('covers only the seamless error-diffusion modes', () => {
    expect(gpuDitherCovers('floyd')).toBe(true);
    expect(gpuDitherCovers('atkinson')).toBe(true);
    expect(gpuDitherCovers('ordered')).toBe(false);
    expect(gpuDitherCovers('halftone')).toBe(false);
    expect(gpuDitherCovers('none')).toBe(false);
  });
});

describe('ditherImageDataGpu', () => {
  it('rejects when navigator.gpu is absent so the caller falls back', async () => {
    stubNoWebGpu();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ditherImageDataGpu(source(), options('floyd'))).rejects.toThrow('WebGPU');
  });

  it('fires the device request then fails loudly when the adapter yields no device', async () => {
    const requestAdapter = vi.fn().mockResolvedValue(null);
    stubWebGpuAdapter(requestAdapter);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ditherImageDataGpu(source(), options('floyd'))).rejects.toThrow('WebGPU adapter unavailable');
    expect(requestAdapter).toHaveBeenCalled();
  });
});

describe('processImageDataAsync', () => {
  it('returns the exact CPU bytes when WebGPU is absent (floyd)', async () => {
    stubNoWebGpu();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = options('floyd');
    const gpu = await processImageDataAsync(source(), opts);
    const cpu = processImageData(source(), opts);
    expect(gpu.data).toEqual(cpu.data);
    expect(gpu.width).toBe(4);
    expect(gpu.height).toBe(3);
  });

  it('falls back to the exact CPU bytes when the adapter rejects (atkinson)', async () => {
    stubWebGpuAdapter(vi.fn().mockResolvedValue(null));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = options('atkinson');
    const gpu = await processImageDataAsync(source(), opts);
    const cpu = processImageData(source(), opts);
    expect(gpu.data).toEqual(cpu.data);
  });

  it('keeps non-seamless modes on the CPU path without touching the GPU', async () => {
    const requestAdapter = vi.fn();
    stubWebGpuAdapter(requestAdapter);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = options('ordered');
    const gpu = await processImageDataAsync(source(), opts);
    const cpu = processImageData(source(), opts);
    expect(gpu.data).toEqual(cpu.data);
    expect(requestAdapter).not.toHaveBeenCalled();
  });
});
