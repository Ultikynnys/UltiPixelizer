import { beforeAll, describe, expect, it } from 'vitest';
import { aoMultiplier, applyAO, imageAOFactors, redChannelFactors } from '../src/lib/ao';
import { FakeCanvas, installDomStubs } from './helpers/domStubs';

beforeAll(() => {
  installDomStubs();
});

function frame(pixels: Array<[number, number, number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([red, green, blue, alpha], index) => {
    data[index * 4] = red;
    data[index * 4 + 1] = green;
    data[index * 4 + 2] = blue;
    data[index * 4 + 3] = alpha;
  });
  return data;
}

describe('ambient occlusion factors', () => {
  it('extracts the red channel as the visibility factor', () => {
    const data = frame([[255, 0, 0, 255], [0, 255, 255, 255], [128, 0, 0, 255]]);
    expect(Array.from(redChannelFactors({ data, width: 3, height: 1 }))).toEqual([255, 0, 128]);
  });

  it('inverts the red channel for ORM-packed maps', () => {
    const data = frame([[255, 0, 0, 255], [0, 255, 255, 255]]);
    expect(Array.from(redChannelFactors({ data, width: 2, height: 1 }, true))).toEqual([0, 255]);
  });

  it('darkens occluded pixels and leaves unoccluded pixels untouched', () => {
    const data = frame([[200, 100, 50, 255], [200, 100, 50, 255], [200, 100, 50, 255]]);
    const factors = new Uint8ClampedArray([255, 0, 128]);
    applyAO(data, factors, 0, 1);
    expect(Array.from(data.slice(0, 3))).toEqual([200, 100, 50]);
    expect(Array.from(data.slice(4, 7))).toEqual([0, 0, 0]);
    expect(Array.from(data.slice(8, 11))).toEqual([100, 50, 25]);
  });

  it('power of zero leaves pixels unchanged', () => {
    const data = frame([[200, 100, 50, 255]]);
    applyAO(data, new Uint8ClampedArray([0]), 0, 0);
    expect(Array.from(data.slice(0, 3))).toEqual([200, 100, 50]);
  });

  it('normalizes positive bias so unoccluded pixels stay full brightness', () => {
    const data = frame([[200, 100, 50, 255], [200, 100, 50, 255]]);
    const factors = new Uint8ClampedArray([255, 0]);
    applyAO(data, factors, 0.5, 1);
    // v=1: (1 − 0.5)/(1 − 0.5) = 1 → untouched; v=0: remap below the floor → black.
    expect(Array.from(data.slice(0, 3))).toEqual([200, 100, 50]);
    expect(Array.from(data.slice(4, 7))).toEqual([0, 0, 0]);
  });

  it('clamps remapped occlusion so AO never exceeds [0, 1]', () => {
    const data = frame([[100, 100, 100, 255], [100, 100, 100, 255]]);
    applyAO(data, new Uint8ClampedArray([0, 255]), 1, 4);
    // Fully occluded (v=0): bias +1 floors everything below pure white → black.
    expect(Array.from(data.slice(0, 3))).toEqual([0, 0, 0]);
    // Unoccluded (v=1): the normalized remap keeps full brightness.
    expect(Array.from(data.slice(4, 7))).toEqual([100, 100, 100]);
  });
});

describe('AO multiplier remap', () => {
  it('is the raw visibility at default bias and power', () => {
    expect(aoMultiplier(200, 0, 1)).toBeCloseTo(200 / 255);
    expect(aoMultiplier(0, 0, 1)).toBe(0);
    expect(aoMultiplier(255, 0, 1)).toBe(1);
  });

  it('returns 1 (no AO) when power is zero', () => {
    expect(aoMultiplier(0, 0, 0)).toBe(1);
    expect(aoMultiplier(128, 0, 0)).toBe(1);
  });

  it('darkens more above power 1 and less below it', () => {
    // Higher power shrinks visibility^power, lowering the multiplier.
    expect(aoMultiplier(200, 0, 2)).toBeCloseTo((200 / 255) ** 2);
    expect(aoMultiplier(200, 0, 0.5)).toBeCloseTo(Math.sqrt(200 / 255));
  });

  it('keeps the unoccluded end pinned at 1 under bias', () => {
    expect(aoMultiplier(255, 0.5, 1)).toBe(1);
    expect(aoMultiplier(255, -0.5, 1)).toBe(1);
  });

  it('re-floors the occlusion curve at the bias value', () => {
    // Raw visibility equal to the bias sits exactly on the floor (→ 0)…
    expect(aoMultiplier(255 * 0.5, 0.5, 1)).toBe(0);
    // …mid-tones remap linearly between the floor and full brightness…
    expect(aoMultiplier(255 * 0.75, 0.5, 1)).toBeCloseTo(0.5);
    // …and negative bias lifts the dark end without washing out the top.
    expect(aoMultiplier(0, -0.5, 1)).toBeCloseTo(1 / 3);
  });

  it('clamps the remap to [0, 1]', () => {
    expect(aoMultiplier(0, 1, 4)).toBe(0); // below the +1 floor → black
    expect(aoMultiplier(255, -1, 4)).toBe(1); // (1 + 1)/2 = 1  already in range
  });
});

describe('image AO factors', () => {
  function pixelCanvas(rgba: number[]): CanvasImageSource {
    const canvas = new FakeCanvas();
    canvas.width = 1;
    canvas.height = 1;
    canvas.context.pixels.set(rgba);
    return canvas as unknown as CanvasImageSource;
  }

  it('reads the red channel of a drawn image as visibility', () => {
    const factors = imageAOFactors(pixelCanvas([200, 10, 10, 255]), 1, 1);
    expect(Array.from(factors)).toEqual([200]);
  });

  it('inverts the red channel for ORM-packed maps', () => {
    const factors = imageAOFactors(pixelCanvas([200, 10, 10, 255]), 1, 1, true);
    expect(Array.from(factors)).toEqual([55]);
  });
});
