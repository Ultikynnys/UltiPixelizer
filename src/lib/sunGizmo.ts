export type SunDirection = {
  azimuth: number;
  elevation: number;
};

export type HemispherePoint = {
  x: number;
  y: number;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

const wrapDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;

/**
 * Projects a sun direction onto a top-down unit hemisphere.
 * The zenith is at the center and the horizon is on the rim.
 */
export function sunDirectionToHemisphere(azimuth: number, elevation: number): HemispherePoint {
  const azimuthRadians = (wrapDegrees(azimuth) * Math.PI) / 180;
  const radius = 1 - clamp(elevation, 0, 90) / 90;
  if (radius === 0) return { x: 0, y: 0 };
  return {
    x: Math.cos(azimuthRadians) * radius,
    y: Math.sin(azimuthRadians) * radius,
  };
}

/** Converts a point on (or beyond) the unit disc back into a sun direction. */
export function hemisphereToSunDirection(x: number, y: number): SunDirection {
  const radius = Math.min(Math.hypot(x, y), 1);
  return {
    azimuth: radius === 0 ? 0 : wrapDegrees((Math.atan2(y, x) * 180) / Math.PI),
    elevation: (1 - radius) * 90,
  };
}
