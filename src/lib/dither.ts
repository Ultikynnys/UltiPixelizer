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

/** True for the coordinate-pattern modes (ordered / cross / stripes / noise /
 * checker). Error diffusion, halftone and 'none' have no pattern coordinates. */
export function isPatternMode(mode: DitherMode): boolean {
  return thresholdModes.has(mode);
}

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

/** Palettes at or below this size use the linear scan; larger palettes get
 * the exact k-d tree, whose build + query cost amortizes over the scan. */
const KD_THRESHOLD = 32;

/** Nearest-color matcher over a palette. Both the linear scan and the k-d
 * tree compute the LUMA-weighted distance with the identical expression and
 * resolve exact ties to the lowest palette index, so `matchPalette` returns
 * the same index a plain linear scan would for every input. */
type PaletteMatcher = {
  count: number;
  flat: Float32Array;
  weights: Float32Array;
  tree: KDNode | null;
};

type KDNode = {
  axis: number;
  value: number;
  index: number;
  left: KDNode | null;
  right: KDNode | null;
};

function buildPaletteMatcher(palette: string[]): PaletteMatcher {
  const count = palette.length;
  const flat = new Float32Array(count * 3);
  const colors = palette.map(hexToRgb);
  for (let i = 0; i < count; i += 1) {
    flat[i * 3] = colors[i][0];
    flat[i * 3 + 1] = colors[i][1];
    flat[i * 3 + 2] = colors[i][2];
  }
  const weights = new Float32Array([LUMA.red, LUMA.green, LUMA.blue]);
  let tree: KDNode | null = null;
  if (count > KD_THRESHOLD) {
    const indices = new Int32Array(count);
    for (let i = 0; i < count; i += 1) indices[i] = i;
    tree = buildKDNode(indices, flat, 0, count, 0);
  }
  return { count, flat, weights, tree };
}

/** Median-split k-d tree over the palette's raw RGB coordinates — the LUMA
 * weights enter only the distance/prune arithmetic, so the split planes are
 * the same as in scaled space. */
function buildKDNode(indices: Int32Array, flat: Float32Array, start: number, end: number, axis: number): KDNode | null {
  if (start >= end) return null;
  const slice = indices.subarray(start, end);
  slice.sort((a, b) => flat[a * 3 + axis] - flat[b * 3 + axis]);
  const mid = start + ((end - start) >> 1);
  const index = indices[mid];
  return {
    axis,
    value: flat[index * 3 + axis],
    index,
    left: buildKDNode(indices, flat, start, mid, (axis + 1) % 3),
    right: buildKDNode(indices, flat, mid + 1, end, (axis + 1) % 3),
  };
}

type BestMatch = { index: number; distance: number };

/** Exact nearest-color query. The node's own point is evaluated with the
 * linear-scan distance expression; the far subtree is pruned only when the
 * slab lower bound clears the best distance with a margin, so float rounding
 * can never skip a true winner. Exact distance ties resolve to the lowest
 * palette index, matching the linear scan's first-minimum behavior. */
function queryKD(node: KDNode, flat: Float32Array, weights: Float32Array, r: number, g: number, b: number, best: BestMatch): void {
  const index = node.index;
  const dr = r - flat[index * 3];
  const dg = g - flat[index * 3 + 1];
  const db = b - flat[index * 3 + 2];
  const distance = dr * dr * weights[0] + dg * dg * weights[1] + db * db * weights[2];
  if (distance < best.distance || (distance === best.distance && index < best.index)) {
    best.distance = distance;
    best.index = index;
  }
  const axis = node.axis;
  const v = axis === 0 ? r : axis === 1 ? g : b;
  const near = v < node.value ? node.left : node.right;
  const far = near === node.left ? node.right : node.left;
  if (near) queryKD(near, flat, weights, r, g, b, best);
  if (far) {
    const diff = v - node.value;
    if (weights[axis] * diff * diff < best.distance * 1.000001) queryKD(far, flat, weights, r, g, b, best);
  }
}

function linearMatch(flat: Float32Array, weights: Float32Array, count: number, r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
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
}

function matchPalette(m: PaletteMatcher, r: number, g: number, b: number): number {
  if (m.tree) {
    const best: BestMatch = { index: -1, distance: Number.POSITIVE_INFINITY };
    queryKD(m.tree, m.flat, m.weights, r, g, b, best);
    return best.index;
  }
  return linearMatch(m.flat, m.weights, m.count, r, g, b);
}

export function ditherImageData(source: ImageData, options: ProcessOptions): ImageData {
  // The 'none' mode performs no adjustment and no palette mapping — the
  // caller's lighting pass (lightmap + AO multiply) is the only modification.
  if (options.mode === 'none') return source;
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const data = output.data;
  const work = new Float32Array(source.width * source.height * 3);
  const matcher = buildPaletteMatcher(options.palette);
  const { width, height } = source;
  const strength = options.strength;
  const isThreshold = thresholdModes.has(options.mode);
  const isHalftone = options.mode === 'halftone';
  const isFloyd = options.mode === 'floyd';
  const isAtkinson = options.mode === 'atkinson';
  const brightnessOffset = options.brightness * 2.55;
  const contrastFactor = (259 * (options.contrast + 255)) / (255 * (259 - options.contrast));
  const saturationFactor = 1 + options.saturation / 100;

  // Halftone splits color from shading: the base is the palette hard-map of
  // the adjusted color and the dot screen carries the shading, so no ink/paper
  // extremes are precomputed.

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    let ar = contrastFactor * (data[index] - 128) + 128 + brightnessOffset;
    let ag = contrastFactor * (data[index + 1] - 128) + 128 + brightnessOffset;
    let ab = contrastFactor * (data[index + 2] - 128) + 128 + brightnessOffset;
    const gray = ar * LUMA.red + ag * LUMA.green + ab * LUMA.blue;
    const w = pixel * 3;
    work[w] = clamp(gray + (ar - gray) * saturationFactor, 0, 255);
    work[w + 1] = clamp(gray + (ag - gray) * saturationFactor, 0, 255);
    work[w + 2] = clamp(gray + (ab - gray) * saturationFactor, 0, 255);
  }

  const spread = (x: number, y: number, er: number, eg: number, eb: number, factor: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const target = (y * width + x) * 3;
    work[target] += er * factor * strength;
    work[target + 1] += eg * factor * strength;
    work[target + 2] += eb * factor * strength;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const workIndex = pixel * 3;
      let r = work[workIndex];
      let g = work[workIndex + 1];
      let b = work[workIndex + 2];

      if (isThreshold) {
        // Pattern modes are sampled 1:1 — one threshold cell per output pixel.
        const offset = (patternThreshold(options.mode, x, y, options.stripeAngle, options.noiseScale, options.seed) - 0.5) * 96 * strength;
        r = clamp(r + offset, 0, 255);
        g = clamp(g + offset, 0, 255);
        b = clamp(b + offset, 0, 255);
      }

      let matchedIndex: number;
      if (isHalftone) {
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
          const sampleX = clamp(Math.round(centerX), 0, width - 1);
          const sampleY = clamp(Math.round(centerY), 0, height - 1);
          factor = options.lighting[sampleY * width + sampleX];
        } else {
          factor = (r * LUMA.red + g * LUMA.green + b * LUMA.blue) / 255;
        }
        const maxRadius = Math.hypot(cell / 2, cell / 2);
        const dotRadius = maxRadius * (1 - factor);
        // −1 marks an ink dot (pure black); the base is the hard-mapped color.
        matchedIndex = distance <= dotRadius ? -1 : matchPalette(matcher, r, g, b);
      } else {
        matchedIndex = matchPalette(matcher, r, g, b);
      }
      const outputIndex = pixel * 4;
      const mr = matchedIndex < 0 ? 0 : matcher.flat[matchedIndex * 3];
      const mg = matchedIndex < 0 ? 0 : matcher.flat[matchedIndex * 3 + 1];
      const mb = matchedIndex < 0 ? 0 : matcher.flat[matchedIndex * 3 + 2];
      data[outputIndex] = mr;
      data[outputIndex + 1] = mg;
      data[outputIndex + 2] = mb;

      if (isFloyd || isAtkinson) {
        const er = r - mr;
        const eg = g - mg;
        const eb = b - mb;
        if (isFloyd) {
          spread(x + 1, y, er, eg, eb, 7 / 16);
          spread(x - 1, y + 1, er, eg, eb, 3 / 16);
          spread(x, y + 1, er, eg, eb, 5 / 16);
          spread(x + 1, y + 1, er, eg, eb, 1 / 16);
        } else {
          spread(x + 1, y, er, eg, eb, 1 / 8);
          spread(x + 2, y, er, eg, eb, 1 / 8);
          spread(x - 1, y + 1, er, eg, eb, 1 / 8);
          spread(x, y + 1, er, eg, eb, 1 / 8);
          spread(x + 1, y + 1, er, eg, eb, 1 / 8);
          spread(x, y + 2, er, eg, eb, 1 / 8);
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
 * (per-pixel / per-cell), so they need no padding.
 *
 * The canonical seamless grid is 3×3 (9 tiles). Diffusion flows only down and
 * right, so the center tile never reads the bottom strip (rows 2h..3h−1) or
 * the right strip below the top row — but the top strip must extend to 3w:
 * the tile's top-right pixel receives the 3/16 down-left spread of column 2w
 * (verified: a 3×2 grid is byte-identical to the 3×3 for floyd and atkinson,
 * while 2×2/2×3 differ). The grid is pure re-indexing — padded pixel (px, py)
 * shows source (px mod w, py mod h) — so `streamDitherSeamless` scans the
 * virtual 3w×2h grid with a rolling work buffer and writes only the center
 * tile. That keeps the working set at ~KB instead of the ~750 MB the padded
 * buffers need at 2k, and the per-slot accumulation order is unchanged
 * (adjusted value first, then error arrivals in scan order), so the output is
 * byte-identical to the padded implementation. */
const SEAMLESS_MODES = new Set<DitherMode>(['floyd', 'atkinson']);

/** Streaming seamless error diffusion — see the comment above. */
function streamDitherSeamless(source: ImageData, options: ProcessOptions): ImageData {
  const { width, height } = source;
  const atkinson = options.mode === 'atkinson';
  const rowsNeeded = atkinson ? 3 : 2;
  const gridWidth = width * 3;
  const gridHeight = height * 2;
  // Rolling work rows: each virtual grid row's adjusted colors plus the error
  // diffused into it. Floyd reaches one row down, atkinson two, so two or
  // three row slots cover the whole grid regardless of its height.
  const work = new Float32Array(rowsNeeded * gridWidth * 3);
  const output = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
  const src = source.data;

  // The shared matcher's flat arrays (float32 LUMA weights) keep this path
  // byte-identical with ditherImageData's matchPalette — but the k-d tree is
  // deliberately NOT used here. Error-diffusion queries stay near the palette
  // gamut, so the far-subtree prune rarely engages on dense palettes and the
  // recursive query runs ~3× slower than the tight linear loop (measured:
  // 256-color floyd at 2k, 117s with the tree vs 41s with the scan).
  const matcher = buildPaletteMatcher(options.palette);

  const brightness = options.brightness;
  const contrast = options.contrast;
  const saturation = options.saturation;
  const strength = options.strength;
  const brightnessOffset = brightness * 2.55;
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const saturationFactor = 1 + saturation / 100;

  /** Writes the tone-adjusted colors of virtual grid row `py` into `slot`.
   * Runs one row ahead of the scan so every slot the diffusion touches is
   * initialized exactly as the padded implementation initialized it. */
  const initRow = (slot: number, py: number): void => {
    const sy = py % height;
    const srcRow = sy * width * 4;
    const base = slot * gridWidth * 3;
    for (let px = 0; px < gridWidth; px += 1) {
      const s = srcRow + (px % width) * 4;
      let ar = contrastFactor * (src[s] - 128) + 128 + brightnessOffset;
      let ag = contrastFactor * (src[s + 1] - 128) + 128 + brightnessOffset;
      let ab = contrastFactor * (src[s + 2] - 128) + 128 + brightnessOffset;
      const gray = ar * LUMA.red + ag * LUMA.green + ab * LUMA.blue;
      ar = clamp(gray + (ar - gray) * saturationFactor, 0, 255);
      ag = clamp(gray + (ag - gray) * saturationFactor, 0, 255);
      ab = clamp(gray + (ab - gray) * saturationFactor, 0, 255);
      const w = base + px * 3;
      work[w] = ar;
      work[w + 1] = ag;
      work[w + 2] = ab;
    }
  };

  /** Adds `error · factor · strength` into grid row slot `target` at column
   * `x`; columns outside the grid are dropped, exactly like the padded
   * implementation's edge clamp. */
  const spreadRow = (target: number, x: number, er: number, eg: number, eb: number, factor: number): void => {
    if (x < 0 || x >= gridWidth) return;
    const t = target + x * 3;
    work[t] += er * factor * strength;
    work[t + 1] += eg * factor * strength;
    work[t + 2] += eb * factor * strength;
  };

  initRow(0, 0);
  if (rowsNeeded > 2) initRow(1, 1);

  for (let py = 0; py < gridHeight; py += 1) {
    const rowSlot = py % rowsNeeded;
    const nextRow = py + rowsNeeded - 1;
    if (nextRow < gridHeight) initRow(nextRow % rowsNeeded, nextRow);
    const base = rowSlot * gridWidth * 3;
    const below = ((py + 1) % rowsNeeded) * gridWidth * 3;
    const below2 = ((py + 2) % rowsNeeded) * gridWidth * 3;
    const inCenter = py >= height;
    for (let px = 0; px < gridWidth; px += 1) {
      const w = base + px * 3;
      const r = work[w];
      const g = work[w + 1];
      const b = work[w + 2];
      const best = linearMatch(matcher.flat, matcher.weights, matcher.count, r, g, b);
      const mr = matcher.flat[best * 3];
      const mg = matcher.flat[best * 3 + 1];
      const mb = matcher.flat[best * 3 + 2];
      if (inCenter && px >= width && px < width * 2) {
        const o = ((py - height) * width + (px - width)) * 4;
        output.data[o] = mr;
        output.data[o + 1] = mg;
        output.data[o + 2] = mb;
        output.data[o + 3] = src[(py % height) * width * 4 + (px % width) * 4 + 3];
      }
      const er = r - mr;
      const eg = g - mg;
      const eb = b - mb;
      if (atkinson) {
        spreadRow(base, px + 1, er, eg, eb, 1 / 8);
        spreadRow(base, px + 2, er, eg, eb, 1 / 8);
        spreadRow(below, px - 1, er, eg, eb, 1 / 8);
        spreadRow(below, px, er, eg, eb, 1 / 8);
        spreadRow(below, px + 1, er, eg, eb, 1 / 8);
        spreadRow(below2, px, er, eg, eb, 1 / 8);
      } else {
        spreadRow(base, px + 1, er, eg, eb, 7 / 16);
        spreadRow(below, px - 1, er, eg, eb, 3 / 16);
        spreadRow(below, px, er, eg, eb, 5 / 16);
        spreadRow(below, px + 1, er, eg, eb, 1 / 16);
      }
    }
  }
  return output;
}

export function processImageData(source: ImageData, options: ProcessOptions): ImageData {
  if (!SEAMLESS_MODES.has(options.mode)) return ditherImageData(source, options);
  return streamDitherSeamless(source, options);
}
