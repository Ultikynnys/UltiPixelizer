import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { cameraForwardFromQuaternion, DEFAULT_SUN_DIRECTION, directionToSun, normalizeDirection } from '../src/lib/sunDirection';

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

  it('resolves all six cardinal camera orientations without a pole singularity', () => {
    const localForward = new Vector3(0, 0, -1);
    for (const expected of [
      new Vector3(1, 0, 0),
      new Vector3(-1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, -1, 0),
      new Vector3(0, 0, 1),
      new Vector3(0, 0, -1),
    ]) {
      const quaternion = new Quaternion().setFromUnitVectors(localForward, expected);
      const result = cameraForwardFromQuaternion(quaternion);
      expect(result.x).toBeCloseTo(expected.x);
      expect(result.y).toBeCloseTo(expected.y);
      expect(result.z).toBeCloseTo(expected.z);
    }
  });

  it('throws for zero-length and non-finite vectors', () => {
    expect(() => normalizeDirection({ x: 0, y: 0, z: 0 })).toThrow();
    expect(() => normalizeDirection({ x: Number.NaN, y: 0, z: 0 })).toThrow();
    expect(() => normalizeDirection({ x: Number.POSITIVE_INFINITY, y: 0, z: 0 })).toThrow();
  });

  it('directionToSun negates the light-travel direction toward the sun', () => {
    const sun = directionToSun(DEFAULT_SUN_DIRECTION);
    expect(sun.x).toBeCloseTo(-DEFAULT_SUN_DIRECTION.x);
    expect(sun.y).toBeCloseTo(-DEFAULT_SUN_DIRECTION.y);
    expect(sun.z).toBeCloseTo(-DEFAULT_SUN_DIRECTION.z);
    expect(Math.hypot(sun.x, sun.y, sun.z)).toBeCloseTo(1);
  });

  it('directionToSun normalizes then negates arbitrary input', () => {
    const result = directionToSun({ x: -2, y: 3, z: -4 });
    const length = Math.hypot(2, 3, 4);
    expect(result.x).toBeCloseTo(2 / length);
    expect(result.y).toBeCloseTo(-3 / length);
    expect(result.z).toBeCloseTo(4 / length);
  });

  it('defaults to a sun above the +X/+Z octant so those faces start lit', () => {
    // `sunDirection` is light-TRAVEL direction: negative components mean the sun
    // sits on the positive side of that axis (see `directionToSun`).
    expect(DEFAULT_SUN_DIRECTION.x).toBeLessThan(0);
    expect(DEFAULT_SUN_DIRECTION.y).toBeLessThan(0);
    expect(DEFAULT_SUN_DIRECTION.z).toBeLessThan(0);
    expect(Math.hypot(DEFAULT_SUN_DIRECTION.x, DEFAULT_SUN_DIRECTION.y, DEFAULT_SUN_DIRECTION.z)).toBeCloseTo(1);
  });
});
