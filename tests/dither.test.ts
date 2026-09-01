import { beforeAll, describe, expect, it } from 'vitest';
import { adjustColor, ditherImageData, isPatternMode, nearestColor, patternThreshold, processImageData, worldspacePatternThreshold, type DitherMode } from '../src/lib/dither';
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
  halftoneScale: 1,
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

  it.each<DitherMode>(['ordered', 'halftone', 'floyd', 'atkinson', 'cross', 'stripes', 'noise', 'checker'])('processes %s mode into palette colors', (mode) => {
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

  it('uses a deterministic triplanar lattice anchored to world positions', () => {
    const source = imageData(Array.from({ length: 4 }, () => [128, 128, 128, 255]), 4);
    const worldPositions = new Float32Array([
      0, 0, 0,
      0.25, 0, 0,
      0.5, 0, 0,
      0.75, 0, 0,
    ]);
    const worldNormals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const worldPositionCoverage = new Uint8Array([1, 1, 1, 1]);
    const first = processImageData(source, { ...options('ordered'), patternSpace: 'world', worldPositions, worldNormals, worldPositionCoverage, worldspaceScale: 4 });
    const second = processImageData(source, { ...options('ordered'), patternSpace: 'world', worldPositions, worldNormals, worldPositionCoverage, worldspaceScale: 4 });
    expect([...first.data]).toEqual([...second.data]);
    expect(new Set([first.data[0], first.data[4], first.data[8], first.data[12]]).size).toBeGreaterThan(1);
    expect(worldspacePatternThreshold('ordered', -0.25, 0, 0, 0, 1, 0, 4)).toBe(worldspacePatternThreshold('ordered', 0.75, 0, 0, 0, 1, 0, 4));
  });

  it.each<DitherMode>(['ordered', 'cross', 'stripes', 'noise', 'checker'])('handles fractional world coordinates in %s triplanar patterns', (mode) => {
    const source = imageData(Array.from({ length: 4 }, () => [128, 128, 128, 255]), 4);
    const worldPositions = new Float32Array([
      3.9556404799222946, 0.4427282586693764, 0.9824366569519043,
      0.1, 0.37, 0.82,
      1.5, 2.5, 3.5,
      -0.25, -1.75, -3.125,
    ]);
    const worldNormals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const worldPositionCoverage = new Uint8Array([1, 1, 1, 1]);
    const first = processImageData(source, { ...options(mode), patternSpace: 'world', worldPositions, worldNormals, worldPositionCoverage, worldspaceScale: 64 });
    const second = processImageData(source, { ...options(mode), patternSpace: 'world', worldPositions, worldNormals, worldPositionCoverage, worldspaceScale: 64 });
    expect([...first.data]).toEqual([...second.data]);
  });

  it('requires complete world-position inputs instead of falling back to image space', () => {
    const source = imageData([[128, 128, 128, 255]], 1);
    expect(() => processImageData(source, { ...options('ordered'), patternSpace: 'world' })).toThrow('world-position values');
    expect(() => processImageData(source, {
      ...options('ordered'),
      patternSpace: 'world',
      worldPositions: new Float32Array([0, 0, 0]),
      worldPositionCoverage: new Uint8Array([1]),
    })).toThrow('world-normal values');
    expect(() => processImageData(source, {
      ...options('ordered'),
      patternSpace: 'world',
      worldPositions: new Float32Array([0, 0, 0]),
      worldPositionCoverage: new Uint8Array([1]),
      worldNormals: new Float32Array([0, 1, 0]),
      worldspaceScale: 0,
    })).toThrow('positive finite');
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

  it('classifies coordinate-pattern modes', () => {
    expect(isPatternMode('ordered')).toBe(true);
    expect(isPatternMode('cross')).toBe(true);
    expect(isPatternMode('stripes')).toBe(true);
    expect(isPatternMode('noise')).toBe(true);
    expect(isPatternMode('checker')).toBe(true);
    expect(isPatternMode('floyd')).toBe(false);
    expect(isPatternMode('atkinson')).toBe(false);
    expect(isPatternMode('none')).toBe(false);
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
    // 'checker' quantizes without error diffusion, so tone changes show up as
    // pure palette transitions (the empty 'none' mode now passes through).
    const source = imageData([[110, 110, 110, 255]], 1);
    const dark = processImageData(source, options('checker'));
    const bright = processImageData(source, { ...options('checker'), brightness: 20 });
    expect([...dark.data]).toEqual([0, 0, 0, 255]);
    expect([...bright.data]).toEqual([255, 255, 255, 255]);
  });

  it('the empty pattern passes the source through  lighting only', () => {
    const source = imageData(sourcePixels, 3);
    const result = processImageData(source, options('none'));
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    expect([...result.data]).toEqual([...source.data]);
  });
});

describe('seamless error-diffusion padding', () => {
  const uniform = (size: number, gray: number): ImageData => {
    const pixels: number[][] = [];
    for (let i = 0; i < size * size; i += 1) pixels.push([gray, gray, gray, 255]);
    return imageData(pixels, size);
  };

  const firstColumnValues = (output: ImageData): Set<number> => {
    const values = new Set<number>();
    for (let y = 0; y < output.height; y += 1) values.add(output.data[y * output.width * 4]);
    return values;
  };

  it.each(['floyd', 'atkinson'] as const)('%s wraps border errors so the tile edge is a continuation', (mode) => {
    // Uniform gray with a black/white palette: without padding every row starts
    // fresh and the first column is one flat color. The pad→dither→crop pass
    // feeds the previous tile's end-of-row error (7/16 for floyd, 1/8 for
    // atkinson) into the first column, so it must vary row-to-row.
    const result = processImageData(uniform(32, 128), options(mode));
    expect(firstColumnValues(result).size).toBeGreaterThanOrEqual(2);
  });

  it.each(['floyd', 'atkinson'] as const)('%s keeps the cropped dimensions and alpha', (mode) => {
    const source = imageData(
      [
        [32, 32, 32, 255], [96, 96, 96, 180], [160, 160, 160, 255],
        [64, 64, 64, 255], [128, 128, 128, 255], [224, 224, 224, 255],
      ],
      3,
    );
    const result = processImageData(source, options(mode));
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    for (let index = 0; index < result.data.length; index += 4) {
      expect([0, 255]).toContain(result.data[index]);
      expect(result.data[index + 3]).toBe(source.data[index + 3]);
    }
  });

  it('does not pad stateless modes  their patterns stay coordinate-locked', () => {
    // Ordered dithering carries no error across borders, so the wrapper must
    // delegate straight to the core. The first column of uniform gray is
    // exactly the Bayer phase at x=0  black/white alternating with y%4.
    // Padding would shift the phase by the tile height mod 4 (here +1), so
    // this assertion also catches an accidental pad of a stateless mode.
    const source = imageData(Array.from({ length: 16 * 5 }, () => [128, 128, 128, 255]), 16);
    const result = processImageData(source, options('ordered'));
    const column: number[] = [];
    for (let y = 0; y < result.height; y += 1) column.push(result.data[y * result.width * 4]);
    expect(column).toEqual([0, 255, 0, 255, 0]);
  });

  /** The pre-optimization seamless path  a 3×3 grid of full tile copies,
   * dither, crop the center  kept here as the reference the streaming scan
   * must reproduce byte-for-byte. */
  const referenceTiled = (source: ImageData): ImageData => {
    const { width, height } = source;
    const size = 3;
    const padded = new ImageData(new Uint8ClampedArray(size * size * width * height * 4), size * width, size * height);
    for (let py = 0; py < size * height; py += 1) {
      const sy = py % height;
      for (let px = 0; px < size * width; px += 1) {
        const s = (sy * width + (px % width)) * 4;
        const d = (py * size * width + px) * 4;
        padded.data[d] = source.data[s];
        padded.data[d + 1] = source.data[s + 1];
        padded.data[d + 2] = source.data[s + 2];
        padded.data[d + 3] = source.data[s + 3];
      }
    }
    return padded;
  };

  /** Deterministic gradient + grain so the equivalence comparisons are stable. */
  const textured = (width: number, height: number): ImageData => {
    const pixels: number[][] = [];
    let noise = 0x2f6e2b1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        noise = Math.imul(noise ^ (noise >>> 13), 1274126177);
        const grain = ((noise >>> 0) % 41) - 20;
        pixels.push([x * 3 % 256 + grain, y * 3 % 256 + grain, ((x + y) * 2) % 256 + grain, 255]);
      }
    }
    return imageData(pixels, width);
  };

  /** Crops the center tile of the 3×3 reference pad. */
  const cropCenterOf = (padded: ImageData, width: number, height: number): ImageData => {
    const output = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
    const rowStride = padded.width;
    const start = height * rowStride + width;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const s = (start + y * rowStride + x) * 4;
        const d = (y * width + x) * 4;
        output.data[d] = padded.data[s];
        output.data[d + 1] = padded.data[s + 1];
        output.data[d + 2] = padded.data[s + 2];
        output.data[d + 3] = padded.data[s + 3];
      }
    }
    return output;
  };

  const referencePipeline = (source: ImageData, mode: DitherMode): ImageData =>
    cropCenterOf(ditherImageData(referenceTiled(source), options(mode)), source.width, source.height);

  it.each(['floyd', 'atkinson'] as const)('the %s streaming scan reproduces the 3×3 pad byte-for-byte', (mode) => {
    const source = textured(160, 128);
    expect([...processImageData(source, options(mode)).data]).toEqual([...referencePipeline(source, mode).data]);
  });

  it.each(['floyd', 'atkinson'] as const)('the %s streaming scan matches a wide-flat image', (mode) => {
    // Height 40 < the scan's two-row grid: the wrap cycles the short edge and
    // the streaming output must still equal the 3×3 reference exactly.
    const source = textured(160, 40);
    expect([...processImageData(source, options(mode)).data]).toEqual([...referencePipeline(source, mode).data]);
  });

  it.each(['floyd', 'atkinson'] as const)('the %s streaming scan matches a tiny image', (mode) => {
    const source = uniform(32, 128);
    expect([...processImageData(source, options(mode)).data]).toEqual([...referencePipeline(source, mode).data]);
  });

  it.each(['floyd', 'atkinson'] as const)('the %s streaming scan preserves alpha', (mode) => {
    const source = imageData(
      [
        [32, 32, 32, 80], [96, 96, 96, 180], [160, 160, 160, 255],
        [64, 64, 64, 10], [128, 128, 128, 90], [224, 224, 224, 200],
      ],
      3,
    );
    const result = processImageData(source, options(mode));
    for (let i = 3; i < result.data.length; i += 4) {
      expect(result.data[i]).toBe(source.data[i]);
    }
  });

  /** Clean ascending hex palette  6-digit channels so hexToRgb round-trips. */
  const paletteOf = (count: number): string[] => {
    const colors: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const value = Math.round((i * 0xffffff) / (count - 1));
      colors.push(`#${value.toString(16).padStart(6, '0')}`);
    }
    return colors;
  };

  /** Linear-scan oracle replicating `linearMatch` exactly  same expression,
   * same float32 weights  so the k-d tree's output can be asserted
   * byte-for-byte (the exported nearestColor uses double-precision weights
   * and can differ from the matcher on near-ties). */
  const linearMatchOracle = (r: number, g: number, b: number, palette: string[]): number => {
    const weights = new Float32Array([0.299, 0.587, 0.114]);
    const flat = new Float32Array(palette.length * 3);
    const colors = palette.map(hexToRgb);
    for (let i = 0; i < colors.length; i += 1) {
      flat[i * 3] = colors[i][0];
      flat[i * 3 + 1] = colors[i][1];
      flat[i * 3 + 2] = colors[i][2];
    }
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < colors.length; i += 1) {
      const dr = r - flat[i * 3];
      const dg = g - flat[i * 3 + 1];
      const db = b - flat[i * 3 + 2];
      const distance = dr * dr * weights[0] + dg * dg * weights[1] + db * db * weights[2];
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  };

  /** f64x2 SIMD twin: mirrors the Rust `linear_match` pair reduction in scalar
   * TS (same SoA f64 promotion, same distance expression, same first-wins pair
   * reduction). Byte-compared against `linearMatchOracle` to pin the algorithm
   * the WASM module implements before it is compiled on the host. */
  const linearMatchPairs = (r: number, g: number, b: number, palette: string[]): number => {
    const weights = new Float32Array([0.299, 0.587, 0.114]);
    const flat = new Float32Array(palette.length * 3);
    const colors = palette.map(hexToRgb);
    for (let i = 0; i < colors.length; i += 1) {
      flat[i * 3] = colors[i][0];
      flat[i * 3 + 1] = colors[i][1];
      flat[i * 3 + 2] = colors[i][2];
    }
    const count = colors.length;
    // SoA f64 promotion (f32 -> f64 exact), matching the loader's layout.
    const rCh = new Float64Array(count);
    const gCh = new Float64Array(count);
    const bCh = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      rCh[i] = flat[i * 3];
      gCh[i] = flat[i * 3 + 1];
      bCh[i] = flat[i * 3 + 2];
    }
    const wr = weights[0];
    const wg = weights[1];
    const wb = weights[2];
    const dist = (cr: number, cg: number, cb: number): number => {
      const dr = r - cr;
      const dg = g - cg;
      const db = b - cb;
      return (dr * dr * wr + dg * dg * wg) + db * db * wb;
    };
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    let i = 0;
    for (; i + 1 < count; i += 2) {
      const d0 = dist(rCh[i], gCh[i], bCh[i]);
      const d1 = dist(rCh[i + 1], gCh[i + 1], bCh[i + 1]);
      let winIdx: number;
      let winDist: number;
      if (d0 < d1) {
        winIdx = i;
        winDist = d0;
      } else if (d1 < d0) {
        winIdx = i + 1;
        winDist = d1;
      } else {
        winIdx = i;
        winDist = d0;
      }
      if (winDist < bestDist) {
        bestDist = winDist;
        best = winIdx;
      }
    }
    if (i < count) {
      const d = dist(rCh[i], gCh[i], bCh[i]);
      if (d < bestDist) {
        best = i;
      }
    }
    return best;
  };

  it('the f64x2 pair scan reduces byte-identically to the scalar scan', () => {
    // Deterministic PRNG so the sweep is reproducible.
    let seed = 0x12345678;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    // Random palettes of every size (1..256, stressing even/odd and the scalar
    // tail) with random queries both in-gamut and out-of-gamut (error diffusion
    // overshoots the [0,255] cube).
    for (let trial = 0; trial < 2000; trial += 1) {
      const count = 1 + Math.floor(rand() * 256);
      const palette: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const r = Math.floor(rand() * 256);
        const g = Math.floor(rand() * 256);
        const b = Math.floor(rand() * 256);
        palette.push(`#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`);
      }
      const qr = rand() * 700 - 100;
      const qg = rand() * 700 - 100;
      const qb = rand() * 700 - 100;
      expect(linearMatchPairs(qr, qg, qb, palette)).toBe(linearMatchOracle(qr, qg, qb, palette));
    }
  });

  it('the pair scan handles single, even, and odd palette sizes', () => {
    expect(linearMatchPairs(10, 10, 10, ['#000000'])).toBe(0);
    expect(linearMatchPairs(10, 10, 10, ['#ffffff', '#000000'])).toBe(1);
    expect(linearMatchPairs(250, 250, 250, ['#000000', '#ffffff', '#ff0000'])).toBe(1);
  });

  it('the k-d matcher resolves a 64-color palette exactly like the linear scan', () => {
    // strength 0 removes the ordered pattern offset  the pipeline reduces to
    // tone-adjust (identity at 0/0/0) + palette mapping, isolating the matcher.
    const source = textured(48, 32);
    const palette = paletteOf(64);
    const result = processImageData(source, { ...options('ordered'), palette, strength: 0 });
    const oracle = new ImageData(new Uint8ClampedArray(result.data), result.width, result.height);
    for (let i = 0; i < result.data.length; i += 4) {
      const [r, g, b] = hexToRgb(palette[linearMatchOracle(result.data[i], result.data[i + 1], result.data[i + 2], palette)]);
      oracle.data[i] = r;
      oracle.data[i + 1] = g;
      oracle.data[i + 2] = b;
    }
    expect([...result.data]).toEqual([...oracle.data]);
  });

  it.each(['floyd', 'atkinson'] as const)('the %s streaming scan matches the 3×3 pad on a 64-color palette (k-d path)', (mode) => {
    // Both sides route through the k-d matcher; this pins the streaming scan
    // to the padded reference when palette sizes exceed the linear threshold.
    const source = textured(96, 72);
    const large = { ...options(mode), palette: paletteOf(64) };
    const reference = cropCenterOf(ditherImageData(referenceTiled(source), large), source.width, source.height);
    expect([...processImageData(source, large).data]).toEqual([...reference.data]);
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

  it('fills the whole frame with the base color for a fully dark image', () => {
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

  it('renders base-color dots over paper', () => {
    const source = imageData([[80, 80, 80, 255], [80, 80, 80, 255], [80, 80, 80, 255], [80, 80, 80, 255]], 2);
    const output = processImageData(source, { ...halftone, palette: ['#123456', '#f0e8d0'] });
    const values = new Set<string>();
    for (let i = 0; i < output.data.length; i += 4) {
      values.add(`${output.data[i]},${output.data[i + 1]},${output.data[i + 2]}`);
    }
    // Dots are the hard-mapped base color (the dark palette color for a dark
    // source); everything else is paper white, never the light palette color.
    expect(values).toContain('18,52,86');
    expect(values).not.toContain('240,232,208');
  });

  it('maps lighting to dot size: fully dark fills the base color, fully lit leaves paper', () => {
    const source = imageData(Array(16).fill([96, 96, 96, 255]), 4);
    const lit = processImageData(source, { ...halftone, lighting: new Float32Array(16).fill(1) });
    const litValues = new Set<number>();
    for (let i = 0; i < lit.data.length; i += 4) litValues.add(lit.data[i]);
    // Fully lit: the base color's own luminance still drives dots, so the
    // frame mixes base-color dots with paper.
    expect(litValues).toEqual(new Set([0, 255]));
    const dark = processImageData(source, { ...halftone, lighting: new Float32Array(16).fill(0) });
    expect([...dark.data]).toEqual(new Array(64).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('samples the lighting once per dot cell, not per pixel', () => {
    // A single 4×4 cell with one dark pixel off-center: the dot reads the
    // lighting at the cell center (fully lit) and stays absent everywhere.
    const source = imageData(Array(16).fill([128, 128, 128, 255]), 4);
    const lighting = new Float32Array(16).fill(1);
    lighting[5] = 0;
    const output = processImageData(source, { ...halftone, lighting });
    const values = new Set<number>();
    for (let i = 0; i < output.data.length; i += 4) values.add(output.data[i]);
    expect(values).toEqual(new Set([255]));
  });

  it('ignores dither strength: halftone is shading, not diffusion', () => {
    const source = imageData(Array(16).fill([64, 64, 64, 255]), 4);
    const lighting = new Float32Array(16).fill(0.5);
    const weak = processImageData(source, { ...halftone, lighting, strength: 0 });
    const strong = processImageData(source, { ...halftone, lighting, strength: 1 });
    expect([...weak.data]).toEqual([...strong.data]);
  });

  it('halftone scale multiplies the dot-cell size', () => {
    const source = imageData(Array(16).fill([120, 120, 120, 255]), 4);
    const lighting = new Float32Array(16).fill(1);
    const palette = ['#000000', '#808080'];
    const small = processImageData(source, { ...halftone, palette, lighting });
    const large = processImageData(source, { ...halftone, palette, lighting, halftoneScale: 2 });
    const dotCount = (output: ImageData): number => {
      let count = 0;
      for (let i = 0; i < output.data.length; i += 4) {
        if (output.data[i] !== 255) count += 1;
      }
      return count;
    };
    // Scale 1 dots cover the cell cores; scale 2 makes one bigger dot that
    // reaches further into the same 4×4 frame.
    expect(dotCount(large)).toBeGreaterThan(dotCount(small));
    expect(dotCount(small)).toBe(4);
    expect(dotCount(large)).toBe(8);
  });
});
