import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cloneImageData } from '../src/lib/canvas';

beforeAll(() => {
  vi.stubGlobal('ImageData', class {
    readonly colorSpace = 'srgb';
    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  });
});

describe('canvas render staging', () => {
  it('clones image pixels so 2D lighting cannot mutate the unlit 3D texture source', () => {
    const unlit = new ImageData(new Uint8ClampedArray([180, 120, 60, 255]), 1, 1);
    const lit = cloneImageData(unlit);

    lit.data[0] = 0;
    lit.data[1] = 0;
    lit.data[2] = 0;

    expect(Array.from(unlit.data)).toEqual([180, 120, 60, 255]);
    expect(Array.from(lit.data)).toEqual([0, 0, 0, 255]);
  });
});
