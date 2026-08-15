import { describe, expect, it } from 'vitest';
import { hemisphereToSunDirection, sunDirectionToHemisphere, sunDirectionVector } from '../src/lib/sunGizmo';

describe('sun sphere gizmo projection', () => {
  it('places the zenith in the center and horizon on the rim', () => {
    expect(sunDirectionToHemisphere(123, 90)).toEqual({ x: 0, y: 0 });
    expect(sunDirectionToHemisphere(0, 0)).toEqual({ x: 1, y: 0 });
    expect(sunDirectionToHemisphere(90, 0).x).toBeCloseTo(0);
    expect(sunDirectionToHemisphere(90, 0).y).toBeCloseTo(1);
  });

  it('maps cardinal disc points to azimuth and elevation', () => {
    expect(hemisphereToSunDirection(1, 0)).toEqual({ azimuth: 0, elevation: 0 });
    expect(hemisphereToSunDirection(0, 1)).toEqual({ azimuth: 90, elevation: 0 });
    expect(hemisphereToSunDirection(-1, 0).azimuth).toBe(180);
    expect(hemisphereToSunDirection(0, -1).azimuth).toBe(270);
    expect(hemisphereToSunDirection(0, 0)).toEqual({ azimuth: 0, elevation: 90 });
  });

  it('clamps points beyond the horizon to zero elevation', () => {
    const direction = hemisphereToSunDirection(2, 2);
    expect(direction.elevation).toBe(0);
    expect(direction.azimuth).toBeCloseTo(45);
  });

  it('preserves azimuth inside the zenith dead zone', () => {
    expect(hemisphereToSunDirection(-0.01, 0, 275)).toEqual({ azimuth: 275, elevation: 89.1 });
  });

  it('wraps negative azimuths and clamps elevations', () => {
    const point = sunDirectionToHemisphere(-90, 100);
    expect(point).toEqual({ x: 0, y: 0 });
    expect(sunDirectionToHemisphere(-90, -10).y).toBeCloseTo(-1);
  });

  it('converts angles to the viewport world-space direction', () => {
    expect(sunDirectionVector(0, 0)).toEqual({ x: 1, y: 0, z: 0 });
    expect(sunDirectionVector(90, 0).x).toBeCloseTo(0);
    expect(sunDirectionVector(90, 0).z).toBeCloseTo(1);
    expect(sunDirectionVector(270, 90)).toEqual(expect.objectContaining({ y: 1 }));
  });

  it('round-trips directions on the upper hemisphere', () => {
    for (const direction of [
      { azimuth: 45, elevation: 45 },
      { azimuth: 135, elevation: 20 },
      { azimuth: 270, elevation: 70 },
      { azimuth: 359, elevation: 1 },
    ]) {
      const point = sunDirectionToHemisphere(direction.azimuth, direction.elevation);
      const result = hemisphereToSunDirection(point.x, point.y);
      expect(result.azimuth).toBeCloseTo(direction.azimuth);
      expect(result.elevation).toBeCloseTo(direction.elevation);
    }
  });
});
