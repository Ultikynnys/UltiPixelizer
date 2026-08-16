import { vi } from 'vitest';
import type { SourceImage } from '../../src/lib/state';

/**
 * Shared DOM/canvas stubs for the node test environment.
 *
 * The lib layer (canvas.ts, render/*, modelPreview.ts) reaches for
 * `document.createElement('canvas')`, 2D contexts, `ImageData`,
 * `requestAnimationFrame`, `ResizeObserver`, `matchMedia` and friends — all
 * absent in node. Installing these stubs once per test file keeps those tests
 * deterministic and free of a jsdom dependency.
 */

export class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: string;

  constructor(data: Uint8ClampedArray, width: number, height: number, options?: { colorSpace?: string }) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.colorSpace = options?.colorSpace ?? 'srgb';
  }
}

export class FakeCanvasRenderingContext2D {
  /** RGBA pixel buffer of `canvas.width * canvas.height`. Public so tests can
   * pre-fill known pixels before a render pass reads them back. */
  pixels = new Uint8ClampedArray(0);
  readonly drawn: Array<{ image: unknown; dx: number; dy: number; width?: number; height?: number }> = [];

  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  lineWidth = 1;
  lineJoin = 'miter';
  lineCap = 'butt';
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalCompositeOperation = 'source-over';

  constructor(readonly canvas: FakeCanvas) {}

  /** Grows the pixel buffer to match the canvas size (called by the canvas
   * width/height setters and by every read/write op). */
  resizeBuffer(): void {
    const needed = this.canvas.width * this.canvas.height * 4;
    if (this.pixels.length !== needed) {
      this.pixels = new Uint8ClampedArray(needed);
    }
  }

  private ensurePixels(): void {
    this.resizeBuffer();
  }

  private writePixel(x: number, y: number, rgba: Uint8ClampedArray, sourceOffset: number): void {
    const target = y * this.canvas.width + x;
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const base = target * 4;
    for (let c = 0; c < 4; c += 1) this.pixels[base + c] = rgba[sourceOffset + c];
  }

  getImageData(x: number, y: number, width: number, height: number): FakeImageData {
    this.ensurePixels();
    const out = new Uint8ClampedArray(width * height * 4);
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const target = (y + py) * this.canvas.width + (x + px);
        if (target < 0 || target >= this.canvas.width * this.canvas.height) continue;
        out.set(this.pixels.subarray(target * 4, target * 4 + 4), (py * width + px) * 4);
      }
    }
    return new FakeImageData(out, width, height);
  }

  putImageData(imageData: FakeImageData, x = 0, y = 0): void {
    this.ensurePixels();
    for (let py = 0; py < imageData.height; py += 1) {
      for (let px = 0; px < imageData.width; px += 1) {
        this.writePixel(x + px, y + py, imageData.data, (py * imageData.width + px) * 4);
      }
    }
  }

  createImageData(width: number, height: number): FakeImageData {
    return new FakeImageData(new Uint8ClampedArray(width * height * 4), width, height);
  }

  drawImage(image: unknown, dx = 0, dy = 0, dw?: number, dh?: number): void {
    const source = (image as FakeCanvas | undefined)?.context;
    if (!source) return;
    const sourceWidth = (image as FakeCanvas).width;
    const sourceHeight = (image as FakeCanvas).height;
    const outWidth = dw ?? sourceWidth;
    const outHeight = dh ?? sourceHeight;
    source.ensurePixels();
    this.ensurePixels();
    for (let oy = 0; oy < outHeight; oy += 1) {
      const sy = sourceHeight <= 1 ? 0 : Math.min(sourceHeight - 1, Math.floor((oy * sourceHeight) / outHeight));
      for (let ox = 0; ox < outWidth; ox += 1) {
        const sx = sourceWidth <= 1 ? 0 : Math.min(sourceWidth - 1, Math.floor((ox * sourceWidth) / outWidth));
        this.writePixel(dx + ox, dy + oy, source.pixels, (sy * sourceWidth + sx) * 4);
      }
    }
    this.drawn.push({ image, dx, dy, width: outWidth, height: outHeight });
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.ensurePixels();
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        this.writePixel(x + px, y + py, new Uint8ClampedArray([0, 0, 0, 0]), 0);
      }
    }
  }

  createLinearGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
  fillRect = vi.fn();
  beginPath = vi.fn();
  moveTo = vi.fn();
  lineTo = vi.fn();
  closePath = vi.fn();
  fill = vi.fn();
  stroke = vi.fn();
  arc = vi.fn();
  save = vi.fn();
  restore = vi.fn();
  fillText = vi.fn();
  measureText = vi.fn(() => ({ width: 0 }));
}

export class FakeCanvas {
  private _width = 0;
  private _height = 0;
  readonly context: FakeCanvasRenderingContext2D;
  readonly addEventListener = vi.fn();
  readonly removeEventListener = vi.fn();

  constructor() {
    this.context = new FakeCanvasRenderingContext2D(this);
  }

  get width(): number {
    return this._width;
  }

  set width(value: number) {
    this._width = value;
    this.context.resizeBuffer();
  }

  get height(): number {
    return this._height;
  }

  set height(value: number) {
    this._height = value;
    this.context.resizeBuffer();
  }

  getContext(): FakeCanvasRenderingContext2D {
    return this.context;
  }

  toBlob(callback: (blob: Blob) => void): void {
    callback(new Blob(['fake-png'], { type: 'image/png' }));
  }
}

export function anchorElement(): { download: string; href: string; click: ReturnType<typeof vi.fn>; setAttribute: ReturnType<typeof vi.fn> } {
  const anchor = { download: '', href: '', click: vi.fn(), setAttribute: vi.fn() };
  domStubs.anchors.push(anchor);
  return anchor;
}

export interface FakeResizeObserver {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

/** Mutable stubs shared with the test files that install them. */
export const domStubs = {
  resizeObservers: [] as FakeResizeObserver[],
  raf: new Map<number, FrameRequestCallback>(),
  nextRafId: 0,
  downloads: [] as string[],
  /** Anchors handed out by `document.createElement('a')` (triggerDownload). */
  anchors: [] as Array<{ download: string; href: string; click: ReturnType<typeof vi.fn>; setAttribute: ReturnType<typeof vi.fn> }>,
};

/** Runs every queued requestAnimationFrame callback once (animations re-register for the next frame). */
export function flushRaf(time = 16): number {
  const callbacks = [...domStubs.raf.values()];
  domStubs.raf.clear();
  callbacks.forEach((callback) => callback(time));
  return callbacks.length;
}

export function rafCount(): number {
  return domStubs.raf.size;
}

/** Overrides `document.createElement` (default: canvases, or anchors for `<a>`). */
export function stubDocument(createElement: (tag: string) => unknown): void {
  vi.stubGlobal('document', {
    createElement,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

/** Installs all DOM globals the lib layer touches. Call once per test file (e.g. in `beforeAll`). */
export function installDomStubs(): void {
  domStubs.resizeObservers = [];
  domStubs.raf.clear();
  domStubs.nextRafId = 0;
  vi.stubGlobal('ImageData', FakeImageData);
  stubDocument((tag: string) => (tag === 'a' ? anchorElement() : new FakeCanvas()));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(readonly callback: ResizeObserverCallback) {
        domStubs.resizeObservers.push(this as unknown as FakeResizeObserver);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    domStubs.raf.set(++domStubs.nextRafId, callback);
    return domStubs.nextRafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    domStubs.raf.delete(id);
  });
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_url: string) {
      queueMicrotask(() => this.onload?.());
    }
  });
  // `window.setTimeout` is used by bake.ts; alias the real/global timers so
  // vi.useFakeTimers controls it too.
  vi.stubGlobal('window', globalThis);
}

/** Bridges the FakeCanvas stub to the DOM canvas types the lib layer declares
 * (SourceImage / CanvasImageSource call sites). */
export function asSourceImage(canvas: FakeCanvas): SourceImage {
  return canvas as unknown as SourceImage;
}
