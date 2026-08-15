import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cloneImageData, processLitImageData } from '../src/lib/canvas';

beforeAll(() => {
  vi.stubGlobal('ImageData', class {
    readonly colorSpace = 'srgb';
    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  });
});

describe('canvas render staging', () => {
  it('clones image pixels so lighting cannot mutate the BaseColor source', () => {
    const source = new ImageData(new Uint8ClampedArray([180, 120, 60, 255]), 1, 1);
    const lit = cloneImageData(source);

    lit.data[0] = 0;
    lit.data[1] = 0;
    lit.data[2] = 0;

    expect(Array.from(source.data)).toEqual([180, 120, 60, 255]);
    expect(Array.from(lit.data)).toEqual([0, 0, 0, 255]);
  });

  it('applies lighting before processing while preserving the BaseColor source', () => {
    const source = new ImageData(new Uint8ClampedArray([200, 120, 60, 255]), 1, 1);
    const process = vi.fn((lit: ImageData) => {
      expect(Array.from(lit.data)).toEqual([100, 60, 30, 255]);
      return new ImageData(new Uint8ClampedArray([96, 64, 32, 255]), 1, 1);
    });

    const result = processLitImageData(
      source,
      (pixels) => {
        pixels[0] *= 0.5;
        pixels[1] *= 0.5;
        pixels[2] *= 0.5;
      },
      process,
    );

    expect(process).toHaveBeenCalledOnce();
    expect(Array.from(source.data)).toEqual([200, 120, 60, 255]);
    expect(Array.from(result.lit.data)).toEqual([100, 60, 30, 255]);
    expect(Array.from(result.processed.data)).toEqual([96, 64, 32, 255]);
  });
});
