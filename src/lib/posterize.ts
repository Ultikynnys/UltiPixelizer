import { LUMA } from './math';
import { rgbToHex } from './palettes';
import type { PixelSource } from './canvas';

/**
 * Adaptive posterization. Instead of fixed gray ramps, the Posterize palettes
 * derive their colors from the BaseColor texture itself: the image is
 * downsampled to a small sample, its luminance histogram is built, and each
 * level bucket picks the *average color* of its pixels. An image that is dark
 * or warm keeps that character in its posterize ramp. The stats are computed
 * once per base-texture change and the ramps are cheap to derive from them on
 * every catalog read.
 */
export type PosterizeStats = {
  /** 256 luminance bins  how many sampled pixels landed in each. */
  histogram: Uint32Array;
  /** 256 * 3  accumulated r, g, b per luminance bin. */
  colorSums: Float32Array;
  /** Total sampled pixel count. */
  total: number;
};

export function computePosterizeStats(source: PixelSource): PosterizeStats {
  const { data, width, height } = source;
  const histogram = new Uint32Array(256);
  const colorSums = new Float32Array(256 * 3);
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    let offset = y * width * 4;
    for (let x = 0; x < width; x += 1, offset += 4) {
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const bin = (r * LUMA.red + g * LUMA.green + b * LUMA.blue) | 0;
      histogram[bin] += 1;
      colorSums[bin * 3] += r;
      colorSums[bin * 3 + 1] += g;
      colorSums[bin * 3 + 2] += b;
      total += 1;
    }
  }
  return { histogram, colorSums, total };
}

/** How much luminance range an image needs before adaptive posterization is
 * meaningful. Flatter images fall back to the fixed catalog ramp, since every
 * bucket would otherwise produce the same near-identical color. */
const MIN_TONAL_SPAN = 16;

/**
 * Derives the `levels` posterize colors from the base-texture stats.
 * Buckets are equal-population slices of the luminance histogram (each holds
 * ~1/`levels` of the pixels), and each bucket's color is the mean color of the
 * pixels inside it. Without usable stats, or for images with essentially no
 * tonal range, the fixed catalog ramp is returned unchanged.
 */
export function posterizeColors(stats: PosterizeStats | null, levels: number, fallback: string[]): string[] {
  if (!stats || stats.total === 0 || !hasTonalRange(stats)) return [...fallback];
  const { histogram, colorSums, total } = stats;
  const colors: string[] = [];
  let bin = 0;
  let seen = 0;
  for (let level = 0; level < levels; level += 1) {
    const target = Math.round(((level + 1) * total) / levels);
    const start = bin;
    while (bin < 256 && seen < target) {
      seen += histogram[bin];
      bin += 1;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let index = start; index < bin; index += 1) {
      const binCount = histogram[index];
      if (binCount === 0) continue;
      r += colorSums[index * 3];
      g += colorSums[index * 3 + 1];
      b += colorSums[index * 3 + 2];
      count += binCount;
    }
    if (count > 0) {
      colors.push(rgbToHex(r / count, g / count, b / count));
    } else {
      // Empty bucket  fewer distinct luminance bins than requested levels.
      // Reuse the previous bucket's color so the ramp stays complete.
      colors.push(colors[colors.length - 1] ?? fallback[Math.min(level, fallback.length - 1)] ?? '#000000');
    }
  }
  return colors;
}

function hasTonalRange(stats: PosterizeStats): boolean {
  return percentileBin(stats.histogram, stats.total, 0.98) - percentileBin(stats.histogram, stats.total, 0.02) >= MIN_TONAL_SPAN;
}

function percentileBin(histogram: Uint32Array, total: number, fraction: number): number {
  const target = total * fraction;
  let seen = 0;
  for (let bin = 0; bin < 256; bin += 1) {
    seen += histogram[bin];
    if (seen >= target) return bin;
  }
  return 255;
}
