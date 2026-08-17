import type { Object3D } from 'three';
import { createCanvas, factorsToCanvas } from '../canvas';
import type { SourceImage } from '../state';
import { UV_OVERLAP_LABEL, collectUVTriangles, computeUVOverlap, type UVTriangle } from '../uvOverlap';
import type { RendererDeps, RenderShared } from './types';

export interface OverlayApi {
  refreshUVWireframe: () => void;
  refreshUVOverlap: () => void;
  /** Forces the next refreshUVOverlap to recompute — call after any in-place
   * change to the AO scene's UVs/visibility/rotation. */
  invalidateUVOverlap: () => void;
  /** Re-draws the display-resolution UV wireframe overlays — visibility,
   * letterbox mapping, and strokes — after the toggle, pane mode, frame
   * resize, or texture bitmap size changes. */
  syncWireframeOverlays: () => void;
  reset: () => void;
}

export function createOverlay(deps: RendererDeps, shared: RenderShared): OverlayApi {
  const {
    state,
    textures,
    originalCanvas,
    previewCanvas,
    wireframeOverlays,
    forEachViewport,
    getAOScene,
    getOriginalPreviewMode,
    getProcessedPreviewMode,
  } = deps;
  const { original: originalWireframeOverlay, processed: processedWireframeOverlay } = wireframeOverlays;

  let uvOverlapMaskCanvas: HTMLCanvasElement | null = null;
  let uvWireframeTriangles: UVTriangle[] | null = null;
  let uvWaveCanvas: HTMLCanvasElement | null = null;
  let uvOverlayComposite: HTMLCanvasElement | null = null;
  let uvOverlayFrame = 0;
  // Last-computed overlap context. The mask depends only on the scene's UVs
  // (model, UV channel, LOD, world axis) and the mask resolution — both stable
  // across basecolor swaps and ribbon refreshes — so a warm cache skips the
  // ~150ms per-triangle re-rasterization on a 60k-tri model.
  let uvOverlapCache: { scene: Object3D | null; width: number; height: number } | null = null;

  function uvOverlapResolution(source: SourceImage): { width: number; height: number } {
    const maxDimension = Math.max(source.width, source.height);
    const scale = maxDimension > 1024 ? 1024 / maxDimension : 1;
    return {
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale)),
    };
  }

  function uvOverlapMask(counts: Uint8Array, width: number, height: number): HTMLCanvasElement {
    return factorsToCanvas(counts, width, height, (value) => value >= 2 ? 255 : null);
  }

  function refreshUVWireframe(): void {
    const scene = getAOScene();
    uvWireframeTriangles = scene ? collectUVTriangles(scene) : null;
    syncWireframeOverlays();
  }

  function refreshUVOverlap(): void {
    const scene = getAOScene();
    if (!state.showUVOverlap || !scene) {
      uvOverlapMaskCanvas = null;
      forEachViewport((viewport) => viewport.setUVOverlap(null));
      refreshUVWireframe();
      stopUVOverlayAnimation();
      return;
    }
    refreshUVWireframe();
    const source = textures.base.image!;
    const { width, height } = uvOverlapResolution(source);
    if (uvOverlapCache && uvOverlapCache.scene === scene && uvOverlapCache.width === width && uvOverlapCache.height === height) {
      // Nothing changed — the mask canvas and 3D highlight are still valid.
      // Just resume the animation if a toggle-off earlier stopped it.
      startUVOverlayAnimation();
      return;
    }
    uvOverlapCache = { scene, width, height };
    uvOverlapMaskCanvas = null;
    forEachViewport((viewport) => viewport.setUVOverlap(null));
    const result = computeUVOverlap(scene, width, height);
    uvOverlapMaskCanvas = uvOverlapMask(result.counts, width, height);
    forEachViewport((viewport) => viewport.setUVOverlap(result.overlapping));
    startUVOverlayAnimation();
  }

  function invalidateUVOverlap(): void {
    uvOverlapCache = null;
  }

  function renderWaveTile(time: number): HTMLCanvasElement {
    const size = 256;
    if (!uvWaveCanvas) uvWaveCanvas = createCanvas(size, size).canvas;
    const context = uvWaveCanvas.getContext('2d');
    if (!context) return uvWaveCanvas;
    const image = context.createImageData(size, size);
    const data = image.data;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const a = 0.5 + 0.5 * Math.sin((x + y) * 0.14 - time * 0.004);
        const b = 0.5 + 0.5 * Math.sin((x - y) * 0.1 - time * 0.003);
        const intensity = a * 0.7 + b * 0.3;
        const offset = (y * size + x) * 4;
        data[offset] = 255;
        data[offset + 1] = Math.round(40 + intensity * 190);
        data[offset + 2] = Math.round(110 + intensity * 145);
        data[offset + 3] = Math.round(70 + intensity * 185);
      }
    }
    context.putImageData(image, 0, 0);
    return uvWaveCanvas;
  }

  function overlayCompositeCanvas(width: number, height: number): HTMLCanvasElement {
    if (!uvOverlayComposite) uvOverlayComposite = document.createElement('canvas');
    if (uvOverlayComposite.width !== width || uvOverlayComposite.height !== height) {
      uvOverlayComposite.width = width;
      uvOverlayComposite.height = height;
    }
    return uvOverlayComposite;
  }

  function drawOverlapLabels(context: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    const fontSize = Math.max(14, Math.round(Math.min(width, height) / 14));
    const spacing = Math.max(fontSize * 8, 120);
    const offset = (time * 0.05) % spacing;
    context.save();
    context.font = `700 ${fontSize}px "DM Mono", monospace`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = 'rgba(255, 240, 230, 0.95)';
    const columns = Math.ceil((width + spacing) / spacing) + 1;
    const rows = Math.ceil((height + spacing) / spacing) + 1;
    for (let row = -1; row <= rows; row += 1) {
      for (let col = -1; col <= columns; col += 1) {
        context.fillText(UV_OVERLAP_LABEL, col * spacing + offset, row * spacing + offset);
      }
    }
    context.restore();
  }

  /** Strokes the wireframe triangles through a display-rect mapping (UV →
   * frame-space pixel rect). Opaque strokes: translucent ones would let the
   * dithered pixels bleed through, reading as the lines themselves being
   * dithered. */
  function drawWireframe(
    context: CanvasRenderingContext2D,
    triangles: UVTriangle[],
    rect: { left: number; top: number; width: number; height: number },
  ): void {
    context.save();
    context.beginPath();
    for (const triangle of triangles) {
      const [a, b, c] = triangle.uv;
      context.moveTo(rect.left + a[0] * rect.width, rect.top + (1 - a[1]) * rect.height);
      context.lineTo(rect.left + b[0] * rect.width, rect.top + (1 - b[1]) * rect.height);
      context.lineTo(rect.left + c[0] * rect.width, rect.top + (1 - c[1]) * rect.height);
      context.closePath();
    }
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = '#0a0c10';
    context.lineWidth = 2;
    context.stroke();
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1;
    context.stroke();
    context.restore();
  }

  /** One pane's wireframe layer. The texture bitmaps are low-res (the
   * dithered pane can be ~128px wide) and are upscaled to the frame with
   * nearest-neighbor, so stroking into them turns 1px antialiased lines into
   * chunky speckles. Drawing here instead — at the pane's display resolution
   * × devicePixelRatio — keeps the lines crisp at any zoom, and a dedicated
   * element keeps them clear of the dither pattern. */
  function syncWireframeOverlay(overlay: HTMLCanvasElement, canvas: HTMLCanvasElement): void {
    const triangles = uvWireframeTriangles;
    if (!state.showUVWireframe || canvas.hidden || !triangles || triangles.length === 0 || canvas.width <= 0 || canvas.height <= 0) {
      overlay.hidden = true;
      return;
    }
    overlay.hidden = false;
    const frameWidth = overlay.clientWidth;
    const frameHeight = overlay.clientHeight;
    if (frameWidth <= 0 || frameHeight <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.max(1, Math.round(frameWidth * dpr));
    overlay.height = Math.max(1, Math.round(frameHeight * dpr));
    const context = overlay.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, frameWidth, frameHeight);
    // Replicate the bitmap's object-fit: contain draw rect inside the canvas
    // element box (offsetWidth/offsetHeight are the post-layout, transform-
    // independent box), then offset by the box within the frame (flex
    // centering). The overlay shares the texture canvas's zoom/pan transform,
    // so drawing in untransformed frame space stays aligned at any zoom.
    const boxWidth = canvas.offsetWidth;
    const boxHeight = canvas.offsetHeight;
    if (boxWidth <= 0 || boxHeight <= 0) return;
    const scale = Math.min(boxWidth / canvas.width, boxHeight / canvas.height);
    const drawWidth = canvas.width * scale;
    const drawHeight = canvas.height * scale;
    drawWireframe(context, triangles, {
      left: (frameWidth - boxWidth) / 2 + (boxWidth - drawWidth) / 2,
      top: (frameHeight - boxHeight) / 2 + (boxHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  function syncWireframeOverlays(): void {
    syncWireframeOverlay(originalWireframeOverlay, originalCanvas);
    syncWireframeOverlay(processedWireframeOverlay, previewCanvas);
  }

  function drawAnimatedOverlay(canvas: HTMLCanvasElement, base: HTMLCanvasElement | null, time: number): void {
    if (!base || !uvOverlapMaskCanvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const { width, height } = canvas;
    context.drawImage(base, 0, 0, width, height);

    const composite = overlayCompositeCanvas(width, height);
    const compContext = composite.getContext('2d');
    if (!compContext) return;
    compContext.clearRect(0, 0, width, height);
    compContext.drawImage(renderWaveTile(time), 0, 0, width, height);
    drawOverlapLabels(compContext, width, height, time);
    compContext.globalCompositeOperation = 'destination-in';
    compContext.drawImage(uvOverlapMaskCanvas, 0, 0, width, height);
    compContext.globalCompositeOperation = 'source-over';

    context.globalCompositeOperation = 'lighter';
    context.drawImage(composite, 0, 0);
    context.globalCompositeOperation = 'source-over';
  }

  function tickUVOverlayAnimation(time: number): void {
    if (!state.showUVOverlap || !getAOScene() || !uvOverlapMaskCanvas) {
      uvOverlayFrame = 0;
      return;
    }
    if (getOriginalPreviewMode() === '2d') drawAnimatedOverlay(originalCanvas, shared.originalBaseCanvas, time);
    if (getProcessedPreviewMode() === '2d') drawAnimatedOverlay(previewCanvas, shared.renderedCanvas, time);
    uvOverlayFrame = requestAnimationFrame(tickUVOverlayAnimation);
  }

  function startUVOverlayAnimation(): void {
    if (uvOverlayFrame) return;
    uvOverlayFrame = requestAnimationFrame(tickUVOverlayAnimation);
  }

  function stopUVOverlayAnimation(): void {
    if (!uvOverlayFrame) return;
    cancelAnimationFrame(uvOverlayFrame);
    uvOverlayFrame = 0;
  }

  // Frame resizes change the overlay's display resolution and the texture
  // bitmap's letterbox rect — keep the wireframe aligned. (Bitmap size
  // changes are covered by the render wrapper re-syncing after every render.)
  const wireframeResizeObserver = new ResizeObserver(() => syncWireframeOverlays());
  wireframeResizeObserver.observe(originalWireframeOverlay);
  wireframeResizeObserver.observe(processedWireframeOverlay);

  function reset(): void {
    uvOverlapMaskCanvas = null;
    uvWireframeTriangles = null;
    stopUVOverlayAnimation();
    uvOverlapCache = null;
    syncWireframeOverlays();
  }

  return { refreshUVWireframe, refreshUVOverlap, invalidateUVOverlap, syncWireframeOverlays, reset };
}
