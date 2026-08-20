import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, bench, describe } from 'vitest';
import { processImageData, type ProcessOptions } from '../src/lib/dither';
import { initDitherWasm } from '../src/lib/wasmLinearMatch';
import { FakeImageData, installDomStubs } from './helpers/domStubs';

/**
 * Wall-time benchmark for the seamless error-diffusion dither (the path the GPU
 * used to accelerate). Run with `npm run bench`. When the wasm palette scan is
 * built (`npm run build:wasm`), the dither routes through it; otherwise it
 * falls back to the JS linear scan, so running this before and after building
 * the wasm measures the actual speedup on this machine.
 *
 * The module is loaded from disk (bytes) like the parity test: node cannot
 * `fetch` the `?url` asset, so a bare `initDitherWasm()` would latch a load
 * failure here and silently benchmark the JS scan, the exact silent fallback
 * the bench exists to measure. When the artifact is missing the load throws
 * and the bench measures the JS path, which is the point of running it before
 * and after `npm run build:wasm`.
 */

beforeAll(async () => {
  installDomStubs();
  try {
    const buf = readFileSync(fileURLToPath(new URL('../src/wasm/dither.wasm', import.meta.url)));
    await initDitherWasm(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  } catch {
    // artifact not built — bench measures the JS linear scan.
  }
});

function synthetic(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 7) & 255;
    data[i + 1] = (i * 13) & 255;
    data[i + 2] = (i * 29) & 255;
    data[i + 3] = 255;
  }
  return new FakeImageData(data, width, height) as ImageData;
}

function paletteOf(count: number): string[] {
  const colors: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const value = (i * 0x010101) & 0xffffff;
    colors.push(`#${value.toString(16).padStart(6, '0')}`);
  }
  return colors;
}

const options = (mode: 'floyd' | 'atkinson'): ProcessOptions => ({
  palette: paletteOf(256),
  mode,
  strength: 1,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  stripeAngle: 45,
  noiseScale: 1,
  seed: 1,
  halftoneScale: 1,
});

describe('seamless error-diffusion dither (256-color palette)', () => {
  bench('floyd 256x256', () => {
    processImageData(synthetic(256, 256), options('floyd'));
  });

  bench('atkinson 256x256', () => {
    processImageData(synthetic(256, 256), options('atkinson'));
  });
});
