import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasColorAt, canvasPixelCoords, colorStringToHex, sampleColorAt, solidBackgroundHex, webglCanvasColorAt } from '../src/lib/eyedropper';
import { FakeCanvas } from './helpers/domStubs';

/** A viewport rect for the rect-using helpers; FakeCanvas has no DOM rect. */
function withRect(canvas: FakeCanvas, rect: { left: number; top: number; width: number; height: number }): FakeCanvas {
  (canvas as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect;
  return canvas;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('colorStringToHex', () => {
  it('passes hex values through lowercase', () => {
    expect(colorStringToHex('#A1B2C3')).toBe('#a1b2c3');
  });

  it('parses rgb()', () => {
    expect(colorStringToHex('rgb(255, 0, 128)')).toBe('#ff0080');
  });

  it('parses rgba() with full alpha', () => {
    expect(colorStringToHex('rgba(12, 34, 56, 1)')).toBe('#0c2238');
    expect(colorStringToHex('rgba(12, 34, 56, 1.0)')).toBe('#0c2238');
  });

  it('rejects transparent', () => {
    expect(colorStringToHex('transparent')).toBeNull();
  });

  it('rejects translucent fills (the backdrop shows through)', () => {
    expect(colorStringToHex('rgba(12, 34, 56, 0.5)')).toBeNull();
    expect(colorStringToHex('rgba(12, 34, 56, 0)')).toBeNull();
  });

  it('rejects empty and malformed values', () => {
    expect(colorStringToHex('')).toBeNull();
    expect(colorStringToHex('   ')).toBeNull();
    expect(colorStringToHex('garbage')).toBeNull();
    expect(colorStringToHex('#fff')).toBeNull();
  });
});

describe('canvasPixelCoords', () => {
  it('maps a viewport point to backing pixels across CSS scaling', () => {
    const canvas = withRect(new FakeCanvas(), { left: 10, top: 20, width: 100, height: 50 });
    canvas.width = 200;
    canvas.height = 100;
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 60, 45)).toEqual({ x: 100, y: 50 });
  });

  it('returns null for points outside the canvas', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 10, height: 10 });
    canvas.width = 4;
    canvas.height = 4;
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 999, 999)).toBeNull();
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, -5, -5)).toBeNull();
  });

  it('clamps points at the box edge to the last backing pixel', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 10, height: 10 });
    canvas.width = 4;
    canvas.height = 4;
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 9, 9)).toEqual({ x: 3, y: 3 });
  });

  it('resolves zero-sized (hidden) canvases to null', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 0, height: 0 });
    canvas.width = 4;
    canvas.height = 4;
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 100, 100)).toBeNull();
  });

  it('maps through object-fit: contain letterboxing', () => {
    // 2×1 content centered in a 4×1 box leaves 1px bars either side.
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 4, height: 1 });
    canvas.width = 2;
    canvas.height = 1;
    vi.stubGlobal('getComputedStyle', () => ({ objectFit: 'contain', backgroundColor: 'transparent' }));
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 0, 0)).toBeNull();
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 1, 0)).toEqual({ x: 0, y: 0 });
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 2, 0)).toEqual({ x: 1, y: 0 });
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 3, 0)).toBeNull();
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 4, 0)).toBeNull();
  });

  it('maps through object-fit: cover letterboxing', () => {
    // 2×1 content stretched to cover a 4×2 box: scale = max(2, 2) = 2 → 4×2, no bars.
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 4, height: 2 });
    canvas.width = 2;
    canvas.height = 1;
    vi.stubGlobal('getComputedStyle', () => ({ objectFit: 'cover', backgroundColor: 'transparent' }));
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(canvasPixelCoords(canvas as unknown as HTMLCanvasElement, 3, 1)).toEqual({ x: 1, y: 0 });
  });
});

describe('canvasColorAt', () => {
  it('returns the exact backing pixel under the point', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 2, height: 1 });
    canvas.width = 2;
    canvas.height = 1;
    canvas.context.pixels.set([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(canvasColorAt(canvas as unknown as HTMLCanvasElement, 0, 0)).toBe('#ff0000');
    expect(canvasColorAt(canvas as unknown as HTMLCanvasElement, 1, 0)).toBe('#00ff00');
  });

  it('returns null for a fully transparent pixel', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 1, height: 1 });
    canvas.width = 1;
    canvas.height = 1;
    canvas.context.pixels.set([10, 20, 30, 0]);
    expect(canvasColorAt(canvas as unknown as HTMLCanvasElement, 0, 0)).toBeNull();
  });

  it('returns null when the canvas has no readable 2D context (WebGL viewport)', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 1, height: 1 });
    (canvas as unknown as { getContext: () => null }).getContext = () => null;
    expect(canvasColorAt(canvas as unknown as HTMLCanvasElement, 0, 0)).toBeNull();
  });

  it('returns null for a hidden canvas', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 0, height: 0 });
    canvas.width = 2;
    canvas.height = 2;
    expect(canvasColorAt(canvas as unknown as HTMLCanvasElement, 0, 0)).toBeNull();
  });
});

describe('solidBackgroundHex', () => {
  it('returns the element background when it is opaque', () => {
    const element = { parentElement: null, backgroundColor: 'rgb(20, 20, 18)' } as unknown as Element;
    vi.stubGlobal('getComputedStyle', (node: { backgroundColor: string }) => ({ backgroundColor: node.backgroundColor }));
    expect(solidBackgroundHex(element)).toBe('#141412');
  });

  it('walks up through transparent layers to the layer that paints', () => {
    const root = { parentElement: null, backgroundColor: 'rgb(1, 2, 3)' } as unknown as Element;
    const child = { parentElement: root, backgroundColor: 'transparent' } as unknown as Element;
    const leaf = { parentElement: child, backgroundColor: 'rgba(0, 0, 0, 0)' } as unknown as Element;
    vi.stubGlobal('getComputedStyle', (node: { backgroundColor: string }) => ({ backgroundColor: node.backgroundColor }));
    expect(solidBackgroundHex(leaf)).toBe('#010203');
  });

  it('returns null when nothing paints an opaque color', () => {
    const element = { parentElement: null, backgroundColor: 'transparent' } as unknown as Element;
    vi.stubGlobal('getComputedStyle', (node: { backgroundColor: string }) => ({ backgroundColor: node.backgroundColor }));
    expect(solidBackgroundHex(element)).toBeNull();
  });

  it('returns null for a null element', () => {
    expect(solidBackgroundHex(null)).toBeNull();
  });
});

describe('webglCanvasColorAt', () => {
  function webglCanvas(height: number, pixel: [number, number, number, number]): { canvas: HTMLCanvasElement; read: Array<{ x: number; y: number }> } {
    const read: Array<{ x: number; y: number }> = [];
    const gl = {
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      readPixels(x: number, y: number, _width: number, _height: number, _format: number, _type: number, dest: Uint8Array): void {
        read.push({ x, y });
        dest.set(pixel);
      },
    };
    const canvas = {
      width: 2,
      height,
      getContext: (kind: string) => (kind === 'webgl2' ? gl : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 2, height }),
    } as unknown as HTMLCanvasElement;
    return { canvas, read };
  }

  it('reads the backing pixel with the GL y-flip', () => {
    const { canvas, read } = webglCanvas(4, [255, 0, 0, 255]);
    expect(webglCanvasColorAt(canvas, 1, 0)).toBe('#ff0000');
    expect(read).toEqual([{ x: 1, y: 3 }]);
  });

  it('returns null for a transparent pixel', () => {
    const { canvas } = webglCanvas(4, [10, 20, 30, 0]);
    expect(webglCanvasColorAt(canvas, 0, 0)).toBeNull();
  });

  it('returns null when the canvas has no GL context', () => {
    const canvas = { width: 2, height: 2, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(webglCanvasColorAt(canvas, 0, 0)).toBeNull();
  });
});

describe('sampleColorAt', () => {
  it('samples the exact canvas pixel under the cursor', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 1, height: 1 });
    canvas.width = 1;
    canvas.height = 1;
    canvas.context.pixels.set([10, 20, 30, 255]);
    vi.stubGlobal('document', { elementFromPoint: () => canvas });
    expect(sampleColorAt(0, 0)).toBe('#0a141e');
  });

  it('falls back to the nearest solid background over non-canvas content', () => {
    const element = { parentElement: null, backgroundColor: 'rgb(200, 0, 0)' } as unknown as Element;
    vi.stubGlobal('document', { elementFromPoint: () => element });
    vi.stubGlobal('getComputedStyle', (node: { backgroundColor: string }) => ({ backgroundColor: node.backgroundColor }));
    expect(sampleColorAt(5, 5)).toBe('#c80000');
  });

  it('falls back to the background when the canvas pixel is transparent', () => {
    const canvas = withRect(new FakeCanvas(), { left: 0, top: 0, width: 1, height: 1 });
    canvas.width = 1;
    canvas.height = 1;
    canvas.context.pixels.set([0, 0, 0, 0]);
    (canvas as unknown as { backgroundColor: string }).backgroundColor = 'rgb(9, 9, 9)';
    vi.stubGlobal('document', { elementFromPoint: () => canvas });
    vi.stubGlobal('getComputedStyle', (node: { backgroundColor: string }) => ({ backgroundColor: node.backgroundColor }));
    expect(sampleColorAt(0, 0)).toBe('#090909');
  });

  it('returns null when nothing paints an opaque color', () => {
    vi.stubGlobal('document', { elementFromPoint: () => null });
    expect(sampleColorAt(0, 0)).toBeNull();
  });
});
