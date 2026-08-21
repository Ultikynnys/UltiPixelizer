import type { PixelSource } from './canvas';
import { LUMA } from './math';

export const LUMINOSITY_LEVELS = 256;

type ReadbackSurface = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

// Display canvases are created for frequent drawing, so requesting
// willReadFrequently only when the histogram reads them is too late: context
// attributes are fixed by the first getContext call. Keep one readback-tuned
// staging surface per source canvas instead.
const readbackSurfaces = new WeakMap<HTMLCanvasElement, ReadbackSurface>();

function readbackSurface(source: HTMLCanvasElement): ReadbackSurface {
  const cached = readbackSurfaces.get(source);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create the luminosity histogram readback context.');
  const surface = { canvas, context };
  readbackSurfaces.set(source, surface);
  return surface;
}

/** Counts opaque pixels into 256 Rec. 601 luminosity levels. Fully transparent
 * pixels do not describe visible output and are excluded. */
export function computeLuminosityHistogram(source: PixelSource): Uint32Array {
  const histogram = new Uint32Array(LUMINOSITY_LEVELS);
  for (let offset = 0; offset < source.data.length; offset += 4) {
    if (source.data[offset + 3] === 0) continue;
    const level = Math.min(255, Math.floor(
      source.data[offset] * LUMA.red
      + source.data[offset + 1] * LUMA.green
      + source.data[offset + 2] * LUMA.blue,
    ));
    histogram[level] += 1;
  }
  return histogram;
}

/** Draws one normalized bar per luminosity level. The graph uses the highest
 * populated level as its vertical scale so both sparse dither palettes and
 * continuous original images remain legible. */
export function drawLuminosityHistogram(source: HTMLCanvasElement, target: HTMLCanvasElement): void {
  const targetContext = target.getContext('2d');
  if (!targetContext || source.width === 0 || source.height === 0) {
    target.width = LUMINOSITY_LEVELS;
    target.height = 48;
    return;
  }

  const readback = readbackSurface(source);
  readback.canvas.width = source.width;
  readback.canvas.height = source.height;
  readback.context.drawImage(source, 0, 0);
  const histogram = computeLuminosityHistogram({
    data: readback.context.getImageData(0, 0, source.width, source.height).data,
    width: source.width,
    height: source.height,
  });
  const peak = histogram.reduce((maximum, count) => Math.max(maximum, count), 0);

  target.width = LUMINOSITY_LEVELS;
  target.height = 48;
  targetContext.clearRect(0, 0, target.width, target.height);
  if (peak === 0) return;

  targetContext.fillStyle = '#f1eee7';
  for (let level = 0; level < LUMINOSITY_LEVELS; level += 1) {
    const count = histogram[level];
    if (count === 0) continue;
    const barHeight = Math.max(1, Math.round((count / peak) * target.height));
    targetContext.fillRect(level, target.height - barHeight, 1, barHeight);
  }
}
