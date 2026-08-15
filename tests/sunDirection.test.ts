import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { cameraForwardFromQuaternion, DEFAULT_SUN_DIRECTION, normalizeDirection } from '../src/lib/sunDirection';

describe('sun world direction', () => {
  it('normalizes a camera-forward vector without changing its orientation', () => {
    const result = normalizeDirection({ x: -2, y: 3, z: -4 });
    const length = Math.hypot(-2, 3, -4);
    expect(result.x).toBeCloseTo(-2 / length);
    expect(result.y).toBeCloseTo(3 / length);
    expect(result.z).toBeCloseTo(-4 / length);
    expect(Math.hypot(result.x, result.y, result.z)).toBeCloseTo(1);
  });

  it('preserves each cardinal world orientation', () => {
    expect(normalizeDirection({ x: 1, y: 0, z: 0 })).toEqual({ x: 1, y: 0, z: 0 });
    expect(normalizeDirection({ x: -1, y: 0, z: 0 })).toEqual({ x: -1, y: 0, z: 0 });
    expect(normalizeDirection({ x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
    expect(normalizeDirection({ x: 0, y: -1, z: 0 })).toEqual({ x: 0, y: -1, z: 0 });
    expect(normalizeDirection({ x: 0, y: 0, z: 1 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(normalizeDirection({ x: 0, y: 0, z: -1 })).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('derives camera-local -Z from arbitrary world quaternions', () => {
    for (const euler of [
      new Euler(0, 0, 0),
      new Euler(Math.PI / 2, 0, 0),
      new Euler(0, Math.PI / 2, 0),
      new Euler(0.73, -1.21, 2.18),
    ]) {
      const quaternion = new Quaternion().setFromEuler(euler);
      const expected = new Vector3(0, 0, -1).applyQuaternion(quaternion);
      const result = cameraForwardFromQuaternion(quaternion);
      expect(result.x).toBeCloseTo(expected.x);
      expect(result.y).toBeCloseTo(expected.y);
      expect(result.z).toBeCloseTo(expected.z);
    }
  });

  it('uses a safe default for zero-length and non-finite vectors', () => {
    expect(normalizeDirection({ x: 0, y: 0, z: 0 })).toEqual(DEFAULT_SUN_DIRECTION);
    expect(normalizeDirection({ x: Number.NaN, y: 0, z: 0 })).toEqual(DEFAULT_SUN_DIRECTION);
  });
});
