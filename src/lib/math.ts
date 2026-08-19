/** 8-bit RGB color tuple, 0–255 per channel. Shared by the dither and bake
 * pipelines so the color-vector shape lives in one place. */
export type RGB = [number, number, number];

/** Clamps a value into [min, max]. Shared by every color/lighting clamp in the renderer. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps a value into [0, 1]. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Combines ambient and directional illumination additively. Each term is clamped
 * to [0, 1] before summing; a sun intensity above 1 overexposes, saturating the
 * sun term at full brightness for faces angled beyond the falloff. The total is
 * clamped again to keep white as the ceiling. Shared by the lightmap bake and
 * its worker/GPU raster mirror so both paths light identically.
 */
export function combineLight(
  ambientColor: RGB,
  sunColor: RGB,
  ambientScale: number,
  sunScale: number,
  lambert: number,
  sunVisibility: number,
): RGB {
  return [0, 1, 2].map((channel) => {
    const ambient = clamp01(ambientColor[channel] * ambientScale);
    const sun = clamp01(sunColor[channel] * sunScale * lambert * sunVisibility);
    return clamp01(ambient + sun);
  }) as RGB;
}
