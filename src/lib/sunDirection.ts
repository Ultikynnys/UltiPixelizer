export type SunDirection = {
  azimuth: number;
  elevation: number;
};

export type DirectionVector = { x: number; y: number; z: number };

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

const wrapDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** Converts sun angles to the world-space direction in which the light rays travel. */
export function sunDirectionVector(azimuth: number, elevation: number): DirectionVector {
  const azimuthRadians = (wrapDegrees(azimuth) * Math.PI) / 180;
  const elevationRadians = (clamp(elevation, -90, 90) * Math.PI) / 180;
  const cosElevation = Math.cos(elevationRadians);
  return {
    x: cosElevation * Math.cos(azimuthRadians),
    y: Math.sin(elevationRadians),
    z: cosElevation * Math.sin(azimuthRadians),
  };
}

/** Converts a world-space light-travel direction into wrapped azimuth and signed elevation angles. */
export function vectorToSunDirection(direction: DirectionVector): SunDirection {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length === 0) return { azimuth: 0, elevation: 0 };
  return {
    azimuth: wrapDegrees((Math.atan2(direction.z, direction.x) * 180) / Math.PI),
    elevation: (Math.asin(clamp(direction.y / length, -1, 1)) * 180) / Math.PI,
  };
}
