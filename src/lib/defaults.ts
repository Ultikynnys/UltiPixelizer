export const DEFAULT_SUN_INTENSITY = 1;
export const DEFAULT_AMBIENT_INTENSITY = 0.2;
/** Normal-map influence on the lightmap bake (0..1). */
export const DEFAULT_NORMAL_STRENGTH = 1;
/** UV-space pattern scale constraints in cells per output pixel. */
export const UV_SCALE_MIN = 0.05;
export const UV_SCALE_MAX = 8;
export const UV_SCALE_STEP = 0.05;
/** World-space pattern scale constraints in cells per world unit. */
export const WORLDSPACE_SCALE_MIN = 0.1;
export const WORLDSPACE_SCALE_MAX = 2000;
/** Ordered-pattern cells per world unit for world-space dithering. */
export const DEFAULT_WORLDSPACE_SCALE = 64;
/** UV-stretch heatmap sensitivity: scales each face's distortion (octaves)
 * before it maps to the blue→red heatmap, so higher values make small
 * distortions read more color. 1 is the identity. */
export const DEFAULT_UV_STRETCH_SENSITIVITY = 1;
/** Angle (degrees) below which adjacent faces share a smoothed vertex normal. */
export const DEFAULT_SMOOTH_ANGLE = 30;
