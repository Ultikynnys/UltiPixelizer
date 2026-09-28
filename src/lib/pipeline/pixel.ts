/**
 * Pure, DOM-free resample + pixelation core.
 *
 * This is the single implementation shared by the web app (wrapped by
 * `canvas.ts`, which converts canvas <-> PixelBuffer) and the CLI, so both
 * pipelines resample to identical pixels. `render2d.ts` and `cli/compose.ts`
 * both reach the resample math through here.
 *
 * Nearest / bilinear upscales mirror the browser's `imageSmoothingEnabled`
 * semantics; downscales use an area box filter (closer to a filtered
 * `drawImage` than point-sampling and keeps the dither input free of aliasing).
 */

export type PixelBuffer = { data: Uint8ClampedArray; width: number; height: number };
export type UpscaleMethod = 'nearest' | 'bilinear';

/** Expands a per-pixel scalar factor into a grayscale RGBA buffer (r=g=b=factor,
 * a=255). `valueAt` returns the 0..255 byte for pixel `i`, or null to leave the
 * pixel transparent. The one implementation behind the grayscale maps in
 * `canvas.factorsToCanvas` and the composition core. */
export function factorRgba(width: number, height: number, valueAt: (index: number) => number | null): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const value = valueAt(i);
    if (value === null) continue;
    const offset = i * 4;
    out[offset] = value;
    out[offset + 1] = value;
    out[offset + 2] = value;
    out[offset + 3] = 255;
  }
  return out;
}

/** Output grid for a target pixel-width, height scaled to keep the aspect ratio
 * (1px floor). */
export function computeOutputDimensions(resolution: number, source: { width: number; height: number }): { width: number; height: number } {
  return { width: resolution, height: Math.max(1, Math.round(resolution * source.height / source.width)) };
}

function sampleNearest(source: PixelBuffer, out: PixelBuffer): void {
  const { width: sw, height: sh, data: src } = source;
  const { width: dw, height: dh, data: dst } = out;
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
}

function sampleBilinear(source: PixelBuffer, out: PixelBuffer): void {
  const { width: sw, height: sh, data: src } = source;
  const { width: dw, height: dh, data: dst } = out;
  for (let y = 0; y < dh; y += 1) {
    const fy = dh > 1 ? (y + 0.5) * sh / dh - 0.5 : 0;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = Math.min(1, Math.max(0, fy - y0));
    for (let x = 0; x < dw; x += 1) {
      const fx = dw > 1 ? (x + 0.5) * sw / dw - 0.5 : 0;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = Math.min(1, Math.max(0, fx - x0));
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const di = (y * dw + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx;
        const bottom = src[i10 + c] * (1 - wx) + src[i11 + c] * wx;
        dst[di + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
}

/** Area-average (box) filter  used for downscales. */
function sampleBox(source: PixelBuffer, out: PixelBuffer): void {
  const { width: sw, height: sh, data: src } = source;
  const { width: dw, height: dh, data: dst } = out;
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < dw; x += 1) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const si = (sy * sw + sx) * 4;
          r += src[si];
          g += src[si + 1];
          b += src[si + 2];
          a += src[si + 3];
          n += 1;
        }
      }
      const di = (y * dw + x) * 4;
      dst[di] = Math.round(r / n);
      dst[di + 1] = Math.round(g / n);
      dst[di + 2] = Math.round(b / n);
      dst[di + 3] = Math.round(a / n);
    }
  }
}

/** Resizes to an exact size. Downscales use the box filter; upscales use the
 * chosen method (nearest keeps blocks crisp, bilinear smooths). */
export function resize(source: PixelBuffer, width: number, height: number, method: UpscaleMethod): PixelBuffer {
  const out: PixelBuffer = { data: new Uint8ClampedArray(width * height * 4), width, height };
  const downscaling = width < source.width || height < source.height;
  if (downscaling) sampleBox(source, out);
  else if (method === 'bilinear') sampleBilinear(source, out);
  else sampleNearest(source, out);
  return out;
}

/** Nearest-neighbor resize to an exact size. */
export function resizeNearest(source: PixelBuffer, width: number, height: number): PixelBuffer {
  const out: PixelBuffer = { data: new Uint8ClampedArray(width * height * 4), width, height };
  sampleNearest(source, out);
  return out;
}

/** Downsamples by `percent`% with nearest, then upscales back with `method` 
 * the block filter driven by a single 0..80 percentage (0 = off). */
export function pixelate(source: PixelBuffer, percent: number, method: UpscaleMethod): PixelBuffer {
  if (percent <= 0) return source;
  const scale = 1 - percent / 100;
  const sw = Math.max(1, Math.round(source.width * scale));
  const sh = Math.max(1, Math.round(source.height * scale));
  const small = resizeNearest(source, sw, sh);
  return resize(small, source.width, source.height, method);
}

/** Output-sized resample followed by pixelation  the entry the dithered pane
 * uses. */
export function resampleAndPixelate(source: PixelBuffer, width: number, height: number, percent: number, method: UpscaleMethod): PixelBuffer {
  return pixelate(resize(source, width, height, method), percent, method);
}
