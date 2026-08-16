import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cloneImageData,
  createSampleTexture,
  downloadCanvas,
  downloadText,
  drawImageToCanvas,
  factorsToCanvas,
  imagePixels,
  loadImageFile,
  pixelsToCanvas,
  processLitImageData,
} from '../src/lib/canvas';
import { asSourceImage, domStubs, FakeCanvas, installDomStubs, stubDocument } from './helpers/domStubs';

beforeAll(() => {
  installDomStubs();
});

// Reinstall between tests so per-test overrides (null contexts, failing
// Image elements, stubbed URL) never leak.
afterEach(() => {
  installDomStubs();
});

/** A 1×1 canvas whose pixels hold exactly the given RGBA values. */
function pixelCanvas(rgba: number[]) {
  const canvas = new FakeCanvas();
  canvas.width = 1;
  canvas.height = 1;
  canvas.context.pixels.set(rgba);
  return asSourceImage(canvas);
}

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

describe('canvas drawing helpers', () => {
  it('draws an image into a fresh canvas at the requested size', () => {
    const source = pixelCanvas([200, 100, 50, 255]);
    const { canvas, context } = drawImageToCanvas(source, 1, 1);
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
    expect(context).not.toBeNull();
    expect(Array.from((canvas as unknown as FakeCanvas).context.pixels)).toEqual([200, 100, 50, 255]);
  });

  it('returns a null context when a canvas cannot provide one', () => {
    stubDocument(() => ({ width: 0, height: 0, getContext: () => null }));
    const { context } = drawImageToCanvas(pixelCanvas([1, 2, 3, 255]), 1, 1);
    expect(context).toBeNull();
  });

  it('reads image pixels through the 2D context', () => {
    const source = pixelCanvas([10, 20, 30, 255]);
    expect(Array.from(imagePixels(source, 1, 1))).toEqual([10, 20, 30, 255]);
  });

  it('throws a friendly error when pixels cannot be read', () => {
    stubDocument(() => ({ width: 0, height: 0, getContext: () => null }));
    expect(() => imagePixels(pixelCanvas([1, 2, 3, 255]), 1, 1)).toThrow('Canvas is unavailable.');
  });

  it('writes RGBA pixels into a fresh canvas', () => {
    const pixels = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 128]);
    const canvas = pixelsToCanvas(pixels, 2, 1);
    expect(canvas.width).toBe(2);
    expect(canvas.height).toBe(1);
    expect(Array.from((canvas as unknown as FakeCanvas).context.pixels)).toEqual([...pixels]);
  });

  it('throws when pixels cannot be written', () => {
    stubDocument(() => ({ width: 0, height: 0, getContext: () => null }));
    expect(() => pixelsToCanvas(new Uint8ClampedArray(4), 1, 1)).toThrow('Canvas is unavailable.');
  });

  it('expands single-channel factors to opaque grayscale RGBA', () => {
    const canvas = factorsToCanvas(new Uint8ClampedArray([255, 0, 128]), 3, 1);
    expect(Array.from((canvas as unknown as FakeCanvas).context.pixels)).toEqual([
      255, 255, 255, 255,
      0, 0, 0, 255,
      128, 128, 128, 255,
    ]);
  });

  it('leaves pixels transparent when the fill callback returns null', () => {
    const canvas = factorsToCanvas(new Uint8ClampedArray([1, 2, 3]), 3, 1, (value) => (value >= 2 ? 255 : null));
    expect(Array.from((canvas as unknown as FakeCanvas).context.pixels)).toEqual([
      0, 0, 0, 0,
      255, 255, 255, 255,
      255, 255, 255, 255,
    ]);
  });
});

describe('sample texture', () => {
  it('creates a sized gradient canvas with deterministic seeded grain', () => {
    const first = createSampleTexture(40, 7);
    const second = createSampleTexture(40, 7);
    const other = createSampleTexture(40, 8);
    expect(first.width).toBe(40);
    expect(first.height).toBe(Math.round(40 * 0.72));
    expect(Array.from((first as unknown as FakeCanvas).context.pixels)).toEqual(Array.from((second as unknown as FakeCanvas).context.pixels));
    expect(Array.from((first as unknown as FakeCanvas).context.pixels)).not.toEqual(Array.from((other as unknown as FakeCanvas).context.pixels));
    expect((first as unknown as FakeCanvas).context.fillRect).toHaveBeenCalled();
    expect((first as unknown as FakeCanvas).context.arc).toHaveBeenCalled();
  });
});

describe('file helpers', () => {
  const file = { name: 'photo.png', size: 123 } as File;

  it('resolves an Image once the file URL loads, revoking the object URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:photo');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const image = await loadImageFile(file);
    expect(image).toBeInstanceOf(globalThis.Image);
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo');
  });

  it('rejects when the file cannot be decoded', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_url: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    await expect(loadImageFile(file)).rejects.toThrow('could not be decoded as an image');
  });

  it('downloads text through a temporary anchor', () => {
    const createObjectURL = vi.fn(() => 'blob:data');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    downloadText('{"a":1}', 'settings.json', 'application/json');
    const anchor = domStubs.anchors.at(-1)!;
    expect(anchor.download).toBe('settings.json');
    expect(anchor.href).toBe('blob:data');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:data');
  });

  it('downloads canvas contents through its blob', () => {
    const createObjectURL = vi.fn(() => 'blob:canvas');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    downloadCanvas(new FakeCanvas() as unknown as HTMLCanvasElement, 'render.png');
    const anchor = domStubs.anchors.at(-1)!;
    expect(anchor.download).toBe('render.png');
    expect(anchor.click).toHaveBeenCalledOnce();
  });
});
