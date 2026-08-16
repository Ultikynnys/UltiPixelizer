export const DEFAULT_SUN_INTENSITY = 1;
export const DEFAULT_AMBIENT_INTENSITY = 0.7;
/** Angle (degrees) below which adjacent faces share a smoothed vertex normal. */
export const DEFAULT_SMOOTH_ANGLE = 30;

/**
 * Minimum ambient fill on the [0, 1] intensity scale. Keeps shadowed regions from
 * collapsing to pure black when the ambient intensity slider is at 0.00 — the sun
 * term is independent and never affected. Only applies while ambient is enabled;
 * disabling ambient still means truly no ambient.
 */
export const AMBIENT_FLOOR = 0.06;

/**
 * Default resolution (longest side in texels) for generated AO and lightmap maps.
 * Lighting and occlusion are smooth, low-frequency signals, so a coarse default
 * bakes fast and is bilinearly upscaled to the base color at apply time. The user
 * can raise it for finer maps via the bake resolution control.
 */
export const DEFAULT_BAKE_RESOLUTION = 64;
