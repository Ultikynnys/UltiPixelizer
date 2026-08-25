import type { Object3D } from 'three';
import { createCanvas, factorsToCanvas } from '../canvas';
import { uvToTexturePoint } from '../bakeGeometry';
import type { SourceImage } from '../state';
import { UV_OVERLAP_LABEL, collectUVTriangles, computeUVOverlap, type UVTriangle } from '../uvOverlap';
import type { RendererDeps, RenderShared } from './types';

export interface OverlayApi {
  refreshUVWireframe: () => void;
  refreshUVOverlap: () => void;
  /** Forces the next refreshUVOverlap to recompute — call after any in-place
   * change to the AO scene's UVs/visibility/rotation. */
  invalidateUVOverlap: () => void;
  /** Synchronizes the cached UV wireframe canvases after the toggle, pane
   * mode, frame resize, or texture bitmap size changes. */
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
    getAOScene,
    getOriginalPreviewMode,
    getProcessedPreviewMode,
    getOriginalViewport,
    getProcessedViewport,
  } = deps;
  const { original: originalWireframeOverlay, processed: processedWireframeOverlay } = wireframeOverlays;

  let uvOverlapMaskCanvas: HTMLCanvasElement | null = null;
  let uvWireframeTriangles: UVTriangle[] | null = null;
  let uvWireframeGeneration = 0;
  const wireframeCache = new WeakMap<HTMLCanvasElement, { generation: number; width: number; height: number }>();
  let uvWaveCanvas: HTMLCanvasElement | null = null;
  let uvOverlayComposite: HTMLCanvasElement | null = null;
  let uvOverlayFrame = 0;
  // Last-computed overlap context. The mask depends only on the scene's UVs
  // (model, UV channel, LOD, world axis) and the mask resolution — both stable
  // across basecolor swaps and ribbon refreshes — so a warm cache skips the
  // ~150ms per-triangle re-rasterization on a 60k-tri model. The overlap map
  // is retained alongside so a cache hit can re-apply the per-pane viewport
  // highlights after a toggle flip.
  let uvOverlapCache: { scene: Object3D | null; width: number; height: number; overlapping: Map<number, number[]> } | null = null;

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
    uvWireframeGeneration += 1;
    syncWireframeOverlays();
  }

  /** Applies the overlap highlight to each 3D viewport independently: a pane's
   * viewport shows the highlight only while that pane's own toggle is on, so
   * the two windows stay decoupled. The mask content is shared (both panes
   * render the same model UVs), but visibility follows each pane's toggle. */
  function setViewportOverlap(overlapping: Map<number, number[]> | null): void {
    getOriginalViewport()?.setUVOverlap(state.showUVOverlapOriginal ? overlapping : null);
    getProcessedViewport()?.setUVOverlap(state.showUVOverlapProcessed ? overlapping : null);
  }

  function refreshUVOverlap(): void {
    const scene = getAOScene();
    if ((!state.showUVOverlapOriginal && !state.showUVOverlapProcessed) || !scene) {
      uvOverlapMaskCanvas = null;
      setViewportOverlap(null);
      refreshUVWireframe();
      stopUVOverlayAnimation();
      return;
    }
    refreshUVWireframe();
    const source = textures.base.image!;
    const { width, height } = uvOverlapResolution(source);
    // The cache is only usable while the mask canvas is alive: the toggle-off
    // path clears uvOverlapMaskCanvas (and the viewports) but leaves the cache
    // populated, so a cache hit after an off/on cycle would restart the
    // animation with a null mask and draw nothing. Recompute whenever the
    // mask is missing; the cached entry still saves the re-rasterization in
    // the common warm case (same scene and resolution).
    if (uvOverlapMaskCanvas && uvOverlapCache && uvOverlapCache.scene === scene && uvOverlapCache.width === width && uvOverlapCache.height === height) {
      // The mask is still valid, but the per-pane toggles may have changed
      // since the last refresh — re-apply each viewport's highlight so only
      // the pane(s) whose toggle is on show it.
      setViewportOverlap(uvOverlapCache.overlapping);
      startUVOverlayAnimation();
      return;
    }
    uvOverlapCache = null;
    uvOverlapMaskCanvas = null;
    const result = computeUVOverlap(scene, width, height);
    uvOverlapCache = { scene, width, height, overlapping: result.overlapping };
    uvOverlapMaskCanvas = uvOverlapMask(result.counts, width, height);
    setViewportOverlap(result.overlapping);
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
    if (!uvOverlayComposite) uvOverlayComposite = createCanvas(width, height).canvas;
    else if (uvOverlayComposite.width !== width || uvOverlayComposite.height !== height) {
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

  /** Rasterizes all UV edges into one reusable texture-space bitmap. Unlike
   * the former SVG path, this does not leave tens of thousands of vector
   * segments for the browser to tessellate again while the preview is
   * transformed. The bitmap deliberately scales with preview zoom: this trades
   * constant-width vector strokes for responsive interaction on dense meshes. */
  function drawWireframe(overlay: HTMLCanvasElement, triangles: UVTriangle[], width: number, height: number): void {
    overlay.width = width;
    overlay.height = height;
    const context = overlay.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.beginPath();
    for (const triangle of triangles) {
      const a = uvToTexturePoint(triangle.uv[0], width, height);
      const b = uvToTexturePoint(triangle.uv[1], width, height);
      const c = uvToTexturePoint(triangle.uv[2], width, height);
      context.moveTo(a[0], a[1]);
      context.lineTo(b[0], b[1]);
      context.lineTo(c[0], c[1]);
      context.closePath();
    }
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#0a0c10';
    context.lineWidth = 2;
    context.stroke();
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1;
    context.stroke();
  }

  function syncWireframeOverlay(overlay: HTMLCanvasElement, canvas: HTMLCanvasElement, showWireframe: boolean): void {
    const triangles = uvWireframeTriangles;
    if (!showWireframe || canvas.hidden || !triangles || triangles.length === 0 || canvas.width <= 0 || canvas.height <= 0) {
      overlay.hidden = true;
      return;
    }
    overlay.hidden = false;
    const cached = wireframeCache.get(overlay);
    if (cached?.generation === uvWireframeGeneration && cached.width === canvas.width && cached.height === canvas.height) return;
    drawWireframe(overlay, triangles, canvas.width, canvas.height);
    wireframeCache.set(overlay, { generation: uvWireframeGeneration, width: canvas.width, height: canvas.height });
  }

  function syncWireframeOverlays(): void {
    syncWireframeOverlay(originalWireframeOverlay, originalCanvas, state.showUVWireframeOriginal);
    syncWireframeOverlay(processedWireframeOverlay, previewCanvas, state.showUVWireframeProcessed);
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
    if ((!state.showUVOverlapOriginal && !state.showUVOverlapProcessed) || !getAOScene() || !uvOverlapMaskCanvas) {
      uvOverlayFrame = 0;
      return;
    }
    if (state.showUVOverlapOriginal && getOriginalPreviewMode() === '2d') drawAnimatedOverlay(originalCanvas, shared.originalBaseCanvas, time);
    if (state.showUVOverlapProcessed && getProcessedPreviewMode() === '2d') drawAnimatedOverlay(previewCanvas, shared.renderedCanvas, time);
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
    uvWireframeGeneration += 1;
    stopUVOverlayAnimation();
    uvOverlapCache = null;
    syncWireframeOverlays();
  }

  return { refreshUVWireframe, refreshUVOverlap, invalidateUVOverlap, syncWireframeOverlays, reset };
}
