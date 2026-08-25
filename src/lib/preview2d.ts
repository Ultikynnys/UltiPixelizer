import { computeContainRect } from './canvas';
import { clamp, clampPixelCoord } from './math';

/**
 * Interactive 2D texture preview for one pane: pan/zoom over the fitted
 * texture, with the fitted rect as the single source of truth shared by the
 * wireframe overlay and the eyedropper.
 *
 * The texture canvas is laid out by CSS as `object-fit: contain` inside the
 * frame (`width: 100%`, height capped), so the *fitted rect*  where the image
 * actually paints  is the canvas box's letterbox region, not the box itself.
 * This module computes that rect in frame coordinates and drives the zoom/pan
 * transform from it. The previous implementation treated the canvas box as the
 * image, which drifted the pan bounds, the wireframe overlay, and eyedropper
 * sampling on letterboxed images.
 */

export interface Preview2DApi {
  /** Reset to fit: zoom 100%, centered. */
  reset: () => void;
  /** Recompute the fitted rect (after frame resize, buffer-size change, or
   * visibility toggle), preserving the current zoom and re-clamping pan. */
  refit: () => void;
  /** Maps a viewport point to backing-pixel coordinates on the texture,
   * accounting for the fitted layout and the zoom/pan transform. Returns null
   * when the point falls outside the image or the canvas is hidden. */
  toCanvasPixel: (clientX: number, clientY: number) => { x: number; y: number } | null;
}

interface Preview2DOptions {
  canvas: HTMLCanvasElement;
  frame: HTMLElement;
  /** Optional zoom readout (a pane's caption badge). */
  badge?: HTMLButtonElement | null;
  /** Optional UV wireframe overlay, transformed in lockstep with the canvas. */
  overlay?: HTMLElement | SVGElement | null;
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 64;
/** Minimum px of the image that must stay in view while panning. */
const PAN_MARGIN = 48;

export function createPreview2D(options: Preview2DOptions): Preview2DApi {
  const { canvas, frame, badge = null, overlay = null } = options;

  let zoom = 1;
  let panX = 0;
  let panY = 0;

  // Image-repeat diagnostic: the renderer tiles the backing buffer 3×3 and
  // marks the canvas `repeat-tiled`; display it at 3× so each tile keeps the
  // single-tile size. A pure transform  layout never moves, and the grid
  // overflows the frame until the user scrolls out.
  const tileFactor = (): number => (canvas.classList.contains('repeat-tiled') ? 3 : 1);

  // The fitted image rect in frame coordinates. The transform origin anchors
  // zoom/pan: the image's top-left (the letterbox offset) for single-tile
  // canvases, or the box CENTER for the tiled grid  scaling then keeps the
  // center tile pinned to the window center at the default zoom. origin* is
  // element-relative; originFrame* is its frame-space position (what the
  // overlay, which fills the frame, must use for its own origin).
  let rect = { left: 0, top: 0, width: 0, height: 0 };
  let innerLeft = 0;
  let innerTop = 0;
  let originX = 0;
  let originY = 0;
  let originFrameX = 0;
  let originFrameY = 0;

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let dragging = false;
  let dragOrigin = { pointerX: 0, pointerY: 0, panX: 0, panY: 0 };
  let transformFrame = 0;
  let refitPending = false;

  function computeFit(): void {
    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    const boxWidth = canvas.offsetWidth;
    const boxHeight = canvas.offsetHeight;
    if (frameWidth <= 0 || frameHeight <= 0 || boxWidth <= 0 || boxHeight <= 0 || canvas.width <= 0 || canvas.height <= 0) {
      rect = { left: 0, top: 0, width: 0, height: 0 };
      innerLeft = 0;
      innerTop = 0;
      originX = 0;
      originY = 0;
      originFrameX = 0;
      originFrameY = 0;
      return;
    }
    // The canvas is flex-centered in the frame; object-fit: contain letterboxes
    // the buffer inside its own box, so the image's frame-space rect is the
    // box's position plus the letterbox offset.
    const boxLeft = (frameWidth - boxWidth) / 2;
    const boxTop = (frameHeight - boxHeight) / 2;
    const inner = computeContainRect(boxWidth, boxHeight, canvas.width, canvas.height);
    rect = { left: boxLeft + inner.left, top: boxTop + inner.top, width: inner.width, height: inner.height };
    innerLeft = inner.left;
    innerTop = inner.top;
    if (tileFactor() === 3) {
      // The tiled grid scales around the box center: at the default zoom the
      // CENTER tile fills the window (neighbor seams peek in at the margins).
      originX = boxWidth / 2;
      originY = boxHeight / 2;
    } else {
      originX = inner.left;
      originY = inner.top;
    }
    originFrameX = boxLeft + originX;
    originFrameY = boxTop + originY;
  }

  function apply(): void {
    transformFrame = 0;
    const scale = zoom * tileFactor();
    // The texture uses nearest-neighbor rendering. Fractional translation makes
    // its pixel grid repeatedly snap between adjacent device pixels while
    // dragging, which appears as back-and-forth flicker. Keep precise pan state
    // internally for zoom/sampling math, but rasterize both layers at one stable
    // device-pixel position.
    const deviceScale = window.devicePixelRatio || 1;
    const renderedPanX = Math.round(panX * deviceScale) / deviceScale;
    const renderedPanY = Math.round(panY * deviceScale) / deviceScale;
    const transform = `translate(${renderedPanX}px, ${renderedPanY}px) scale(${scale})`;
    canvas.style.transformOrigin = `${originX}px ${originY}px`;
    canvas.style.transform = transform;
    if (overlay) {
      // The overlay fills the frame and strokes the wireframe in frame space,
      // so its transform-origin is the origin's frame-space position  the
      // same visual point as the canvas's origin  keeping the two aligned.
      overlay.style.transformOrigin = `${originFrameX}px ${originFrameY}px`;
      overlay.style.transform = transform;
    }
    if (badge) badge.textContent = `${Math.round(zoom * 100)}%`;
  }

  // Pointer devices can deliver several moves before the browser paints. Keep
  // one transform writer and commit only the latest logical pan/zoom state.
  function scheduleApply(): void {
    if (transformFrame) return;
    transformFrame = requestAnimationFrame(apply);
  }

  /** The image's top-left frame position at pan (0,0) for a given scale. The
   * origin fixes one point of the image; the corner hangs from it by the
   * image's element-space offset (the letterbox for single tiles, the box
   * center for the tiled grid). */
  function imageCorner(scale: number): { left: number; top: number } {
    return {
      left: originFrameX + (innerLeft - originX) * scale,
      top: originFrameY + (innerTop - originY) * scale,
    };
  }

  /** Keep a sliver of the image in view: it may slide past the frame edges
   * (revealing the backdrop) but can never be lost entirely. Bounds are in
   * frame space, against the fitted rect (not the letterboxed canvas box). */
  function clampPan(allowSmallImagePan = false): void {
    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    const scale = zoom * tileFactor();
    const corner = imageCorner(scale);
    const imageWidth = rect.width * scale;
    const imageHeight = rect.height * scale;
    const margin = Math.min(PAN_MARGIN, frameWidth, frameHeight);
    const minX = margin - corner.left - imageWidth; // image right edge ≥ margin
    const maxX = frameWidth - margin - corner.left; // image left edge ≤ frameWidth − margin
    const minY = margin - corner.top - imageHeight;
    const maxY = frameHeight - margin - corner.top;
    const centerX = (frameWidth - imageWidth) / 2 - corner.left;
    const centerY = (frameHeight - imageHeight) / 2 - corner.top;
    // At fit zoom both edge constraints cannot hold simultaneously. During a
    // drag, use the interval between those constraints instead of forcing the
    // image back to center on every move; zoom/refit still center small images.
    panX = minX > maxX
      ? (allowSmallImagePan ? clamp(panX, maxX, minX) : centerX)
      : clamp(panX, minX, maxX);
    panY = minY > maxY
      ? (allowSmallImagePan ? clamp(panY, maxY, minY) : centerY)
      : clamp(panY, minY, maxY);
  }

  /** Zooms so the frame-space point (cursorX, cursorY) stays under the cursor. */
  function zoomAt(cursorX: number, cursorY: number, nextZoom: number): void {
    const factor = nextZoom / zoom;
    // Anchored against the image's top-left (rect.left/top): the cursor's
    // offset from that origin is preserved across the zoom.
    const anchorX = cursorX - originFrameX;
    const anchorY = cursorY - originFrameY;
    panX = anchorX - (anchorX - panX) * factor;
    panY = anchorY - (anchorY - panY) * factor;
    zoom = nextZoom;
    clampPan();
    scheduleApply();
  }

  function refit(): void {
    if (pointers.size > 0) {
      refitPending = true;
      return;
    }
    computeFit();
    clampPan();
    apply();
  }

  /** Image-repeat toggle: the renderer flips `repeat-tiled` and retiles the
   * backing buffer 3×3 in the same render pass. Re-anchor pan so the CENTER
   * tile occupies exactly the screen region the single image occupied  and
   * vice versa  keeping the center image visually pinned across the toggle.
   * The anchor rect is the whole image when single, the middle tile when
   * tiled; the new pan solves screen_new(anchor_new) == screen_old(anchor_old).
   * Both directions are exact inverses, so toggling back restores the view.
   * Pan is NOT re-clamped here: exactness wins over the pan margin (reset is
   * the escape hatch). */
  function remapPanOnTileToggle(previousClass: string): void {
    if (rect.width <= 0 || rect.height <= 0 || canvas.offsetWidth <= 0 || canvas.offsetHeight <= 0) {
      computeFit();
      apply();
      return;
    }
    const newFactor = tileFactor() === 3 ? 3 : 1;
    const oldFactor = previousClass.includes('repeat-tiled') ? 3 : 1;
    const boxLeft = (frame.clientWidth - canvas.offsetWidth) / 2;
    const boxTop = (frame.clientHeight - canvas.offsetHeight) / 2;
    // Old side: the stored fit is the geometry the user was looking at; the
    // anchor is the whole-image rect (single) or the middle third (tiled).
    const oldOriginX = oldFactor === 3 ? boxLeft + canvas.offsetWidth / 2 : rect.left;
    const oldOriginY = oldFactor === 3 ? boxTop + canvas.offsetHeight / 2 : rect.top;
    const oldAnchorX = oldFactor === 3 ? rect.left + rect.width / 3 : rect.left;
    const oldAnchorY = oldFactor === 3 ? rect.top + rect.height / 3 : rect.top;
    const anchorScreenX = oldOriginX + (oldAnchorX - oldOriginX) * zoom * oldFactor + panX;
    const anchorScreenY = oldOriginY + (oldAnchorY - oldOriginY) * zoom * oldFactor + panY;
    // New side: recompute the fit under the flipped class. The retiled buffer
    // keeps the same aspect, so the rect is unchanged and only the origin
    // (image top-left vs box center) and the display scale (1 vs 3) move.
    computeFit();
    const newAnchorX = newFactor === 3 ? rect.left + rect.width / 3 : rect.left;
    const newAnchorY = newFactor === 3 ? rect.top + rect.height / 3 : rect.top;
    panX = anchorScreenX - originFrameX - (newAnchorX - originFrameX) * zoom * newFactor;
    panY = anchorScreenY - originFrameY - (newAnchorY - originFrameY) * zoom * newFactor;
    // The remap is an exact inverse, so a pan that should be zero arrives as
    // float noise (e.g. 3.55e-15)  snap it, or the transform string ends up
    // with scientific-notation px values.
    if (Math.abs(panX) < 1e-9) panX = 0;
    if (Math.abs(panY) < 1e-9) panY = 0;
    apply();
  }

  function reset(): void {
    zoom = 1;
    panX = 0;
    panY = 0;
    clampPan();
    apply();
  }

  function toCanvasPixel(clientX: number, clientY: number): { x: number; y: number } | null {
    if (canvas.hidden || rect.width <= 0 || rect.height <= 0) return null;
    const frameRect = frame.getBoundingClientRect();
    const scale = zoom * tileFactor();
    const corner = imageCorner(scale);
    const u = (clientX - frameRect.left - corner.left - panX) / (scale * rect.width);
    const v = (clientY - frameRect.top - corner.top - panY) / (scale * rect.height);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    const x = clampPixelCoord(u * canvas.width, canvas.width);
    const y = clampPixelCoord(v * canvas.height, canvas.height);
    return { x, y };
  }

  const interactionsBlocked = (): boolean => document.body.classList.contains('eyedropping');

  // Cursor position in frame coordinates (independent of the canvas transform).
  const cursorInFrame = (clientX: number, clientY: number): { x: number; y: number } => {
    const frameRect = frame.getBoundingClientRect();
    return { x: clientX - frameRect.left, y: clientY - frameRect.top };
  };

  // Only presses on the pan surface itself start a pan: the canvas, the
  // wireframe overlay when visible, or the frame's backdrop. The frame's
  // control chips sit on top of the backdrop and are not pan surfaces.
  const isPanSurface = (target: EventTarget | null): boolean =>
    target === frame || target === canvas || target === overlay;

  frame.addEventListener('wheel', (event) => {
    if (interactionsBlocked() || canvas.hidden || !isPanSurface(event.target)) return;
    // preventDefault also stops the webview's ctrl+wheel page zoom.
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(-delta * 0.002);
    const { x, y } = cursorInFrame(event.clientX, event.clientY);
    zoomAt(x, y, clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX));
  }, { passive: false });

  frame.addEventListener('pointerdown', (event) => {
    if (interactionsBlocked() || canvas.hidden || event.button !== 0 || !isPanSurface(event.target)) return;
    // No preventDefault here: canceling pointerdown would suppress the
    // compatibility mouse events, killing double-click-to-reset.
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [first, second] = Array.from(pointers.values());
      pinchDistance = Math.hypot(first.x - second.x, first.y - second.y);
      dragging = false;
    } else if (pointers.size === 1) {
      dragging = true;
      dragOrigin = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        panX,
        panY,
      };
    }
  });

  // Drag moves listen on the window, not the canvas: WebView2 does not
  // reliably deliver pointermove to a captured element, so a canvas-bound
  // listener would leave drag-pan dead in the desktop app.
  window.addEventListener('pointermove', (event) => {
    if (interactionsBlocked() || canvas.hidden) return;
    // A pointerup was missed (button released outside the window): end the drag.
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
      endPointer(event);
      return;
    }
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);
    if (pointers.size === 2) {
      const [first, second] = Array.from(pointers.values());
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (pinchDistance > 0) {
        const { x, y } = cursorInFrame((first.x + second.x) / 2, (first.y + second.y) / 2);
        zoomAt(x, y, clamp(zoom * (distance / pinchDistance), ZOOM_MIN, ZOOM_MAX));
      }
      pinchDistance = distance;
      return;
    }
    if (!dragging) return;
    // Derive position from the pointer-down snapshot instead of accumulating
    // event deltas. Dropped/coalesced pointermove events cannot introduce drift.
    panX = dragOrigin.panX + current.x - dragOrigin.pointerX;
    panY = dragOrigin.panY + current.y - dragOrigin.pointerY;
    clampPan(true);
    scheduleApply();
  });

  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) {
      dragging = false;
      if (refitPending) {
        refitPending = false;
        refit();
      } else {
        scheduleApply();
      }
    }
  };
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  frame.addEventListener('dblclick', (event) => {
    if (interactionsBlocked() || canvas.hidden || !isPanSurface(event.target)) return;
    event.preventDefault();
    reset();
  });

  badge?.addEventListener('click', reset);

  // Recompute the fitted rect whenever the canvas's box size changes (frame
  // resize, pane visibility toggles) or its backing buffer changes (render).
  const resizeObserver = new ResizeObserver(() => refit());
  resizeObserver.observe(canvas);
  const bufferObserver = new MutationObserver((records) => {
    // The image-repeat toggle retiles the backing buffer 3×3 and flips
    // `repeat-tiled` in the same render pass. That flip re-anchors pan so the
    // center tile lands exactly where the single image was  the toggle must
    // not move the center image. Any other buffer change refits as before.
    const classRecord = records.find((record) => record.attributeName === 'class');
    if (classRecord) remapPanOnTileToggle(classRecord.oldValue ?? '');
    else refit();
  });
  // attributeOldValue captures the pre-flip class list, which is what tells
  // the remap which view (single vs tiled) the user is coming from.
  bufferObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height', 'class'], attributeOldValue: true });

  refit();

  return { reset, refit, toCanvasPixel };
}
