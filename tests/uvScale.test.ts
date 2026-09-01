import { describe, expect, it } from 'vitest';
import { uvScaleFromSliderPosition, uvScaleToSliderPosition } from '../src/lib/uvScale';

describe('nonlinear UV scale slider', () => {
  it('places 1 cell per pixel at the center', () => {
    expect(uvScaleFromSliderPosition(0)).toBe(0.05);
    expect(uvScaleFromSliderPosition(50)).toBe(1);
    expect(uvScaleFromSliderPosition(100)).toBe(8);
    expect(uvScaleToSliderPosition(0.05)).toBe(0);
    expect(uvScaleToSliderPosition(1)).toBe(50);
    expect(uvScaleToSliderPosition(8)).toBe(100);
  });

  it('uses half the track for each side of the midpoint', () => {
    expect(uvScaleFromSliderPosition(25)).toBe(0.55);
    expect(uvScaleFromSliderPosition(75)).toBe(4.5);
  });

  it('snaps slider output to 0.05 cells per pixel', () => {
    const value = uvScaleFromSliderPosition(63.37);
    expect(Number.isInteger(Math.round(value * 100) / 5)).toBe(true);
  });

  it('round-trips every supported value within one slider step', () => {
    for (let value = 0.05; value <= 8; value += 0.05) {
      expect(uvScaleFromSliderPosition(uvScaleToSliderPosition(value))).toBeCloseTo(value, 6);
    }
  });
});
