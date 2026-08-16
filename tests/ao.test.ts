import { beforeAll, describe, expect, it } from 'vitest';
import { applyAO, imageAOFactors, redChannelFactors } from '../src/lib/ao';
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

  it('scale of zero leaves pixels unchanged', () => {
    const data = frame([[200, 100, 50, 255]]);
    applyAO(data, new Uint8ClampedArray([0]), 0, 0);
    expect(Array.from(data.slice(0, 3))).toEqual([200, 100, 50]);
  });

  it('shifts the whole occlusion curve with bias', () => {
    const data = frame([[200, 100, 50, 255], [200, 100, 50, 255]]);
    const factors = new Uint8ClampedArray([255, 0]);
    applyAO(data, factors, 0.5, 1);
    expect(Array.from(data.slice(0, 3))).toEqual([100, 50, 25]);
    expect(Array.from(data.slice(4, 7))).toEqual([0, 0, 0]);
  });

  it('clamps remapped occlusion so AO never exceeds [0, 1]', () => {
    const data = frame([[100, 100, 100, 255], [100, 100, 100, 255]]);
    applyAO(data, new Uint8ClampedArray([0, 255]), -1, 4);
    expect(Array.from(data.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(data.slice(4, 7))).toEqual([100, 100, 100]);
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
