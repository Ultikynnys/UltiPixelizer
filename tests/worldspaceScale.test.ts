import { describe, expect, it } from 'vitest';
import { worldspaceScaleFromSliderPosition, worldspaceScaleToSliderPosition } from '../src/lib/worldspaceScale';

describe('logarithmic world scale slider', () => {
  it('places 1 cell per unit at the center of the track', () => {
    expect(worldspaceScaleFromSliderPosition(0)).toBe(0.1);
    expect(worldspaceScaleFromSliderPosition(50)).toBe(1);
    expect(worldspaceScaleFromSliderPosition(100)).toBe(2000);
    expect(worldspaceScaleToSliderPosition(0.1)).toBe(0);
    expect(worldspaceScaleToSliderPosition(1)).toBe(50);
    expect(worldspaceScaleToSliderPosition(2000)).toBe(100);
  });

  it('reserves the lower half for 0.1–1 and the upper half for 1–2000', () => {
    // Geometric midpoints of each half: sqrt(0.1 * 1) and sqrt(1 * 2000).
    expect(worldspaceScaleToSliderPosition(0.316)).toBeLessThan(50);
    expect(worldspaceScaleToSliderPosition(0.316)).toBeGreaterThan(0);
    expect(worldspaceScaleToSliderPosition(44.7)).toBeGreaterThan(50);
    expect(worldspaceScaleToSliderPosition(44.7)).toBeLessThan(100);
  });

  it('snaps to two significant figures', () => {
    expect(worldspaceScaleFromSliderPosition(49.9)).toBe(1);
    expect(worldspaceScaleFromSliderPosition(75)).toBe(45);
    expect(worldspaceScaleFromSliderPosition(77.4)).toBe(64);
  });

  it('round-trips every representable value within float noise', () => {
    for (let magnitude = 0.1; magnitude <= 1000; magnitude *= 10) {
      for (let mantissa = 1; mantissa <= 9.9; mantissa += 0.1) {
        const value = Math.min(2000, mantissa * magnitude);
        if (value < 0.1) continue;
        expect(worldspaceScaleFromSliderPosition(worldspaceScaleToSliderPosition(value))).toBeCloseTo(value, 6);
      }
    }
  });

  it('maps the 64 cells/unit default onto the upper half', () => {
    const position = worldspaceScaleToSliderPosition(64);
    expect(position).toBeGreaterThan(50);
    expect(position).toBeLessThan(100);
    expect(worldspaceScaleFromSliderPosition(position)).toBe(64);
  });
});
