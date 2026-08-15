import { describe, expect, it } from 'vitest';
import { sunDirectionVector, vectorToSunDirection } from '../src/lib/sunGizmo';

describe('sun direction conversion', () => {
  it('converts angles to the viewport world-space direction', () => {
    expect(sunDirectionVector(0, 0)).toEqual({ x: 1, y: 0, z: 0 });
    expect(sunDirectionVector(90, 0).x).toBeCloseTo(0);
    expect(sunDirectionVector(90, 0).z).toBeCloseTo(1);
    expect(sunDirectionVector(270, 90)).toEqual(expect.objectContaining({ y: 1 }));
    expect(sunDirectionVector(270, -90)).toEqual(expect.objectContaining({ y: -1 }));
  });

  it('converts camera-facing vectors to sun angles', () => {
    expect(vectorToSunDirection({ x: 1, y: 0, z: 0 })).toEqual({ azimuth: 0, elevation: 0 });
    expect(vectorToSunDirection({ x: 0, y: 0, z: 1 }).azimuth).toBeCloseTo(90);
    expect(vectorToSunDirection({ x: -1, y: 0, z: 0 }).azimuth).toBeCloseTo(180);
    expect(vectorToSunDirection({ x: 0, y: -1, z: 0 }).elevation).toBeCloseTo(-90);
    expect(vectorToSunDirection({ x: 0, y: 0, z: -1 }).azimuth).toBeCloseTo(270);
  });

  it('normalizes vectors and handles invalid directions', () => {
    expect(vectorToSunDirection({ x: 10, y: 10, z: 0 }).elevation).toBeCloseTo(45);
    expect(vectorToSunDirection({ x: 0, y: 0, z: 0 })).toEqual({ azimuth: 0, elevation: 0 });
    expect(vectorToSunDirection({ x: Number.NaN, y: 0, z: 0 })).toEqual({ azimuth: 0, elevation: 0 });
  });

  it('round-trips angles across the full camera elevation range', () => {
    for (const direction of [
      { azimuth: 45, elevation: 45 },
      { azimuth: 135, elevation: -20 },
      { azimuth: 270, elevation: 70 },
      { azimuth: 359, elevation: -89 },
    ]) {
      const result = vectorToSunDirection(sunDirectionVector(direction.azimuth, direction.elevation));
      expect(result.azimuth).toBeCloseTo(direction.azimuth);
      expect(result.elevation).toBeCloseTo(direction.elevation);
    }
  });
});
