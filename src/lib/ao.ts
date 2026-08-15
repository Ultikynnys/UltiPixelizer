export type AOFactorSource = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

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
 * Remaps each pixel's AO occlusion with bias/scale, then multiplies its RGB by
 * the remaining visibility. The remapped occlusion is clamped to [0, 1], so
 * pixels can never be pushed below black or brightened past their source.
 * Mutates `data` in place.
 *
 * - `bias` shifts the whole occlusion curve (−1 = fully bright, +1 = fully dark).
 * - `scale` scales occlusion strength (0 = no effect, 1 = as baked).
 */
export function applyAO(data: Uint8ClampedArray, factors: Uint8ClampedArray, bias = 0, scale = 1): void {
  for (let i = 0; i < factors.length; i += 1) {
    const occlusion = 1 - factors[i] / 255;
    const adjusted = Math.min(1, Math.max(0, bias + scale * occlusion));
    const multiplier = 1 - adjusted;
    const offset = i * 4;
    data[offset] = data[offset] * multiplier;
    data[offset + 1] = data[offset + 1] * multiplier;
    data[offset + 2] = data[offset + 2] * multiplier;
  }
}

/**
 * Draws an AO image at the target dimensions and returns its red-channel factor
 * map. DOM-dependent — used only from the browser.
 */
export function imageAOFactors(image: CanvasImageSource, width: number, height: number, invert = false): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable.');
  context.drawImage(image, 0, 0, width, height);
  const frame = context.getImageData(0, 0, width, height);
  return redChannelFactors(frame, invert);
}
