import { imagePixels } from './canvas';

export type LightmapSource = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type ImageDimensions = { width: number; height: number };

export function lightmapMatchesBaseColor(lightmap: ImageDimensions, baseColor: ImageDimensions): boolean {
  return lightmap.width === baseColor.width && lightmap.height === baseColor.height;
}

/** Multiplies RGB by a lightmap interpolated from white at 0 to the map at 1. */
export function applyLightmap(data: Uint8ClampedArray, lightmap: Uint8ClampedArray, contribution = 1): void {
  const amount = Math.min(1, Math.max(0, contribution));
  const pixels = Math.min(data.length, lightmap.length) / 4;
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    data[offset] *= 1 - amount + amount * lightmap[offset] / 255;
    data[offset + 1] *= 1 - amount + amount * lightmap[offset + 1] / 255;
    data[offset + 2] *= 1 - amount + amount * lightmap[offset + 2] / 255;
  }
}

/** Draws a lightmap image at target dimensions and returns its RGBA pixels. */
export function imageLightmapPixels(image: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  return imagePixels(image, width, height);
}
