import { beforeAll, describe, expect, it } from 'vitest';
import { imageHeightmapPixels, imageNormalMapPixels, sampleHeightmap, sampleNormalMap, type HeightmapSource, type NormalMapSource } from '../src/lib/normal';
import { asSourceImage, FakeCanvas, installDomStubs } from './helpers/domStubs';

beforeAll(() => {
  installDomStubs();
});

function source(rgb: [number, number, number]): NormalMapSource {
  return { data: new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]), width: 1, height: 1 };
}

describe('sampleNormalMap', () => {
  it('decodes a flat (128, 128) pixel to the tangent-space Z axis', () => {
    const [x, y, z] = sampleNormalMap(source([128, 128, 255]), 0.5, 0.5, 1, false);
    expect(x).toBeCloseTo(0, 2);
    expect(y).toBeCloseTo(0, 2);
    expect(z).toBeCloseTo(1, 2);
  });

  it('maps red=255 to the +tangent axis and reconstructs Z from X/Y', () => {
    const [x, y, z] = sampleNormalMap(source([255, 128, 128]), 0.5, 0.5, 1, false);
    expect(x).toBeCloseTo(1, 2);
    expect(y).toBeCloseTo(0, 2);
    expect(z).toBeCloseTo(0, 2);
  });

  it('maps green=255 to +Y for OpenGL and flips it for DirectX', () => {
    const opengl = sampleNormalMap(source([128, 255, 128]), 0.5, 0.5, 1, false);
    const directx = sampleNormalMap(source([128, 255, 128]), 0.5, 0.5, 1, true);
    expect(opengl[1]).toBeCloseTo(1, 2);
    expect(directx[1]).toBeCloseTo(-1, 2);
  });

  it('returns the flat normal at zero strength regardless of the map', () => {
    const [x, y, z] = sampleNormalMap(source([255, 255, 128]), 0.5, 0.5, 0, false);
    expect(x).toBe(0);
    expect(y).toBe(0);
    expect(z).toBe(1);
  });

  it('scales the tangent perturbation with strength', () => {
    const full = sampleNormalMap(source([255, 128, 128]), 0.5, 0.5, 1, false);
    const half = sampleNormalMap(source([255, 128, 128]), 0.5, 0.5, 0.5, false);
    expect(half[0]).toBeCloseTo(0.5, 2);
    expect(half[2]).toBeCloseTo(Math.sqrt(0.75), 2);
    expect(full[0]).toBeGreaterThan(half[0]);
  });

  it('clamps UV coordinates to the source bounds', () => {
    const [x] = sampleNormalMap(source([255, 128, 128]), 99, 99, 1, false);
    expect(x).toBeCloseTo(1, 2);
  });
});

describe('imageNormalMapPixels', () => {
  it('reads an image at its native resolution into a PixelSource', () => {
    const canvas = new FakeCanvas();
    canvas.width = 2;
    canvas.height = 1;
    canvas.context.pixels.set([128, 255, 255, 255, 128, 0, 128, 255]);
    const pixels = imageNormalMapPixels(asSourceImage(canvas));
    expect(pixels.width).toBe(2);
    expect(pixels.height).toBe(1);
    expect(Array.from(pixels.data)).toEqual([128, 255, 255, 255, 128, 0, 128, 255]);
  });
});

describe('sampleHeightmap', () => {
  function height(value: number): HeightmapSource {
    return { data: new Uint8ClampedArray([value, value, value, 255]), width: 1, height: 1 };
  }

  it('decodes black to 0 and white to 1', () => {
    expect(sampleHeightmap(height(0), 0.5, 0.5)).toBe(0);
    expect(sampleHeightmap(height(255), 0.5, 0.5)).toBe(1);
  });

  it('maps mid-gray to the neutral 0.5 height', () => {
    expect(sampleHeightmap(height(128), 0.5, 0.5)).toBeCloseTo(128 / 255, 6);
  });

  it('flips v to image space like the normal map (v = 1 reads the top row)', () => {
    // Row 0 (top) is white, row 1 (bottom) is black.
    const source: HeightmapSource = { data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), width: 1, height: 2 };
    expect(sampleHeightmap(source, 0.5, 1)).toBe(1);
    expect(sampleHeightmap(source, 0.5, 0)).toBe(0);
  });

  it('clamps UV coordinates to the source bounds', () => {
    expect(sampleHeightmap(height(200), 99, -5)).toBeCloseTo(200 / 255, 6);
  });

  it('reads a grayscale image into a HeightmapSource', () => {
    const canvas = new FakeCanvas();
    canvas.width = 2;
    canvas.height = 1;
    canvas.context.pixels.set([0, 0, 0, 255, 255, 255, 255, 255]);
    const source = imageHeightmapPixels(asSourceImage(canvas));
    expect(source.width).toBe(2);
    expect(Array.from(source.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});
