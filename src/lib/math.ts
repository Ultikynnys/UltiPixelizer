/** Clamps a value into [min, max]. Shared by every color/lighting clamp in the renderer. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps a value into [0, 1]. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
