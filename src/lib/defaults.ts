export const DEFAULT_SUN_INTENSITY = 1;
export const DEFAULT_AMBIENT_INTENSITY = 0.2;
/** Normal-map influence on the lightmap bake (0..1). */
export const DEFAULT_NORMAL_STRENGTH = 1;
/** UV-stretch heatmap sensitivity: scales each face's distortion (octaves)
 * before it maps to the blue→red heatmap, so higher values make small
 * distortions read more color. 1 is the identity. */
export const DEFAULT_UV_STRETCH_SENSITIVITY = 1;
/** Angle (degrees) below which adjacent faces share a smoothed vertex normal. */
export const DEFAULT_SMOOTH_ANGLE = 30;
