import type { Quaternion } from 'three';

export type DirectionVector = { x: number; y: number; z: number };

/**
 * Default sun: light travels downward and toward −X/−Z, i.e. the sun sits above
 * in the +X/+Z octant so the +X and +Z faces start lit. `sunDirection` is the
 * direction light TRAVELS (from the sun toward the scene), not the direction
 * toward the light  see `directionToSun`.
 */
export const DEFAULT_SUN_DIRECTION: Readonly<DirectionVector> = Object.freeze({
  x: -0.5,
  y: -Math.SQRT1_2,
  z: -0.5,
});

/** Returns a finite unit-length world direction. Throws on non-finite or
 * zero-length input so a bad direction surfaces instead of silently falling back
 * to the default sun. */
export function normalizeDirection(direction: DirectionVector): DirectionVector {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length === 0) {
    throw new Error('Sun direction must be a finite, non-zero vector.');
  }
  return {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
}

/**
 * Default camera forward  the direction the orbit camera looks after
 * `fitCameraToObject` (position offset `(1.1, 0.65, 1.6)`, negated and
 * normalized). Used as the backfill value for settings saved before the camera
 * direction was persisted, and as the initial camera angle before a model loads.
 */
export const DEFAULT_CAMERA_DIRECTION: Readonly<DirectionVector> = Object.freeze(
  normalizeDirection({ x: -1.1, y: -0.65, z: -1.6 }),
);

/** Direction FROM the scene TOWARD the sun  the negation of the light-travel direction. */
export function directionToSun(direction: DirectionVector): DirectionVector {
  const ray = normalizeDirection(direction);
  return { x: -ray.x, y: -ray.y, z: -ray.z };
}

/** Transforms camera-local forward (-Z) by a normalized world quaternion. */
export function cameraForwardFromQuaternion(quaternion: Pick<Quaternion, 'x' | 'y' | 'z' | 'w'>): DirectionVector {
  const { x, y, z, w } = quaternion;
  return normalizeDirection({
    x: -2 * (x * z + w * y),
    y: -2 * (y * z - w * x),
    z: -(1 - 2 * (x * x + y * y)),
  });
}
