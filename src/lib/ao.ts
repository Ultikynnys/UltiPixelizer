import { imagePixels, type PixelSource } from './canvas';
import { clamp01 } from './math';

export type AOFactorSource = PixelSource;

/**
 * Extracts per-pixel ambient-occlusion visibility from an image's red channel.
 * Returns a `Uint8ClampedArray` of `width * height` factors where 255 = fully
 * unoccluded (bright) and 0 = fully occluded (dark). Grayscale AO maps store
 * their value in every channel, and ORM-packed maps store occlusion in red, so
 * reading the red channel supports both.
 */
export function redChannelFactors(source: AOFactorSource, invert = false): Uint8ClampedArray {
  const { data, width, height } = source;
  const factors = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const red = data[i * 4];
    factors[i] = invert ? 255 - red : red;
  }
  return factors;
}

/**
 * Returns the AO visibility multiplier for one factor (0–255, 255 = fully
 * unoccluded) after the bias/power remap: 1 = no AO effect, 0 = fully
 * occluded. Clamped to [0, 1]. Shared by the lighting pass (applyAO) and the
 * AO inspection views so the preview always shows the occlusion the bake
 * applies  with defaults (bias 0, power 1) it is the identity (factor/255).
 *
 * - `bias` re-floors the occlusion curve (positive = deeper shadows, negative
 *   = lifted shadows). The shift is normalized by `1 − bias` so the
 *   unoccluded end stays pinned at 1  a raw `visibility − bias` would dim
 *   even fully-lit pixels.
 * - `power` reshapes the curve as an exponent (1 = as baked; >1 darkens,
 *   <1 brightens; 0 = no AO).
 */
export function aoMultiplier(factor: number, bias: number, power: number): number {
  const visibility = (factor / 255) ** power;
  if (bias === 0) return clamp01(visibility);
  // Bias re-floors the occlusion curve; dividing by (1 − bias) re-pins the
  // unoccluded end at 1 so raising bias deepens shadows without dimming
  // fully-lit pixels (a raw `visibility − bias` darkens the whole image).
  // At bias ≥ 1 the floor swallows everything below pure white.
  if (bias >= 1) return visibility >= 1 ? 1 : 0;
  return clamp01((visibility - bias) / (1 - bias));
}

/**
 * Remaps each pixel's AO occlusion with bias/power, then multiplies its RGB by
 * the remaining visibility (see aoMultiplier). Mutates `data` in place.
 */
export function applyAO(data: Uint8ClampedArray, factors: Uint8ClampedArray, bias = 0, power = 1): void {
  for (let i = 0; i < factors.length; i += 1) {
    const multiplier = aoMultiplier(factors[i], bias, power);
    const offset = i * 4;
    data[offset] = data[offset] * multiplier;
    data[offset + 1] = data[offset + 1] * multiplier;
    data[offset + 2] = data[offset + 2] * multiplier;
  }
}

/**
 * Draws an AO image at the target dimensions and returns its red-channel factor
 * map. DOM-dependent  used only from the browser.
 */
export function imageAOFactors(image: CanvasImageSource, width: number, height: number, invert = false): Uint8ClampedArray {
  return redChannelFactors({ data: imagePixels(image, width, height), width, height }, invert);
}
