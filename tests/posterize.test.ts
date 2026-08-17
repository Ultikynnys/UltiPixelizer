import { describe, expect, it } from 'vitest';
import type { PixelSource } from '../src/lib/canvas';
import { palettes } from '../src/lib/palettes';
import { computePosterizeStats, posterizeColors } from '../src/lib/posterize';

const ramp = (levels: number): string[] => palettes[`posterize${levels}`].colors;

/** Builds a gray pixel source where each pixel's value comes from `value(x, y)`. */
function graySource(width: number, height: number, value: (x: number, y: number) => number): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.min(255, Math.max(0, Math.round(value(x, y))));
      const offset = (y * width + x) * 4;
      data[offset] = v;
      data[offset + 1] = v;
      data[offset + 2] = v;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Builds a pixel source with explicit per-pixel colors. */
function colorSource(width: number, height: number, color: (x: number, y: number) => [number, number, number]): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = color(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('posterize stats', () => {
  it('builds a luminance histogram and per-bin color sums', () => {
    const source = colorSource(2, 2, () => [255, 255, 255]);
    const stats = computePosterizeStats(source);
    expect(stats.total).toBe(4);
    expect(stats.histogram[255]).toBe(4);
    expect(stats.colorSums[255 * 3]).toBe(1020);
    expect(stats.colorSums[255 * 3 + 1]).toBe(1020);
    expect(stats.colorSums[255 * 3 + 2]).toBe(1020);
  });
});

describe('posterize colors', () => {
  it('returns the fixed ramp unchanged without stats', () => {
    expect(posterizeColors(null, 8, ramp(8))).toEqual(ramp(8));
  });

  it('returns the fixed ramp for an image with no tonal range', () => {
    const stats = computePosterizeStats(graySource(4, 4, () => 100));
    expect(posterizeColors(stats, 8, ramp(8))).toEqual(ramp(8));
  });

  it('splits a gradient into equal-population tonal buckets', () => {
    const stats = computePosterizeStats(graySource(256, 1, (x) => x));
    expect(posterizeColors(stats, 4, ramp(4))).toEqual(['#202020', '#606060', '#a0a0a0', '#e0e0e0']);
  });

  it('keeps a two-tone image at its two extremes', () => {
    const source = colorSource(4, 2, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
    const stats = computePosterizeStats(source);
    expect(posterizeColors(stats, 2, ramp(2))).toEqual(['#000000', '#ffffff']);
  });

  it('reuses the previous color for buckets left empty by a low-detail image', () => {
    const source = colorSource(4, 2, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
    const stats = computePosterizeStats(source);
    expect(posterizeColors(stats, 4, ramp(4))).toEqual(['#000000', '#000000', '#ffffff', '#ffffff']);
  });

  it('derives colors from the base texture instead of gray ramps', () => {
    const source = colorSource(4, 2, (x) => (x < 2 ? [0, 0, 255] : [255, 0, 0]));
    const stats = computePosterizeStats(source);
    expect(posterizeColors(stats, 2, ramp(2))).toEqual(['#0000ff', '#ff0000']);
  });

  it('produces a complete hex ramp for every catalog level', () => {
    const stats = computePosterizeStats(graySource(256, 1, (x) => x));
    for (const levels of [2, 4, 6, 8, 10, 12, 14, 16]) {
      const colors = posterizeColors(stats, levels, ramp(levels));
      expect(colors).toHaveLength(levels);
      expect(colors.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    }
  });

  it('is deterministic for a fixed base texture', () => {
    const stats = computePosterizeStats(graySource(128, 1, (x) => x * 2));
    expect(posterizeColors(stats, 6, ramp(6))).toEqual(posterizeColors(stats, 6, ramp(6)));
  });
});
