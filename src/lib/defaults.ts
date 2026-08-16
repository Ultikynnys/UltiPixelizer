export const DEFAULT_SUN_INTENSITY = 1;
export const DEFAULT_AMBIENT_INTENSITY = 0.2;
/** Angle (degrees) below which adjacent faces share a smoothed vertex normal. */
export const DEFAULT_SMOOTH_ANGLE = 30;

/**
 * Default mesh tessellation density — the number of segments each triangle edge
 * is split into before normal smoothing (1 = original density). Higher values
 * increase sampling density so per-pixel normal interpolation follows surface
 * curvature more closely on coarse meshes.
 */
export const DEFAULT_TESSELLATION = 1;
