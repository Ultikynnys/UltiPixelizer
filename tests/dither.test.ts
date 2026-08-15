import { describe, expect, it } from 'vitest';
import { adjustColor, nearestColor } from '../src/lib/dither';
import { hexToRgb } from '../src/lib/palettes';

describe('color helpers', () => {
  it('converts hex colors into RGB channels', () => {
    expect(hexToRgb('#ff8040')).toEqual([255, 128, 64]);
  });

  it('chooses the perceptually nearest palette color', () => {
    expect(nearestColor([245, 240, 230], [[0, 0, 0], [255, 255, 255]])).toEqual([255, 255, 255]);
  });

  it('keeps adjusted channels in byte range', () => {
    const result = adjustColor([250, 10, 128], 100, 100, 100);
    expect(result.every((channel) => channel >= 0 && channel <= 255)).toBe(true);
  });
});
