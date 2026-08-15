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
  it('leaves source pixels unchanged at zero contribution', () => {
    const data = new Uint8ClampedArray([200, 100, 50, 255]);
    applyLightmap(data, new Uint8ClampedArray([0, 128, 255, 255]), 0);
    expect(Array.from(data)).toEqual([200, 100, 50, 255]);
  });

  it('multiplies each RGB channel independently at full contribution', () => {
    const data = new Uint8ClampedArray([200, 100, 50, 123]);
    applyLightmap(data, new Uint8ClampedArray([128, 64, 255, 255]), 1);
    expect(Array.from(data)).toEqual([100, 25, 50, 123]);
  });

  it('interpolates between white and the lightmap', () => {
    const data = new Uint8ClampedArray([200, 120, 80, 255]);
    applyLightmap(data, new Uint8ClampedArray([0, 0, 0, 255]), 0.25);
    expect(Array.from(data)).toEqual([150, 90, 60, 255]);
  });

  it('clamps contribution to the supported range', () => {
    const dark = new Uint8ClampedArray([100, 100, 100, 255]);
    applyLightmap(dark, new Uint8ClampedArray([0, 0, 0, 255]), 2);
    expect(Array.from(dark)).toEqual([0, 0, 0, 255]);
    const unchanged = new Uint8ClampedArray([100, 100, 100, 255]);
    applyLightmap(unchanged, new Uint8ClampedArray([0, 0, 0, 255]), -1);
    expect(Array.from(unchanged)).toEqual([100, 100, 100, 255]);
  });
});
