import { DEFAULT_WORLDSPACE_SCALE, UV_SCALE_MAX, UV_SCALE_MIN, WORLDSPACE_SCALE_MAX, WORLDSPACE_SCALE_MIN } from './defaults';
import { hexToRgb } from './palettes';
import { clamp, LUMA, type RGB } from './math';
import { createWasmMatcher } from './wasmLinearMatch';

export type DitherMode = 'floyd' | 'atkinson' | 'ordered' | 'halftone' | 'cross' | 'stripes' | 'noise' | 'checker' | 'none';

export type ProcessOptions = {
  palette: string[];
  mode: DitherMode;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  stripeAngle: number;
  seed: number;
  /** Pattern sampling space: 'uv' samples the pattern in image space (one
   * threshold cell per output pixel); 'world' projects it triplanar onto the
   * bake surface. Only coordinate-pattern modes honor this. */
  patternSpace?: 'uv' | 'world';
  /** Pattern cells per pixel in UV space. */
  uvScale?: number;
  /** XYZ world position for each output texel, stored as three floats per
   * pixel. Required when patternSpace is 'world'. */
  worldPositions?: Float32Array | null;
  /** World-space surface normal for each output texel, three floats per
   * pixel. Required when patternSpace is 'world' for the triplanar projection. */
  worldNormals?: Float32Array | null;
  /** Marks texels covered by bake geometry. Required with worldPositions so
   * uncovered UV-space pixels are never interpreted as the world origin. */
  worldPositionCoverage?: Uint8Array | null;
  /** Ordered-pattern cells per world unit. */
  worldspaceScale?: number;
  /** Per-pixel lighting color for halftone dots, stored as normalized RGB
   * triples. AO is folded into these channels before tone adjustment. Read at
   * each dot's center; when absent, no lighting-dot layer is printed. */
  lighting?: Float32Array | null;
};

const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];


const thresholdModes = new Set<DitherMode>(['ordered', 'cross', 'stripes', 'noise', 'checker']);

/** True for coordinate-pattern modes. Error diffusion, halftone and 'none'
 * have no pattern coordinates. */
export function isPatternMode(mode: DitherMode): boolean {
  return thresholdModes.has(mode);
}

/** True for modes that can sample in world space: the coordinate-pattern
 * modes and halftone. */
export function isWorldCapable(mode: DitherMode): boolean {
  return isPatternMode(mode) || mode === 'halftone';
}

// Base halftone dot-cell size in pixels; the UV scale (or world scale in
// world space) is what sizes the dots.
const HALFTONE_CELL = 4;

type WorldHalftoneSamples = {
  planes: Uint8Array;
  projectedU: Float64Array;
  projectedV: Float64Array;
  nearest: (plane: number, u: number, v: number) => number;
};

function worldHalftoneProjection(x: number, y: number, z: number, nx: number, ny: number, nz: number, scale: number): readonly [number, number, number] {
  if (Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)) return [0, y * scale, z * scale];
  if (Math.abs(ny) >= Math.abs(nz)) return [1, x * scale, z * scale];
  return [2, x * scale, y * scale];
}

/** Connects world-space dot centers back to covered UV texels. Bucketing by
 * projected lattice cell keeps each center lookup local while preserving a
 * deterministic lowest-index tie break. */
function createWorldHalftoneSamples(positions: Float32Array, normals: Float32Array, coverage: Uint8Array, scale: number): WorldHalftoneSamples {
  const pixelCount = coverage.length;
  const planes = new Uint8Array(pixelCount);
  const projectedU = new Float64Array(pixelCount);
  const projectedV = new Float64Array(pixelCount);
  const buckets = new Map<string, number[]>();
  const bucketKey = (plane: number, col: number, row: number): string => `${plane}:${col}:${row}`;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (coverage[pixel] === 0) continue;
    const offset = pixel * 3;
    const [plane, u, v] = worldHalftoneProjection(
      positions[offset], positions[offset + 1], positions[offset + 2],
      normals[offset], normals[offset + 1], normals[offset + 2],
      scale,
    );
    planes[pixel] = plane;
    projectedU[pixel] = u;
    projectedV[pixel] = v;
    const key = bucketKey(plane, Math.floor(u), Math.floor(v));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(pixel);
    else buckets.set(key, [pixel]);
  }

  const centerSamples = new Map<string, number>();
  const nearest = (plane: number, u: number, v: number): number => {
    // Dot centers always land on integer or half-integer lattice coordinates.
    // Many texels share each center, so resolve its UV source once. Without
    // this cache, a dense world cell rescans the same large bucket per texel.
    const centerKey = `${plane}:${u * 2}:${v * 2}`;
    const cached = centerSamples.get(centerKey);
    if (cached !== undefined) return cached;

    const centerCol = Math.floor(u);
    const centerRow = Math.floor(v);
    let bestPixel = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
        const bucket = buckets.get(bucketKey(plane, centerCol + colOffset, centerRow + rowOffset));
        if (!bucket) continue;
        for (const pixel of bucket) {
          const du = projectedU[pixel] - u;
          const dv = projectedV[pixel] - v;
          const distance = du * du + dv * dv;
          if (distance < bestDistance || (distance === bestDistance && pixel < bestPixel)) {
            bestDistance = distance;
            bestPixel = pixel;
          }
        }
      }
    }
    if (bestPixel < 0) throw new Error('World-space halftone center has no covered source texel.');
    centerSamples.set(centerKey, bestPixel);
    return bestPixel;
  };

  return { planes, projectedU, projectedV, nearest };
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Resolves and validates the world-space pattern scale in cells per unit. */
function worldspaceScaleValue(scale: number | undefined): number {
  const value = scale ?? DEFAULT_WORLDSPACE_SCALE;
  if (!Number.isFinite(value) || value < WORLDSPACE_SCALE_MIN || value > WORLDSPACE_SCALE_MAX) {
    throw new Error(`worldspaceScale must be between ${WORLDSPACE_SCALE_MIN} and ${WORLDSPACE_SCALE_MAX} cells per unit.`);
  }
  return value;
}

/** Triplanar world-space threshold for any coordinate-pattern mode. The
 * pattern is projected from each of the three axis planes (X → YZ, Y → XZ,
 * Z → XY) with world coordinates scaled by `scale` cells per world unit, and
 * blended by the squared surface-normal components, so the pattern follows
 * the surface instead of slicing through it at a fixed world orientation. A
 * degenerate (zero-length) normal yields the neutral 0.5 threshold. */
export function worldspacePatternThreshold(mode: DitherMode, x: number, y: number, z: number, nx: number, ny: number, nz: number, scale = DEFAULT_WORLDSPACE_SCALE, stripeAngle = 45, seed = 0): number {
  const resolved = worldspaceScaleValue(scale);
  const wx = nx * nx;
  const wy = ny * ny;
  const wz = nz * nz;
  const sum = wx + wy + wz;
  if (sum === 0) return 0.5;
  return (
    patternThreshold(mode, y * resolved, z * resolved, stripeAngle, seed) * wx
    + patternThreshold(mode, x * resolved, z * resolved, stripeAngle, seed) * wy
    + patternThreshold(mode, x * resolved, y * resolved, stripeAngle, seed) * wz
  ) / sum;
}

export function patternThreshold(mode: DitherMode, x: number, y: number, stripeAngle = 45, seed = 0): number {
  switch (mode) {
    case 'ordered':
      return BAYER_4[positiveModulo(Math.floor(y), 4)][positiveModulo(Math.floor(x), 4)] / 15;
    case 'cross': {
      const row = positiveModulo(Math.floor(y), 4);
      const col = positiveModulo(Math.floor(x), 4);
      const horizontal = row === 1 || row === 2;
      const vertical = col === 1 || col === 2;
      return horizontal && vertical ? 0.08 : horizontal || vertical ? 0.38 : 0.88;
    }
    case 'stripes': {
      const radians = (stripeAngle * Math.PI) / 180;
      const frequency = 4;
      const projection = (x * Math.cos(radians) + y * Math.sin(radians)) / frequency;
      return projection - Math.floor(projection);
    }
    case 'noise': {
      // Noise always spawns at 1 px cells; the UV scale (or world scale in
      // world space) is what sizes the grain.
      const cellX = Math.floor(x);
      const cellY = Math.floor(y);
      let hash = Math.imul(cellX, 374761393) + Math.imul(cellY, 668265263) + Math.imul(seed | 0, 2246822519);
      hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
      hash ^= hash >>> 16;
      return (hash >>> 0) / 4294967296;
    }
    case 'checker':
      return positiveModulo(Math.floor(x) + Math.floor(y), 2) === 0 ? 0.2 : 0.8;
    default:
      return 0.5;
  }
}

export function nearestColor(color: RGB, palette: RGB[]): RGB {
  if (palette.length === 0) throw new Error('nearestColor requires a non-empty palette.');
  let best = palette[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of palette) {
    const distance = lumaDistanceSquared(color[0], color[1], color[2], candidate[0], candidate[1], candidate[2], LUMA.red, LUMA.green, LUMA.blue);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Brightness/contrast/saturation tone parameters for `adjustColor` and the
 * dithering hot loops  the loops share the derivation (and the per-channel
 * blend, via `toneAdjustPixel`) so the expression never drifts. */
function toneAdjustParams(brightness: number, contrast: number, saturation: number): { brightnessOffset: number; contrastFactor: number; saturationFactor: number } {
  return {
    brightnessOffset: brightness * 2.55,
    contrastFactor: (259 * (contrast + 255)) / (255 * (259 - contrast)),
    saturationFactor: 1 + saturation / 100,
  };
}

/** Module scratch for `toneAdjustPixel`  the dither hot loops run per pixel,
 * so the shared result is written here and read immediately (no per-pixel
 * allocation), the same pattern as the module-level scratch vectors in the
 * bake rasterizers. `adjustColor` allocates its own target instead. */
const _toneScratch: RGB = [0, 0, 0];

/** Tone-adjusts one pixel: brightness offset, contrast factor, then the
 * LUMA-weighted saturation blend, clamped to 0..255. The single source of the
 * per-channel expression  `adjustColor`, the `ditherImageData` work-buffer
 * pass, and `streamDitherSeamless`'s initRow all produce identical values
 * through here. Writes into `out` when given (a fresh tuple for `adjustColor`,
 * the module scratch for the hot loops) and returns it. */
function toneAdjustPixel(
  params: { brightnessOffset: number; contrastFactor: number; saturationFactor: number },
  r: number,
  g: number,
  b: number,
  out?: RGB,
): RGB {
  const target = out ?? _toneScratch;
  const { brightnessOffset, contrastFactor, saturationFactor } = params;
  const red = contrastFactor * (r - 128) + 128 + brightnessOffset;
  const green = contrastFactor * (g - 128) + 128 + brightnessOffset;
  const blue = contrastFactor * (b - 128) + 128 + brightnessOffset;
  const gray = red * LUMA.red + green * LUMA.green + blue * LUMA.blue;
  target[0] = clamp(gray + (red - gray) * saturationFactor, 0, 255);
  target[1] = clamp(gray + (green - gray) * saturationFactor, 0, 255);
  target[2] = clamp(gray + (blue - gray) * saturationFactor, 0, 255);
  return target;
}

/** LUMA-weighted squared distance between a query color and a candidate.
 * `wr/wg/wb` carry the weights so the linear scan and the k-d query use their
 * f32-flattened matcher weights and `nearestColor` uses the double constants 
 * each caller keeps its exact arithmetic. */
function lumaDistanceSquared(r: number, g: number, b: number, cr: number, cg: number, cb: number, wr: number, wg: number, wb: number): number {
  const dr = r - cr;
  const dg = g - cg;
  const db = b - cb;
  return dr * dr * wr + dg * dg * wg + db * db * wb;
}

export function adjustColor(color: RGB, brightness: number, contrast: number, saturation: number): RGB {
  const out: RGB = [0, 0, 0];
  toneAdjustPixel(toneAdjustParams(brightness, contrast, saturation), color[0], color[1], color[2], out);
  return out;
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
  tree: KDTree | null;
};

/** Flat median-split k-d tree over the palette's raw RGB coordinates. The
 * LUMA weights enter only the distance/prune arithmetic, so the split planes
 * are the same as in scaled space.
 *
 * Typed arrays instead of node objects: the matcher answers one query per
 * pixel, and the recursive object version measured ~3× slower than the tight
 * linear scan on the seamless path (object derefs + a per-pixel BestMatch
 * allocation), so the tree is built once per dither call and queried
 * iteratively with zero per-query allocation. */
type KDTree = {
  /** Split axis (0/1/2 = r/g/b) per node. */
  axes: Int8Array;
  /** Split coordinate per node. */
  values: Float32Array;
  /** Palette index each node holds. */
  indexes: Int32Array;
  /** Left/right child node ids; -1 = absent. */
  left: Int32Array;
  right: Int32Array;
  /** Query scratch. Median split keeps the tree balanced (depth ≈ ⌈log2 P⌉),
   * so 64 slots cover any palette the app allows (≤ 256 colors). */
  stack: Int32Array;
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
  let tree: KDTree | null = null;
  if (count > KD_THRESHOLD) {
    const indices = new Int32Array(count);
    for (let i = 0; i < count; i += 1) indices[i] = i;
    tree = buildKDTree(indices, flat, count);
  }
  return { count, flat, weights, tree };
}

function buildKDTree(indices: Int32Array, flat: Float32Array, count: number): KDTree {
  const axes = new Int8Array(count);
  const values = new Float32Array(count);
  const indexes = new Int32Array(count);
  const left = new Int32Array(count);
  const right = new Int32Array(count);
  left.fill(-1);
  right.fill(-1);
  // Preorder ids: the node for a span is created before its children, so the
  // arrays fill left-to-right and every child id points at a created slot.
  // Same median-split construction as the original recursive build.
  let next = 0;
  const build = (start: number, end: number, axis: number): number => {
    const slice = indices.subarray(start, end);
    slice.sort((a, b) => flat[a * 3 + axis] - flat[b * 3 + axis]);
    const mid = start + ((end - start) >> 1);
    const node = next;
    next += 1;
    const index = indices[mid];
    axes[node] = axis;
    values[node] = flat[index * 3 + axis];
    indexes[node] = index;
    if (start < mid) left[node] = build(start, mid, (axis + 1) % 3);
    if (mid + 1 < end) right[node] = build(mid + 1, end, (axis + 1) % 3);
    return node;
  };
  build(0, count, 0);
  return { axes, values, indexes, left, right, stack: new Int32Array(64) };
}

/** Exact nearest-color query over the flat tree. The node's own point is
 * evaluated with the linear-scan distance expression; a subtree is entered
 * only when the slab lower bound clears the best distance with a margin, so
 * float rounding can never skip a true winner. Exact distance ties resolve to
 * the lowest palette index, matching the linear scan's first-minimum
 * behavior.
 *
 * Iterative with a per-matcher stack  no recursion and no per-query
 * allocation. The far subtree is pruned against the best distance known at
 * push time; that distance can only shrink afterwards, so pushing early is
 * conservative (a superset of the recursive order's visits) and the result
 * is the same argmin. */
function queryKD(tree: KDTree, flat: Float32Array, weights: Float32Array, r: number, g: number, b: number): number {
  const { axes, values, indexes, left, right, stack } = tree;
  let sp = 0;
  let node = 0;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (;;) {
    const index = indexes[node];
    const distance = lumaDistanceSquared(r, g, b, flat[index * 3], flat[index * 3 + 1], flat[index * 3 + 2], weights[0], weights[1], weights[2]);
    if (distance < bestDistance || (distance === bestDistance && index < bestIndex)) {
      bestDistance = distance;
      bestIndex = index;
    }
    const axis = axes[node];
    const split = values[node];
    const v = axis === 0 ? r : axis === 1 ? g : b;
    const near = v < split ? left[node] : right[node];
    const far = near === left[node] ? right[node] : left[node];
    if (far !== -1) {
      const diff = v - split;
      if (weights[axis] * diff * diff < bestDistance * 1.000001) {
        stack[sp] = far;
        sp += 1;
      }
    }
    if (near !== -1) {
      node = near;
      continue;
    }
    if (sp === 0) break;
    sp -= 1;
    node = stack[sp];
  }
  return bestIndex;
}

function linearMatch(flat: Float32Array, weights: Float32Array, count: number, r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    const distance = lumaDistanceSquared(r, g, b, flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2], weights[0], weights[1], weights[2]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function matchPalette(m: PaletteMatcher, r: number, g: number, b: number): number {
  if (m.tree) return queryKD(m.tree, m.flat, m.weights, r, g, b);
  return linearMatch(m.flat, m.weights, m.count, r, g, b);
}

export function ditherImageData(source: ImageData, options: ProcessOptions): ImageData {
  // The 'none' mode performs no adjustment and no palette mapping  the
  // caller's lighting pass (lightmap + AO multiply) is the only modification.
  if (options.mode === 'none') return source;
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const data = output.data;
  const work = new Float32Array(source.width * source.height * 3);
  const matcher = buildPaletteMatcher(options.palette);
  let darkestPaletteIndex = 0;
  let darkestPaletteLuminance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < matcher.count; index += 1) {
    const offset = index * 3;
    const luminance = matcher.flat[offset] * LUMA.red + matcher.flat[offset + 1] * LUMA.green + matcher.flat[offset + 2] * LUMA.blue;
    if (luminance < darkestPaletteLuminance) {
      darkestPaletteLuminance = luminance;
      darkestPaletteIndex = index;
    }
  }
  const { width, height } = source;
  const strength = options.strength;
  const uvScale = options.uvScale ?? 1;
  if (!Number.isFinite(uvScale) || uvScale < UV_SCALE_MIN || uvScale > UV_SCALE_MAX) {
    throw new Error(`uvScale must be between ${UV_SCALE_MIN} and ${UV_SCALE_MAX} cells per pixel.`);
  }
  const isThreshold = thresholdModes.has(options.mode);
  const isHalftone = options.mode === 'halftone';
  const isFloyd = options.mode === 'floyd';
  const isAtkinson = options.mode === 'atkinson';
  const tone = toneAdjustParams(options.brightness, options.contrast, options.saturation);
  const pixelCount = width * height;
  if (options.lighting && options.lighting.length !== pixelCount * 3) {
    throw new Error(`halftone lighting requires ${pixelCount * 3} normalized RGB values.`);
  }
  const adjustedLighting = options.lighting ? new Float32Array(options.lighting.length) : null;
  if (adjustedLighting) {
    const adjusted: RGB = [0, 0, 0];
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const offset = pixel * 3;
      toneAdjustPixel(
        tone,
        options.lighting![offset] * 255,
        options.lighting![offset + 1] * 255,
        options.lighting![offset + 2] * 255,
        adjusted,
      );
      adjustedLighting[offset] = adjusted[0] / 255;
      adjustedLighting[offset + 1] = adjusted[1] / 255;
      adjustedLighting[offset + 2] = adjusted[2] / 255;
    }
  }
  const useWorldPattern = options.patternSpace === 'world' && isThreshold;
  const useWorldHalftone = options.patternSpace === 'world' && isHalftone;
  const useWorld = useWorldPattern || useWorldHalftone;
  // Resolved once up front: the per-pixel triplanar sampling reuses it, and
  // an invalid scale fails fast before any pixel work.
  const worldScale = useWorld ? worldspaceScaleValue(options.worldspaceScale) : 0;
  if (useWorld) {
    if (!options.worldPositions || options.worldPositions.length !== pixelCount * 3) {
      throw new Error(`worldspace pattern requires ${pixelCount * 3} world-position values.`);
    }
    if (!options.worldPositionCoverage || options.worldPositionCoverage.length !== pixelCount) {
      throw new Error(`worldspace pattern requires ${pixelCount} world-position coverage values.`);
    }
    if (!options.worldNormals || options.worldNormals.length !== pixelCount * 3) {
      throw new Error(`worldspace pattern requires ${pixelCount * 3} world-normal values.`);
    }
  }
  const worldHalftoneSamples = useWorldHalftone
    ? createWorldHalftoneSamples(options.worldPositions!, options.worldNormals!, options.worldPositionCoverage!, worldScale)
    : null;

  // Halftone stacks two dot screens with no paper: the base color as two
  // offset layers of dots (fully covering the frame) with the AO×lightmap
  // halftone multiplied on top as black ink, so no ink/paper extremes are
  // precomputed.

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    const adjusted = toneAdjustPixel(tone, data[index], data[index + 1], data[index + 2]);
    const w = pixel * 3;
    work[w] = adjusted[0];
    work[w + 1] = adjusted[1];
    work[w + 2] = adjusted[2];
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
        // Image-space patterns sample one threshold cell per output pixel.
        // World-space patterns sample interpolated XYZ only for covered UV
        // texels; uncovered texture pixels receive no invented coordinate.
        let threshold = 0.5;
        if (useWorldPattern) {
          if (options.worldPositionCoverage![pixel] !== 0) {
            const position = pixel * 3;
            threshold = worldspacePatternThreshold(
              options.mode,
              options.worldPositions![position],
              options.worldPositions![position + 1],
              options.worldPositions![position + 2],
              options.worldNormals![position],
              options.worldNormals![position + 1],
              options.worldNormals![position + 2],
              worldScale,
              options.stripeAngle,
              options.seed,
            );
          }
        } else {
          threshold = patternThreshold(options.mode, x * uvScale, y * uvScale, options.stripeAngle, options.seed);
        }
        const offset = (threshold - 0.5) * 96 * strength;
        r = clamp(r + offset, 0, 255);
        g = clamp(g + offset, 0, 255);
        b = clamp(b + offset, 0, 255);
      }

      let matchedIndex: number;
      if (isHalftone && (!useWorldHalftone || options.worldPositionCoverage![pixel] !== 0)) {
        // Two stacked dot screens, no paper:
        // 1. Base-color dots: two layers at a half-cell offset (cell centers
        //    and cell corners) so the second layer fills the first's gaps and
        //    the frame is fully covered. Each dot is a circle of the base
        //    color sampled at its center; the radius is driven by the base
        //    color's own luminance, floored at cell/2 so the layers always
        //    overlap.
        // 2. Lighting dots: the tone-adjusted AO×lightmap halftone (darkest
        //    palette ink, radius from luminance at the dot center) multiplied
        //    on top of the base dots.
        // Dither strength deliberately does NOT touch the dots: halftone is
        // shading, not error diffusion.
        const cell = HALFTONE_CELL;
        // Pattern coordinates: image space uses pixel centers with the
        // halftone cell; world space projects the world position onto the
        // dominant normal plane, scaled by cells per world unit (cell = 1).
        let plane = 0;
        let u: number;
        let v: number;
        let patternCell: number;
        if (worldHalftoneSamples) {
          plane = worldHalftoneSamples.planes[pixel];
          u = worldHalftoneSamples.projectedU[pixel];
          v = worldHalftoneSamples.projectedV[pixel];
          patternCell = 1;
        } else {
          u = x + 0.5;
          v = y + 0.5;
          patternCell = cell / uvScale;
        }
        const maxRadius = Math.hypot(patternCell / 2, patternCell / 2);
        const sampleAt = (centerU: number, centerV: number): number => {
          if (worldHalftoneSamples) return worldHalftoneSamples.nearest(plane, centerU, centerV);
          const sampleX = clamp(Math.round(centerU), 0, width - 1);
          const sampleY = clamp(Math.round(centerV), 0, height - 1);
          return sampleY * width + sampleX;
        };
        const luminanceAt = (index: number): number => (work[index * 3] * LUMA.red + work[index * 3 + 1] * LUMA.green + work[index * 3 + 2] * LUMA.blue) / 255;
        const baseColorAt = (index: number): number => matchPalette(matcher, work[index * 3], work[index * 3 + 1], work[index * 3 + 2]);
        const baseRadius = (luminance: number): number => Math.max(patternCell / 2, maxRadius * (1 - luminance));

        const row = Math.floor(v / patternCell);
        const col = Math.floor(u / patternCell);

        // Layer A: dots at cell centers.
        const centerAU = (col + 0.5) * patternCell;
        const centerAV = (row + 0.5) * patternCell;
        const indexA = sampleAt(centerAU, centerAV);
        const inA = Math.hypot(u - centerAU, v - centerAV) <= baseRadius(luminanceAt(indexA));

        // Layer B: dots at cell corners (half a cell offset in both axes).
        const centerBU = col * patternCell;
        const centerBV = row * patternCell;
        const indexB = sampleAt(centerBU, centerBV);
        const inB = Math.hypot(u - centerBU, v - centerBV) <= baseRadius(luminanceAt(indexB));

        // Lighting dot (staggered lattice): darkest palette ink, radius from
        // tone-adjusted AO×lightmap luminance at the dot center.
        const rowOdd = row % 2 === 1;
        const lightCenterU = rowOdd
          ? (u - col * patternCell < patternCell / 2 ? col : col + 1) * patternCell
          : (col + 0.5) * patternCell;
        const lightCenterV = (row + 0.5) * patternCell;
        const lightIndex = sampleAt(lightCenterU, lightCenterV);
        const lightOffset = lightIndex * 3;
        // Equal-channel intensity is intentional here: unlike perceptual LUMA,
        // it lets saturation changes in a colored lightmap alter dot coverage.
        const lightFactor = adjustedLighting
          ? (adjustedLighting[lightOffset] + adjustedLighting[lightOffset + 1] + adjustedLighting[lightOffset + 2]) / 3
          : 1;
        const inLightDot = Math.hypot(u - lightCenterU, v - lightCenterV) <= maxRadius * (1 - lightFactor);

        // The lighting layer uses the darkest actual palette entry; otherwise
        // the covering base dot supplies its center-sampled palette color.
        matchedIndex = inLightDot ? darkestPaletteIndex : inA ? baseColorAt(indexA) : inB ? baseColorAt(indexB) : matchPalette(matcher, r, g, b);
      } else {
        matchedIndex = matchPalette(matcher, r, g, b);
      }
      const outputIndex = pixel * 4;
      const mr = matcher.flat[matchedIndex * 3];
      const mg = matcher.flat[matchedIndex * 3 + 1];
      const mb = matcher.flat[matchedIndex * 3 + 2];
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
 * boundary. The classic fix  pad the source with exact copies of itself,
 * dither the padded canvas, then crop back to the original bounds  lets the
 * border errors wrap into the opposite edge, so the tile dithers as if it
 * were part of an infinite tiling. Threshold and halftone modes are stateless
 * (per-pixel / per-cell), so they need no padding.
 *
 * The canonical seamless grid is 3×3 (9 tiles). Diffusion flows only down and
 * right, so the center tile never reads the bottom strip (rows 2h..3h−1) or
 * the right strip below the top row  but the top strip must extend to 3w:
 * the tile's top-right pixel receives the 3/16 down-left spread of column 2w
 * (verified: a 3×2 grid is byte-identical to the 3×3 for floyd and atkinson,
 * while 2×2/2×3 differ). The grid is pure re-indexing  padded pixel (px, py)
 * shows source (px mod w, py mod h)  so `streamDitherSeamless` scans the
 * virtual 3w×2h grid with a rolling work buffer and writes only the center
 * tile. That keeps the working set at ~KB instead of the ~750 MB the padded
 * buffers need at 2k, and the per-slot accumulation order is unchanged
 * (adjusted value first, then error arrivals in scan order), so the output is
 * byte-identical to the padded implementation. */
const SEAMLESS_MODES = new Set<DitherMode>(['floyd', 'atkinson']);

/** Streaming seamless error diffusion  see the comment above. */
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
  // byte-identical with ditherImageData's matchPalette. The k-d tree is
  // deliberately NOT used here: error-diffusion work colors sit off the
  // palette gamut, so the far-subtree prune rarely engages and the query
  // degenerates to O(P) visits. Measured at 1k (floyd, 256 colors): the
  // iterative typed-array queryKD took 10.5s on rgb332 and 33.2s on the
  // grayscale ramp vs 5.5s for the wasm SIMD scan (the old recursive object
  // tree measured 3x slower at 2k for the same reason). The linear scan wins
  // on every palette, so it stays the seamless-path match strategy: the wasm
  // f64x2 scan when loaded (byte-identical to linearMatch), the JS scan over
  // the load window.
  const matcher = buildPaletteMatcher(options.palette);
  // The wasm module runs the ENTIRE seamless pass when loaded (byte-identical
  // to this function, see src-wasm/src/lib.rs `dither_seamless`). The JS
  // implementation below stays as the fallback for the load window, load
  // failures, and artifacts built before the export existed.
  const wasmMatcher = createWasmMatcher(matcher.flat, matcher.weights, matcher.count);
  const tone = toneAdjustParams(options.brightness, options.contrast, options.saturation);
  if (wasmMatcher) {
    const wasmOut = wasmMatcher.seamless(source, options, tone);
    if (wasmOut) {
      wasmMatcher.dispose();
      return wasmOut;
    }
  }

  const strength = options.strength;

  /** Writes the tone-adjusted colors of virtual grid row `py` into `slot`.
   * Runs one row ahead of the scan so every slot the diffusion touches is
   * initialized exactly as the padded implementation initialized it. */
  const initRow = (slot: number, py: number): void => {
    const sy = py % height;
    const srcRow = sy * width * 4;
    const base = slot * gridWidth * 3;
    for (let px = 0; px < gridWidth; px += 1) {
      const s = srcRow + (px % width) * 4;
      const adjusted = toneAdjustPixel(tone, src[s], src[s + 1], src[s + 2]);
      const w = base + px * 3;
      work[w] = adjusted[0];
      work[w + 1] = adjusted[1];
      work[w + 2] = adjusted[2];
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
      const best = wasmMatcher ? wasmMatcher.match(r, g, b) : linearMatch(matcher.flat, matcher.weights, matcher.count, r, g, b);
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
  wasmMatcher?.dispose();
  return output;
}

export function processImageData(source: ImageData, options: ProcessOptions): ImageData {
  if (!SEAMLESS_MODES.has(options.mode)) return ditherImageData(source, options);
  return streamDitherSeamless(source, options);
}
