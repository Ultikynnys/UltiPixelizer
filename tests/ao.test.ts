import { describe, expect, it } from 'vitest';
import { applyAO, redChannelFactors } from '../src/lib/ao';

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
    applyAO(data, factors, 1);
    expect(Array.from(data.slice(0, 3))).toEqual([200, 100, 50]);
    expect(Array.from(data.slice(4, 7))).toEqual([0, 0, 0]);
    expect(Array.from(data.slice(8, 11))).toEqual([100, 50, 25]);
  });

  it('scales occlusion by intensity (zero intensity leaves pixels unchanged)', () => {
    const data = frame([[200, 100, 50, 255]]);
    applyAO(data, new Uint8ClampedArray([0]), 0);
    expect(Array.from(data.slice(0, 3))).toEqual([200, 100, 50]);
  });
});
