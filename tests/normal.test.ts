import { beforeAll, describe, expect, it } from 'vitest';
import { imageNormalMapPixels, sampleNormalMap, type NormalMapSource } from '../src/lib/normal';
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
