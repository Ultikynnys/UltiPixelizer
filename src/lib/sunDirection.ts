export type DirectionVector = { x: number; y: number; z: number };

export const DEFAULT_SUN_DIRECTION: Readonly<DirectionVector> = Object.freeze({
  x: 0.5,
  y: Math.SQRT1_2,
  z: 0.5,
});

/** Returns a finite unit-length world direction, or the default sun direction for invalid input. */
export function normalizeDirection(direction: DirectionVector): DirectionVector {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length === 0) return { ...DEFAULT_SUN_DIRECTION };
  return {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
}
