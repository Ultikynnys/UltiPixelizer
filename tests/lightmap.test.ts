import { describe, expect, it } from 'vitest';
import { applyLightmap, lightmapMatchesBaseColor } from '../src/lib/lightmap';

describe('lightmap dimensions', () => {
  it('requires an exact BaseColor size match', () => {
    const base = { width: 1024, height: 512 };
    expect(lightmapMatchesBaseColor({ width: 1024, height: 512 }, base)).toBe(true);
    expect(lightmapMatchesBaseColor({ width: 512, height: 512 }, base)).toBe(false);
    expect(lightmapMatchesBaseColor({ width: 1024, height: 256 }, base)).toBe(false);
  });
});

describe('applyLightmap', () => {
  it('multiplies each RGB channel independently', () => {
    const data = new Uint8ClampedArray([200, 100, 50, 123]);
    applyLightmap(data, new Uint8ClampedArray([128, 64, 255, 255]));
    expect(Array.from(data)).toEqual([100, 25, 50, 123]);
  });

  it('keeps alpha untouched and maps black lightmap texels to black', () => {
    const data = new Uint8ClampedArray([200, 120, 80, 255]);
    applyLightmap(data, new Uint8ClampedArray([0, 0, 0, 0]));
    expect(Array.from(data)).toEqual([0, 0, 0, 255]);
  });

  it('stops at the shorter buffer', () => {
    const data = new Uint8ClampedArray([200, 100, 50, 255, 10, 20, 30, 40]);
    applyLightmap(data, new Uint8ClampedArray([128, 64, 255, 255]));
    expect(Array.from(data)).toEqual([100, 25, 50, 255, 10, 20, 30, 40]);
  });
});
