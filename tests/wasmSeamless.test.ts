import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { processImageData, type ProcessOptions } from '../src/lib/dither';
import { initDitherWasm } from '../src/lib/wasmLinearMatch';
import { FakeImageData, installDomStubs } from './helpers/domStubs';

/**
 * Byte-identity between the wasm full-loop seamless dither (src-wasm
 * `dither_seamless`) and the JS streaming scan. Order matters: the JS
 * reference outputs are computed BEFORE the module loads, because once the
 * instance is set, processImageData routes seamless modes through the wasm
 * loop. When the artifact is absent (never built) the comparison skips,
 * mirroring the scan-parity test in wasmLinearMatch.test.ts.
 */

function rampPalette(count: number): string[] {
  const colors: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const value = (i * 0x010101) & 0xffffff;
    colors.push(`#${value.toString(16).padStart(6, '0')}`);
  }
  return colors;
}

const rgb332 = JSON.parse(readFileSync(fileURLToPath(new URL('../src/palettes/rgb332.json', import.meta.url)), 'utf8')).colors as string[];

function synthetic(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 7 + 1) & 255;
    data[i + 1] = (i * 13 + 3) & 255;
    data[i + 2] = (i * 29 + 5) & 255;
    data[i + 3] = (i * 3 + 40) & 255; // non-255 alpha exercises the passthrough
  }
  return new FakeImageData(data, width, height) as ImageData;
}

type Case = {
  name: string;
  palette: string[];
  mode: 'floyd' | 'atkinson';
  width: number;
  height: number;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
};

const cases: Case[] = [
  { name: 'floyd ramp256', palette: rampPalette(256), mode: 'floyd', width: 64, height: 64, strength: 1, brightness: 0, contrast: 0, saturation: 0 },
  { name: 'atkinson ramp256', palette: rampPalette(256), mode: 'atkinson', width: 64, height: 64, strength: 1, brightness: 0, contrast: 0, saturation: 0 },
  { name: 'floyd rgb332', palette: rgb332, mode: 'floyd', width: 64, height: 64, strength: 1, brightness: 0, contrast: 0, saturation: 0 },
  { name: 'atkinson rgb332', palette: rgb332, mode: 'atkinson', width: 64, height: 64, strength: 1, brightness: 0, contrast: 0, saturation: 0 },
  { name: 'floyd 16-color small palette', palette: rampPalette(16), mode: 'floyd', width: 48, height: 32, strength: 1, brightness: 0, contrast: 0, saturation: 0 },
  { name: 'floyd odd dims', palette: rampPalette(256), mode: 'floyd', width: 33, height: 21, strength: 1, brightness: 0, contrast: 0, saturation: 0 },
  { name: 'atkinson tone-adjusted', palette: rampPalette(256), mode: 'atkinson', width: 64, height: 64, strength: 0.6, brightness: 10, contrast: -8, saturation: 25 },
  { name: 'floyd half strength', palette: rgb332, mode: 'floyd', width: 64, height: 64, strength: 0.35, brightness: -5, contrast: 12, saturation: -15 },
];

function makeOptions(c: Case): ProcessOptions {
  return {
    palette: c.palette,
    mode: c.mode,
    strength: c.strength,
    brightness: c.brightness,
    contrast: c.contrast,
    saturation: c.saturation,
    stripeAngle: 45,
    noiseScale: 1,
    seed: 1,
    halftoneScale: 1,
  };
}

describe('wasm full-loop seamless dither parity', () => {
  let wasmBytes: ArrayBuffer | undefined;
  let jsReferences: Uint8ClampedArray[] = [];

  beforeAll(() => {
    installDomStubs();
    try {
      const buf = readFileSync(fileURLToPath(new URL('../src/wasm/dither.wasm', import.meta.url)));
      wasmBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      // artifact not built — the comparison test skips.
    }
  });

  it('JS loop reference outputs (computed before the module loads)', () => {
    for (const c of cases) {
      jsReferences.push(processImageData(synthetic(c.width, c.height), makeOptions(c)).data);
    }
    expect(jsReferences).toHaveLength(cases.length);
  });

  it('wasm loop matches the JS loop byte-for-byte', async (ctx) => {
    if (!wasmBytes) {
      ctx.skip();
      return;
    }
    await initDitherWasm(wasmBytes);
    // The module loaded: processImageData now routes through dither_seamless.
    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      const out = processImageData(synthetic(c.width, c.height), makeOptions(c));
      expect([...out.data]).toEqual([...jsReferences[i]]);
    }
  });
});
