import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview2D, type Preview2DApi } from '../src/lib/preview2d';
import { domStubs, installDomStubs } from './helpers/domStubs';

/**
 * DOM stubs for preview2d.ts (node environment, no jsdom).
 *
 * preview2d drives transforms and pan/zoom from layout metrics the node
 * environment can't measure, so the harness fakes the surfaces it touches:
 * `clientWidth/Height` and `offsetWidth/Height` feed the fitted-rect math,
 * `getBoundingClientRect` anchors cursor math, and `style` records the
 * transforms it writes. `addEventListener` captures handlers so tests can
 * dispatch wheel / pointer / click / dblclick events at the frame, the badge,
 * and the window (globalThis).
 *
 * Layout used by most tests: frame 500×300, canvas box 400×200 with a
 * 200×100 backing buffer → fitted rect {50, 50, 400, 200}, origin (0, 0).
 */

interface FakeEventInit extends Record<string, unknown> {}

class FakeSurface {
  style: Record<string, string> = {};
  hidden = false;
  clientWidth = 0;
  clientHeight = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  width = 0;
  height = 0;
  textContent = '';
  private listeners = new Map<string, Array<(event: FakeEventInit) => void>>();

  constructor(overrides: Partial<FakeSurface> = {}) {
    Object.assign(this, overrides);
  }

  addEventListener(type: string, handler: (event: FakeEventInit) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {
    /* no-op — preview2d never removes its own listeners */
  }

  /** Fires every listener for `type` with `event` merged over defaults
   * (target = this, preventDefault = no-op). */
  dispatch(type: string, event: FakeEventInit = {}): void {
    const payload: FakeEventInit = { target: this, preventDefault: vi.fn(), ...event };
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
}

interface PreviewHarness {
  api: Preview2DApi;
  canvas: FakeSurface;
  frame: FakeSurface;
  overlay?: FakeSurface;
  badge?: FakeSurface;
  resizeCallback: () => void;
  mutationCallback: () => void;
}

const mutationObservers: Array<{ callback: MutationCallback; observe: ReturnType<typeof vi.fn> }> = [];

/** The window is another fake surface: node's globalThis has no
 * addEventListener, and a fresh instance per test keeps drag listeners from
 * one test leaking into the next. */
let windowSurface: FakeSurface;

function stubWindow(): void {
  windowSurface = new FakeSurface();
  vi.stubGlobal('window', windowSurface);
}

/** Node has no MutationObserver; install a capturing stub (preview2d observes
 * the canvas backing-buffer attributes). */
function stubMutationObserver(): void {
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(readonly callback: MutationCallback) {
        mutationObservers.push({ callback, observe: this.observe });
      }
      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    },
  );
}

/** installDomStubs' document has no body; preview2d's interaction guard reads
 * `document.body.classList` (the eyedropping flag). */
function stubDocumentBody(eyedropping: boolean): void {
  vi.stubGlobal('document', {
    createElement: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    body: { classList: { contains: vi.fn(() => eyedropping) } },
  });
}

function makePreview(options: { overlay?: boolean; badge?: boolean; canvas?: Partial<FakeSurface>; frame?: Partial<FakeSurface> } = {}): PreviewHarness {
  const canvas = new FakeSurface({ width: 200, height: 100, offsetWidth: 400, offsetHeight: 200, ...options.canvas });
  const frame = new FakeSurface({ clientWidth: 500, clientHeight: 300, ...options.frame });
  const overlay = options.overlay ? new FakeSurface() : undefined;
  const badge = options.badge ? new FakeSurface() : undefined;
  const api = createPreview2D({
    canvas: canvas as unknown as HTMLCanvasElement,
    frame: frame as unknown as HTMLElement,
    badge: badge as unknown as HTMLButtonElement,
    overlay: overlay as unknown as HTMLElement,
  });
  return {
    api,
    canvas,
    frame,
    overlay,
    badge,
    resizeCallback: () => domStubs.resizeObservers.at(-1)!.callback([], null as unknown as ResizeObserver),
    mutationCallback: () => mutationObservers.at(-1)!.callback([], null as unknown as MutationObserver),
  };
}

/** Parses the `translate(Xpx, Ypx) scale(S)` transform preview2d writes. */
function readTransform(surface: FakeSurface): { x: number; y: number; scale: number } | null {
  const match = /translate\((-?[0-9.]+)px, (-?[0-9.]+)px\) scale\(([0-9.]+)\)/.exec(surface.style.transform ?? '');
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

/** Dispatches a window-level event (pan/zoom listen on the window). */
function windowEvent(type: string, props: FakeEventInit): void {
  windowSurface.dispatch(type, props);
}

/** Dispatches a wheel event on the frame, where the listener lives. */
function frameWheel(frame: FakeSurface, event: FakeEventInit): void {
  frame.dispatch('wheel', event);
}

/** The wheel handler's zoom factor for a vertical scroll of `deltaY`. */
function wheelZoom(deltaY: number): number {
  return Math.exp(-deltaY * 0.002);
}

beforeAll(() => {
  installDomStubs();
});

afterEach(() => {
  installDomStubs();
});

beforeEach(() => {
  mutationObservers.length = 0;
  stubMutationObserver();
  stubDocumentBody(false);
  stubWindow();
});

describe('initial fit', () => {
  it('applies the centered contain-fit transform and writes the 100% badge', () => {
    const { canvas, frame, overlay, badge } = makePreview({ overlay: true, badge: true });

    expect(readTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(canvas.style.transformOrigin).toBe('0px 0px');
    expect(overlay!.style.transform).toBe(canvas.style.transform);
    expect(overlay!.style.transformOrigin).toBe('50px 50px');
    expect(frame.style.transform).toBeUndefined();
    expect(badge!.textContent).toBe('100%');
  });

  it('works without an overlay or badge', () => {
    const { api, canvas } = makePreview();
    expect(readTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(api.reset).toBeTypeOf('function');
    expect(api.refit).toBeTypeOf('function');
  });
});

describe('wheel zoom', () => {
  it('zooms toward the cursor and mirrors the level in the badge', () => {
    const { canvas, frame, badge } = makePreview({ badge: true });
    frameWheel(frame, { deltaMode: 0, deltaY: -100, clientX: 250, clientY: 150 });

    const transform = readTransform(canvas)!;
    expect(transform.scale).toBeCloseTo(wheelZoom(-100), 5);
    expect(transform.x).toBeCloseTo(-44.28, 1);
    expect(transform.y).toBeCloseTo(-22.14, 1);
    expect(badge!.textContent).toBe('122%');
  });

  it('clamps zoom to the configured maximum', () => {
    const { canvas, frame, badge } = makePreview({ badge: true });
    frameWheel(frame, { deltaMode: 0, deltaY: -4000, clientX: 250, clientY: 150 });
    expect(readTransform(canvas)!.scale).toBe(64);
    expect(badge!.textContent).toBe('6400%');
  });

  it('clamps zoom to the configured minimum', () => {
    const { canvas, frame, badge } = makePreview({ badge: true });
    frameWheel(frame, { deltaMode: 0, deltaY: 2000, clientX: 250, clientY: 150 });
    expect(readTransform(canvas)!.scale).toBe(0.1);
    expect(badge!.textContent).toBe('10%');
  });

  it('treats line-mode deltas as 16px steps', () => {
    const { canvas, frame } = makePreview();
    frameWheel(frame, { deltaMode: 1, deltaY: -100, clientX: 250, clientY: 150 });
    expect(readTransform(canvas)!.scale).toBeCloseTo(wheelZoom(-100 * 16), 5);
  });

  it('ignores wheel events off the pan surface', () => {
    const { canvas, frame } = makePreview();
    const other = new FakeSurface();
    frame.dispatch('wheel', { deltaMode: 0, deltaY: -100, clientX: 250, clientY: 150, target: other });
    expect(readTransform(canvas)!.scale).toBe(1);
  });

  it('ignores wheel events while eyedropping', () => {
    stubDocumentBody(true);
    const { canvas, frame } = makePreview();
    frameWheel(frame, { deltaMode: 0, deltaY: -100, clientX: 250, clientY: 150 });
    expect(readTransform(canvas)!.scale).toBe(1);
  });

  it('ignores wheel events while the canvas is hidden', () => {
    const { canvas, frame } = makePreview();
    canvas.hidden = true;
    frameWheel(frame, { deltaMode: 0, deltaY: -100, clientX: 250, clientY: 150 });
    expect(readTransform(canvas)!.scale).toBe(1);
  });

  it('centers a zoomed-out image that is smaller than the frame', () => {
    const { canvas, frame } = makePreview({ canvas: { offsetWidth: 300, offsetHeight: 200 }, frame: { clientWidth: 40, clientHeight: 40 } });
    frameWheel(frame, { deltaMode: 0, deltaY: 2000, clientX: 20, clientY: 20 });
    // image 300×150 at 0.1 → 30×15, smaller than the 40×40 frame with its
    // 40px pan margin: the image centers instead of clamping to a margin.
    expect(readTransform(canvas)).toEqual({ x: 135, y: 67.5, scale: 0.1 });
  });
});

describe('pan', () => {
  it('drags to pan and clamps at the frame margin', () => {
    const { canvas, frame } = makePreview();
    frame.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    windowEvent('pointermove', { pointerId: 1, clientX: 130, clientY: 120, pointerType: 'mouse', buttons: 1 });
    windowEvent('pointerup', { pointerId: 1, pointerType: 'mouse', buttons: 0 });

    expect(readTransform(canvas)).toEqual({ x: 30, y: 20, scale: 1 });

    // A second drag beyond the clamp pushes to the edge, not past it.
    frame.dispatch('pointerdown', { pointerId: 2, clientX: 300, clientY: 150, button: 0 });
    windowEvent('pointermove', { pointerId: 2, clientX: 800, clientY: 150, pointerType: 'mouse', buttons: 1 });
    expect(readTransform(canvas)!.x).toBe(402);
    expect(readTransform(canvas)!.y).toBe(20);
  });

  it('does not start a drag off the pan surface or with a non-primary button', () => {
    const { canvas, frame } = makePreview();
    const other = new FakeSurface();
    frame.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0, target: other });
    frame.dispatch('pointerdown', { pointerId: 2, clientX: 100, clientY: 100, button: 2 });
    windowEvent('pointermove', { pointerId: 1, clientX: 130, clientY: 120, pointerType: 'mouse', buttons: 1 });
    windowEvent('pointermove', { pointerId: 2, clientX: 130, clientY: 120, pointerType: 'mouse', buttons: 1 });
    expect(readTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('does not start a drag while eyedropping', () => {
    stubDocumentBody(true);
    const { canvas, frame } = makePreview();
    frame.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    windowEvent('pointermove', { pointerId: 1, clientX: 130, clientY: 120, pointerType: 'mouse', buttons: 1 });
    expect(readTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('ends a drag when the mouse button is released outside the window', () => {
    const { canvas, frame } = makePreview();
    frame.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    windowEvent('pointermove', { pointerId: 1, clientX: 130, clientY: 120, pointerType: 'mouse', buttons: 1 });
    // Missed pointerup: the next move reports buttons === 0 → drag ends.
    windowEvent('pointermove', { pointerId: 1, clientX: 160, clientY: 150, pointerType: 'mouse', buttons: 0 });
    windowEvent('pointermove', { pointerId: 1, clientX: 190, clientY: 180, pointerType: 'mouse', buttons: 1 });
    expect(readTransform(canvas)).toEqual({ x: 30, y: 20, scale: 1 });
  });

  it('pinches to zoom with two pointers', () => {
    const { canvas, frame, badge } = makePreview({ badge: true });
    frame.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    frame.dispatch('pointerdown', { pointerId: 2, clientX: 200, clientY: 100, button: 0 });
    windowEvent('pointermove', { pointerId: 1, clientX: 100, clientY: 100, pointerType: 'touch', buttons: 1 });
    windowEvent('pointermove', { pointerId: 2, clientX: 300, clientY: 100, pointerType: 'touch', buttons: 1 });

    expect(readTransform(canvas)!.scale).toBe(2);
    expect(badge!.textContent).toBe('200%');

    windowEvent('pointerup', { pointerId: 1, pointerType: 'touch', buttons: 0 });
    windowEvent('pointerup', { pointerId: 2, pointerType: 'touch', buttons: 0 });
    // A stray single-pointer move after the pinch does not pan.
    windowEvent('pointermove', { pointerId: 1, clientX: 400, clientY: 200, pointerType: 'touch', buttons: 1 });
    expect(readTransform(canvas)!.scale).toBe(2);
  });
});

describe('reset', () => {
  it('resets zoom and pan on double-click', () => {
    const { canvas, frame, badge } = makePreview({ badge: true });
    frameWheel(frame, { deltaMode: 0, deltaY: -100, clientX: 250, clientY: 150 });
    frame.dispatch('dblclick', {});
    expect(readTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(badge!.textContent).toBe('100%');
  });

  it('ignores double-click while the canvas is hidden', () => {
    const { canvas, frame } = makePreview();
    frameWheel(frame, { deltaMode: 0, deltaY: -100, clientX: 250, clientY: 150 });
    canvas.hidden = true;
    frame.dispatch('dblclick', {});
    expect(readTransform(canvas)!.scale).toBeCloseTo(wheelZoom(-100), 5);
  });

  it('resets zoom from the caption badge', () => {
    const { canvas, frame, badge } = makePreview({ badge: true });
    frameWheel(frame, { deltaMode: 0, deltaY: -100, clientX: 250, clientY: 150 });
    badge!.dispatch('click', {});
    expect(readTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe('refit', () => {
  it('recomputes the fit on frame resize, preserving zoom', () => {
    const { canvas, frame, overlay, resizeCallback } = makePreview({ overlay: true });
    frameWheel(frame, { deltaMode: 0, deltaY: -100, clientX: 250, clientY: 150 });
    frame.clientWidth = 600;
    resizeCallback();

    expect(overlay!.style.transformOrigin).toBe('100px 50px');
    expect(readTransform(canvas)!.scale).toBeCloseTo(wheelZoom(-100), 5);
  });

  it('recomputes the fit when the backing buffer resizes', () => {
    const { canvas, overlay, mutationCallback } = makePreview({ overlay: true });
    canvas.width = 300;
    mutationCallback();
    // Backing 300×100 in a 400×200 box → contain-fit 400×133.33, letterboxed
    // 33.33px down inside the box, which sits 50px down in the frame.
    const origin = /^(\d+(?:\.\d+)?)px (\d+(?:\.\d+)?)px$/.exec(overlay!.style.transformOrigin)!;
    expect(Number(origin[2])).toBeCloseTo(83.33, 1);
  });

  it('tolerates a zero-sized frame without crashing', () => {
    const { canvas, api, frame, resizeCallback } = makePreview();
    frame.clientWidth = 0;
    frame.clientHeight = 0;
    resizeCallback();
    expect(readTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(api.toCanvasPixel(10, 10)).toBeNull();
  });
});

describe('toCanvasPixel', () => {
  it('maps frame points to backing pixels through the fitted rect', () => {
    const { api } = makePreview();
    expect(api.toCanvasPixel(250, 150)).toEqual({ x: 100, y: 50 });
  });

  it('returns null outside the image, for hidden canvases, and unmeasured frames', () => {
    const { api, canvas, frame } = makePreview();
    expect(api.toCanvasPixel(10, 150)).toBeNull();
    canvas.hidden = true;
    expect(api.toCanvasPixel(250, 150)).toBeNull();
    canvas.hidden = false;
    frame.clientWidth = 0;
    api.refit();
    expect(api.toCanvasPixel(250, 150)).toBeNull();
  });
});
