import { beforeAll, describe, expect, it } from 'vitest';
import { adjustColor, nearestColor, patternThreshold, processImageData, type DitherMode } from '../src/lib/dither';
import { hexToRgb, hslToRgb, hsvToRgb, palettes, paletteCategories, rgbToHex, rgbToHsl, rgbToHsv } from '../src/lib/palettes';
import { FakeImageData, installDomStubs } from './helpers/domStubs';

beforeAll(() => {
  installDomStubs();
});

function imageData(pixels: number[][], width: number): ImageData {
  return new FakeImageData(new Uint8ClampedArray(pixels.flat()), width, pixels.length / width) as ImageData;
}

const options = (mode: DitherMode) => ({
  palette: ['#000000', '#ffffff'],
  mode,
  strength: 1,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  stripeAngle: 45,
  noiseScale: 1,
  seed: 1,
});

describe('palette helpers', () => {
  it('converts hex colors into RGB channels', () => {
    expect(hexToRgb('#ff8040')).toEqual([255, 128, 64]);
  });

  it('converts between hex, RGB, and HSL', () => {
    expect(rgbToHsl(...hexToRgb('#ff0000'))).toEqual([0, 100, 50]);
    expect(hslToRgb(0, 100, 50)).toEqual([255, 0, 0]);
    expect(rgbToHex(...hslToRgb(210, 50, 40))).toBe('#336699');
    const [h, s, l] = rgbToHsl(200, 120, 40);
    expect(hslToRgb(h, s, l).map((channel) => Math.round(channel))).toEqual([200, 120, 40]);
    expect(hslToRgb(120, 0, 50)).toEqual([127.5, 127.5, 127.5]);
  });

  it('converts between RGB and HSV', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 100, 100]);
    expect(rgbToHsv(0, 0, 255)).toEqual([240, 100, 100]);
    expect(rgbToHsv(255, 255, 255)).toEqual([0, 0, 100]);
    expect(hsvToRgb(0, 100, 100)).toEqual([255, 0, 0]);
    expect(hsvToRgb(120, 100, 100)).toEqual([0, 255, 0]);
    expect(hsvToRgb(240, 100, 100)).toEqual([0, 0, 255]);
    expect(rgbToHex(...hsvToRgb(210, 50, 80))).toBe('#6699cc');
    expect(rgbToHex(...hsvToRgb(0, 0, 40))).toBe('#666666');
    const [h, s, v] = rgbToHsv(200, 120, 40);
    expect(hsvToRgb(h, s, v).map((channel) => Math.round(channel))).toEqual([200, 120, 40]);
  });

  it('ships a large, valid catalog with unique colors and metadata', () => {
    expect(Object.keys(palettes).length).toBeGreaterThanOrEqual(28);
    for (const [key, palette] of Object.entries(palettes)) {
      expect(key).toMatch(/^[a-z0-9]+$/);
      expect(palette.name.length).toBeGreaterThan(0);
      expect(paletteCategories).toContain(palette.category);
      expect(palette.colors.length).toBeGreaterThanOrEqual(2);
      expect(new Set(palette.colors).size, `${palette.name} has duplicate colors`).toBe(palette.colors.length);
      expect(palette.colors.every((color) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
    }
  });

  it('preserves complete flagship and extended palettes', () => {
    expect(palettes.aap64.colors).toHaveLength(64);
    expect(palettes.endesga32.colors).toHaveLength(32);
    expect(palettes.dawnbringer32.colors).toHaveLength(32);
    expect(palettes.na16.colors).toHaveLength(16);
    expect(palettes.pastel24.colors).toHaveLength(24);
    expect(palettes.rgb332.colors).toHaveLength(256);
  });
});

describe('color adjustment and matching', () => {
  it('chooses the perceptually nearest palette color', () => {
    expect(nearestColor([245, 240, 230], [[0, 0, 0], [255, 255, 255]])).toEqual([255, 255, 255]);
    expect(nearestColor([20, 20, 20], [[0, 0, 0], [255, 255, 255]])).toEqual([0, 0, 0]);
  });

  it('throws for an empty palette', () => {
    expect(() => nearestColor([128, 128, 128], [])).toThrow('non-empty palette');
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

  it.each<DitherMode>(['none', 'ordered', 'halftone', 'floyd', 'atkinson', 'cross', 'stripes', 'noise', 'checker'])('processes %s mode into palette colors', (mode) => {
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

  it('produces deterministic ordered and noise output and preserves the source', () => {
    const source = imageData(sourcePixels, 3);
    const original = [...source.data];
    for (const mode of ['ordered', 'noise'] as const) {
      const first = processImageData(source, { ...options(mode), strength: 0.75 });
      const second = processImageData(source, { ...options(mode), strength: 0.75 });
      expect([...first.data]).toEqual([...second.data]);
    }
    expect([...source.data]).toEqual(original);
  });

  it('defines bounded and distinct spatial thresholds', () => {
    const modes: DitherMode[] = ['ordered', 'cross', 'stripes', 'noise', 'checker'];
    const signatures = modes.map((mode) => Array.from({ length: 16 }, (_, index) => patternThreshold(mode, index % 4, Math.floor(index / 4))));
    for (const signature of signatures) {
      expect(signature.every((value) => value >= 0 && value <= 1)).toBe(true);
    }
    expect(new Set(signatures.map((signature) => signature.join(','))).size).toBe(modes.length);
    expect(patternThreshold('none', 0, 0)).toBe(0.5);
  });

  it('varies the stripe threshold with angle', () => {
    expect(patternThreshold('stripes', 1, 0, 0)).not.toBe(patternThreshold('stripes', 1, 0, 90));
    expect(patternThreshold('stripes', 0, 1, 0)).toBe(0);
  });

  it('scales the noise grain', () => {
    expect(patternThreshold('noise', 0, 0, 45, 8)).toBe(patternThreshold('noise', 7, 7, 45, 8));
    expect(patternThreshold('noise', 0, 0, 45, 1)).toBe(0);
  });

  it('derives the noise pattern from the seed', () => {
    expect(patternThreshold('noise', 2, 3, 45, 1, 5)).toBe(patternThreshold('noise', 2, 3, 45, 1, 5));
    expect(patternThreshold('noise', 2, 3, 45, 1, 5)).not.toBe(patternThreshold('noise', 2, 3, 45, 1, 6));
  });

  it('keeps the noise pattern stable for a fixed seed', () => {
    const first = Array.from({ length: 32 }, (_, index) => patternThreshold('noise', index % 8, Math.floor(index / 8), 45, 1, 42));
    const second = Array.from({ length: 32 }, (_, index) => patternThreshold('noise', index % 8, Math.floor(index / 8), 45, 1, 42));
    expect(first).toEqual(second);
  });

  it('renders noise dithering deterministically for a fixed seed', () => {
    const source = imageData(sourcePixels, 3);
    const first = processImageData(source, { ...options('noise'), seed: 42 });
    const second = processImageData(source, { ...options('noise'), seed: 42 });
    const other = processImageData(source, { ...options('noise'), seed: 43 });
    expect([...first.data]).toEqual([...second.data]);
    expect([...first.data]).not.toEqual([...other.data]);
  });

  it('keeps the noise threshold high-frequency with no long block runs', () => {
    let run = 0;
    let maxRun = 0;
    let total = 0;
    let runs = 0;
    let previous = false;
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const above = patternThreshold('noise', x, y) >= 0.5;
        if (above === previous) run += 1;
        else { maxRun = Math.max(maxRun, run); total += run; runs += 1; run = 1; }
        previous = above;
      }
    }
    maxRun = Math.max(maxRun, run);
    total += run;
    runs += 1;
    expect(maxRun).toBeLessThan(24);
    expect(total / runs).toBeLessThan(4);
  });

  it('applies tone controls before palette mapping', () => {
    const source = imageData([[110, 110, 110, 255]], 1);
    const dark = processImageData(source, options('none'));
    const bright = processImageData(source, { ...options('none'), brightness: 20 });
    expect([...dark.data]).toEqual([0, 0, 0, 255]);
    expect([...bright.data]).toEqual([255, 255, 255, 255]);
  });
});

describe('halftone dot rendering', () => {
  const halftone = options('halftone');

  const inkCount = (output: ImageData): number => {
    let count = 0;
    for (let i = 0; i < output.data.length; i += 4) {
      if (output.data[i] === 0) count += 1;
    }
    return count;
  };

  it('fills the whole frame with ink for a fully dark image', () => {
    const source = imageData([[0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]], 2);
    const output = processImageData(source, halftone);
    expect(inkCount(output)).toBe(6);
    expect([...output.data]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  });

  it('leaves a fully light image as paper', () => {
    const source = imageData([[255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255]], 2);
    const output = processImageData(source, halftone);
    expect(inkCount(output)).toBe(0);
  });

  it('draws larger dots for darker pixels', () => {
    const dark = processImageData(imageData([[64, 64, 64, 255], [64, 64, 64, 255], [64, 64, 64, 255], [64, 64, 64, 255], [64, 64, 64, 255], [64, 64, 64, 255]], 2), halftone);
    const light = processImageData(imageData([[192, 192, 192, 255], [192, 192, 192, 255], [192, 192, 192, 255], [192, 192, 192, 255], [192, 192, 192, 255], [192, 192, 192, 255]], 2), halftone);
    expect(inkCount(dark)).toBeGreaterThan(inkCount(light));
  });

  it('uses the darkest palette color as ink and the lightest as paper', () => {
    const source = imageData([[80, 80, 80, 255], [80, 80, 80, 255], [80, 80, 80, 255], [80, 80, 80, 255]], 2);
    const output = processImageData(source, { ...halftone, palette: ['#123456', '#f0e8d0'] });
    const values = new Set<string>();
    for (let i = 0; i < output.data.length; i += 4) {
      values.add(`${output.data[i]},${output.data[i + 1]},${output.data[i + 2]}`);
    }
    expect(values.size).toBeLessThanOrEqual(2);
    expect(values).toContain('18,52,86');
    expect(values).toContain('240,232,208');
  });
});
