import { clampPixelCoord } from './math';
import { rgbToHex } from './palettes';

/**
 * Custom in-app eyedropper sampling.
 *
 * The native EyeDropper API samples anywhere on screen, but its picker window
 * takes ~1s to appear in Chromium/WebView2  browser-internal startup that no
 * JS can remove. This module replaces it with an instant picker over the app's
 * own rendering: exact backing pixels from 2D canvases (the texture previews),
 * falling back to the nearest opaque solid background (palette chips, panels,
 * page chrome) for everything else. It deliberately does not reach outside the
 * window.
 */

/** Parses a computed `rgb(...)`/`rgba(...)`/`#rrggbb` color string into a
 * lowercase hex. Returns null for `transparent`, malformed values, or alpha < 1
 *  a translucent fill shows the backdrop through it, so the color at that
 * point is really whatever sits behind it. */
export function colorStringToHex(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'transparent') return null;
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  const match = trimmed.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+)\s*)?\)$/);
  if (!match) return null;
  if (match[4] !== undefined && parseFloat(match[4]) < 1) return null;
  return rgbToHex(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Backing-pixel coordinates for a viewport point on a canvas, accounting for
 * CSS scaling and `object-fit` letterboxing (contain/cover/scale-down center
 * the content inside a mismatched box). Returns null when the point falls on
 * a letterbox bar (the canvas isn't painted there) or the canvas is hidden. */
export function canvasPixelCoords(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0 || canvas.width === 0 || canvas.height === 0) return null;
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  let left = 0;
  let top = 0;
  let drawWidth = rect.width;
  let drawHeight = rect.height;
  const objectFit = typeof getComputedStyle === 'function' ? getComputedStyle(canvas).objectFit : 'fill';
  if (objectFit === 'contain' || objectFit === 'cover' || objectFit === 'scale-down') {
    const scale = objectFit === 'cover'
      ? Math.max(rect.width / canvas.width, rect.height / canvas.height)
      : Math.min(rect.width / canvas.width, rect.height / canvas.height);
    drawWidth = canvas.width * scale;
    drawHeight = canvas.height * scale;
    left = (rect.width - drawWidth) / 2;
    top = (rect.height - drawHeight) / 2;
  }
  if (localX < left || localX >= left + drawWidth || localY < top || localY >= top + drawHeight) return null;
  const x = clampPixelCoord(((localX - left) / drawWidth) * canvas.width, canvas.width);
  const y = clampPixelCoord(((localY - top) / drawHeight) * canvas.height, canvas.height);
  return { x, y };
}

/** Exact color of the backing pixel under a viewport point, or null when the
 * canvas has no readable context or the pixel is fully transparent. Reads 2D
 * canvases (the texture previews) directly and falls back to the preserved
 * drawing buffer of WebGL canvases (the 3D model viewports). */
export function canvasColorAt(canvas: HTMLCanvasElement, clientX: number, clientY: number): string | null {
  const coords = canvasPixelCoords(canvas, clientX, clientY);
  if (!coords) return null;
  const context = canvas.getContext('2d');
  if (context) {
    const [r, g, b, a] = context.getImageData(coords.x, coords.y, 1, 1).data;
    if (a === 0) return null;
    return rgbToHex(r, g, b);
  }
  return webglCanvasColorAt(canvas, coords.x, coords.y);
}

/** Reads a single backing pixel from a WebGL canvas. The model viewports keep
 * preserveDrawingBuffer on, so the buffer survives compositing. readPixels is
 * bottom-up, so the row flips to match the DOM's top-left origin. */
export function webglCanvasColorAt(canvas: HTMLCanvasElement, x: number, y: number): string | null {
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return null;
  const pixel = new Uint8Array(4);
  gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  if (pixel[3] === 0) return null;
  return rgbToHex(pixel[0], pixel[1], pixel[2]);
}

/** Walks up from `element` (inclusive) to the nearest opaque solid
 * `background-color`. Transparent layers are skipped so the visible color of
 * nested chips/panels resolves to the layer that actually paints it. */
export function solidBackgroundHex(element: Element | null): string | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const hex = colorStringToHex(getComputedStyle(node).backgroundColor);
    if (hex) return hex;
  }
  return null;
}

/** The color rendered at a viewport point: exact canvas pixels when the
 * topmost element is a readable canvas (2D texture previews or preserved 3D
 * model viewports), otherwise the nearest solid background (chips, panels,
 * page chrome). Null when nothing paints an opaque color there. */
export function sampleColorAt(clientX: number, clientY: number): string | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (element && typeof (element as HTMLCanvasElement).getContext === 'function') {
    const fromCanvas = canvasColorAt(element as HTMLCanvasElement, clientX, clientY);
    if (fromCanvas) return fromCanvas;
  }
  return solidBackgroundHex(element);
}
