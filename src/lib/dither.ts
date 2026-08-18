import { hexToRgb } from './palettes';
import { clamp, type RGB } from './math';

export type DitherMode = 'floyd' | 'atkinson' | 'ordered' | 'halftone' | 'cross' | 'stripes' | 'noise' | 'checker' | 'none';

export type ProcessOptions = {
  palette: string[];
  mode: DitherMode;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  stripeAngle: number;
  noiseScale: number;
  seed: number;
  /** Multiplier on the halftone dot-cell size (1 = 4 px cells). Larger values
   * make coarser dots; the dots scale with their cells. */
  halftoneScale?: number;
  /** Per-pixel shading factor for halftone dots (0 = fully dark, 1 = fully
   * lit), sized width × height. Read at each dot's cell center; when absent,
   * the pixel's own luminance drives the dots (classic halftone). */
  lighting?: Float32Array | null;
};

const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];


const thresholdModes = new Set<DitherMode>(['ordered', 'cross', 'stripes', 'noise', 'checker']);
const LUMA = { red: 0.299, green: 0.587, blue: 0.114 };

// Base halftone dot-cell size in pixels; `halftoneScale` multiplies it so the
// pattern period and the dots scale together (dots just touch at full black).
const HALFTONE_CELL = 4;

export function patternThreshold(mode: DitherMode, x: number, y: number, stripeAngle = 45, noiseScale = 1, seed = 0): number {
  switch (mode) {
    case 'ordered':
      return BAYER_4[y % 4][x % 4] / 15;
    case 'cross': {
      const horizontal = y % 4 === 1 || y % 4 === 2;
      const vertical = x % 4 === 1 || x % 4 === 2;
      return horizontal && vertical ? 0.08 : horizontal || vertical ? 0.38 : 0.88;
    }
    case 'stripes': {
      const radians = (stripeAngle * Math.PI) / 180;
      const frequency = 4;
      const projection = (x * Math.cos(radians) + y * Math.sin(radians)) / frequency;
      return projection - Math.floor(projection);
    }
    case 'noise': {
      const cellX = Math.floor(x / noiseScale);
      const cellY = Math.floor(y / noiseScale);
      let hash = Math.imul(cellX, 374761393) + Math.imul(cellY, 668265263) + Math.imul(seed | 0, 2246822519);
      hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
      hash ^= hash >>> 16;
      return (hash >>> 0) / 4294967296;
    }
    case 'checker':
      return (x + y) % 2 === 0 ? 0.2 : 0.8;
    default:
      return 0.5;
  }
}

export function nearestColor(color: RGB, palette: RGB[]): RGB {
  if (palette.length === 0) throw new Error('nearestColor requires a non-empty palette.');
  let best = palette[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of palette) {
    const red = color[0] - candidate[0];
    const green = color[1] - candidate[1];
    const blue = color[2] - candidate[2];
    const distance = red * red * LUMA.red + green * green * LUMA.green + blue * blue * LUMA.blue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export function adjustColor(color: RGB, brightness: number, contrast: number, saturation: number): RGB {
  const brightnessOffset = brightness * 2.55;
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  let red = contrastFactor * (color[0] - 128) + 128 + brightnessOffset;
  let green = contrastFactor * (color[1] - 128) + 128 + brightnessOffset;
  let blue = contrastFactor * (color[2] - 128) + 128 + brightnessOffset;
  const gray = red * LUMA.red + green * LUMA.green + blue * LUMA.blue;
  const saturationFactor = 1 + saturation / 100;
  red = gray + (red - gray) * saturationFactor;
  green = gray + (green - gray) * saturationFactor;
  blue = gray + (blue - gray) * saturationFactor;
  return [clamp(red, 0, 255), clamp(green, 0, 255), clamp(blue, 0, 255)];
}

function ditherImageData(source: ImageData, options: ProcessOptions): ImageData {
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const data = output.data;
  const palette = options.palette.map(hexToRgb);
  const work = new Float32Array(source.width * source.height * 3);

  // Halftone splits color from shading: the base is the palette hard-map of
  // the adjusted color and the dot screen carries the shading, so no ink/paper
  // extremes are precomputed.

  for (let pixel = 0; pixel < source.width * source.height; pixel += 1) {
    const index = pixel * 4;
    const adjusted = adjustColor([data[index], data[index + 1], data[index + 2]], options.brightness, options.contrast, options.saturation);
    work[pixel * 3] = adjusted[0];
    work[pixel * 3 + 1] = adjusted[1];
    work[pixel * 3 + 2] = adjusted[2];
  }

  const spread = (x: number, y: number, error: RGB, factor: number) => {
    if (x < 0 || x >= source.width || y < 0 || y >= source.height) return;
    const target = (y * source.width + x) * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      work[target + channel] += error[channel] * factor * options.strength;
    }
  };

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const pixel = y * source.width + x;
      const workIndex = pixel * 3;
      let current: RGB = [work[workIndex], work[workIndex + 1], work[workIndex + 2]];

      if (thresholdModes.has(options.mode)) {
        const offset = (patternThreshold(options.mode, x, y, options.stripeAngle, options.noiseScale, options.seed) - 0.5) * 96 * options.strength;
        current = [clamp(current[0] + offset, 0, 255), clamp(current[1] + offset, 0, 255), clamp(current[2] + offset, 0, 255)];
      }

      let matched: RGB;
      if (options.mode === 'halftone') {
        // Staggered lattice of dot centers (mid-cell on even rows, shared
        // boundary on odd rows). Each dot's radius is driven by the shading
        // factor sampled at its cell center, so sizes stay uniform per cell
        // and grade smoothly across the image. Fully dark (factor 0) fills
        // the cell with black; fully lit (factor 1) leaves no dot at all.
        // Dither strength deliberately does NOT touch the dots: halftone is
        // shading, not error diffusion.
        const cell = Math.max(1, Math.round(HALFTONE_CELL * (options.halftoneScale ?? 1)));
        const row = Math.floor(y / cell);
        const col = Math.floor(x / cell);
        const rowOdd = row % 2 === 1;
        const centerX = rowOdd
          ? (x - col * cell < cell / 2 ? col : col + 1) * cell
          : (col + 0.5) * cell;
        const centerY = (row + 0.5) * cell;
        const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
        let factor: number;
        if (options.lighting) {
          const sampleX = clamp(Math.round(centerX), 0, source.width - 1);
          const sampleY = clamp(Math.round(centerY), 0, source.height - 1);
          factor = options.lighting[sampleY * source.width + sampleX];
        } else {
          factor = (current[0] * LUMA.red + current[1] * LUMA.green + current[2] * LUMA.blue) / 255;
        }
        const maxRadius = Math.hypot(cell / 2, cell / 2);
        const dotRadius = maxRadius * (1 - factor);
        matched = distance <= dotRadius ? [0, 0, 0] : nearestColor(current, palette);
      } else {
        matched = nearestColor(current, palette);
      }
      const outputIndex = pixel * 4;
      data[outputIndex] = matched[0];
      data[outputIndex + 1] = matched[1];
      data[outputIndex + 2] = matched[2];

      if (options.mode === 'floyd' || options.mode === 'atkinson') {
        const error: RGB = [current[0] - matched[0], current[1] - matched[1], current[2] - matched[2]];
        if (options.mode === 'floyd') {
          spread(x + 1, y, error, 7 / 16);
          spread(x - 1, y + 1, error, 3 / 16);
          spread(x, y + 1, error, 5 / 16);
          spread(x + 1, y + 1, error, 1 / 16);
        } else {
          spread(x + 1, y, error, 1 / 8);
          spread(x + 2, y, error, 1 / 8);
          spread(x - 1, y + 1, error, 1 / 8);
          spread(x, y + 1, error, 1 / 8);
          spread(x + 1, y + 1, error, 1 / 8);
          spread(x, y + 2, error, 1 / 8);
        }
      }
    }
  }
  return output;
}

/** Error-diffusion modes carry state across pixel borders: the diffusion that
 * would flow out of the image's right/bottom edges is dropped (spread clamps
 * at the edges), so tiling the dithered result shows a seam at every tile
 * boundary. The classic fix — pad the source with exact copies of itself,
 * dither the padded canvas, then crop back to the original bounds — lets the
 * border errors wrap into the opposite edge, so the tile dithers as if it
 * were part of an infinite tiling. Threshold and halftone modes are stateless
 * (per-pixel / per-cell), so they need no padding and skip the 9× cost. */
const SEAMLESS_MODES = new Set<DitherMode>(['floyd', 'atkinson']);
const PAD_TILES = 1;

/** Copies `source` into a `(1 + 2·tiles)²` grid of exact repeats: padded row
 * `py` shows source row `py % height` (and likewise for columns). */
function padTiled(source: ImageData, tiles: number): ImageData {
  const { width, height } = source;
  const size = 1 + tiles * 2;
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
}

/** Extracts the center tile of a padded canvas at the original dimensions. */
function cropCenter(padded: ImageData, width: number, height: number, tiles: number): ImageData {
  const size = 1 + tiles * 2;
  const output = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
  const rowStride = size * width;
  const start = tiles * height * rowStride + tiles * width;
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
}

export function processImageData(source: ImageData, options: ProcessOptions): ImageData {
  if (!SEAMLESS_MODES.has(options.mode)) return ditherImageData(source, options);
  return cropCenter(ditherImageData(padTiled(source, PAD_TILES), options), source.width, source.height, PAD_TILES);
}
