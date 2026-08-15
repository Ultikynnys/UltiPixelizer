import { beforeAll, describe, expect, it } from 'vitest';
import { adjustColor, nearestColor, processImageData, type DitherMode } from '../src/lib/dither';
import { hexToRgb, palettes } from '../src/lib/palettes';

class TestImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

beforeAll(() => {
  Object.assign(globalThis, { ImageData: TestImageData });
});

function imageData(pixels: number[][], width: number): ImageData {
  return new TestImageData(new Uint8ClampedArray(pixels.flat()), width, pixels.length / width) as ImageData;
}

const options = (mode: DitherMode) => ({
  palette: ['#000000', '#ffffff'],
  mode,
  strength: 1,
  brightness: 0,
  contrast: 0,
  saturation: 0,
});

describe('palette helpers', () => {
  it('converts hex colors into RGB channels', () => {
    expect(hexToRgb('#ff8040')).toEqual([255, 128, 64]);
  });

  it('ships valid, named palettes with at least two colors', () => {
    expect(Object.keys(palettes).length).toBeGreaterThanOrEqual(8);
    for (const palette of Object.values(palettes)) {
      expect(palette.name.length).toBeGreaterThan(0);
      expect(palette.colors.length).toBeGreaterThanOrEqual(2);
      expect(palette.colors.every((color) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
    }
  });
});

describe('color adjustment and matching', () => {
  it('chooses the perceptually nearest palette color', () => {
    expect(nearestColor([245, 240, 230], [[0, 0, 0], [255, 255, 255]])).toEqual([255, 255, 255]);
    expect(nearestColor([20, 20, 20], [[0, 0, 0], [255, 255, 255]])).toEqual([0, 0, 0]);
  });

  it('falls back to black for an empty palette', () => {
    expect(nearestColor([128, 128, 128], [])).toEqual([0, 0, 0]);
  });

  it('keeps adjusted channels in byte range and changes tone', () => {
    const result = adjustColor([250, 10, 128], 100, 100, 100);
    expect(result.every((channel) => channel >= 0 && channel <= 255)).toBe(true);
    expect(adjustColor([120, 80, 40], 20, 10, -50)).not.toEqual([120, 80, 40]);
  });
});

describe('dithering engine', () => {
  const sourcePixels = [
    [32, 32, 32, 255], [96, 96, 96, 180], [160, 160, 160, 255],
    [64, 64, 64, 255], [128, 128, 128, 255], [224, 224, 224, 255],
  ];

  it.each<DitherMode>(['none', 'ordered', 'floyd', 'atkinson'])('processes %s mode into palette colors', (mode) => {
    const source = imageData(sourcePixels, 3);
    const result = processImageData(source, options(mode));
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    for (let index = 0; index < result.data.length; index += 4) {
      expect([0, 255]).toContain(result.data[index]);
      expect(result.data[index + 1]).toBe(result.data[index]);
      expect(result.data[index + 2]).toBe(result.data[index]);
      expect(result.data[index + 3]).toBe(source.data[index + 3]);
    }
  });

  it('produces deterministic ordered output and preserves the source', () => {
    const source = imageData(sourcePixels, 3);
    const original = [...source.data];
    const first = processImageData(source, { ...options('ordered'), strength: 0.75 });
    const second = processImageData(source, { ...options('ordered'), strength: 0.75 });
    expect([...first.data]).toEqual([...second.data]);
    expect([...source.data]).toEqual(original);
  });

  it('applies tone controls before palette mapping', () => {
    const source = imageData([[110, 110, 110, 255]], 1);
    const dark = processImageData(source, options('none'));
    const bright = processImageData(source, { ...options('none'), brightness: 20 });
    expect([...dark.data]).toEqual([0, 0, 0, 255]);
    expect([...bright.data]).toEqual([255, 255, 255, 255]);
  });
});
