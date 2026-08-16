import { pixelsToCanvas } from '../canvas';
import type { SourceImage } from '../state';
import { collectUVTriangles, computeUVOverlap, type UVTriangle } from '../uvOverlap';
import type { RendererDeps, RenderShared } from './types';

/** The slice of the overlay the 2D renderer depends on. */
export interface OverlayView {
  hasWireframe: () => boolean;
  drawWireframe: (context: CanvasRenderingContext2D, width: number, height: number) => void;
}

export interface OverlayApi extends OverlayView {
  refreshUVWireframe: () => void;
  refreshUVOverlap: () => void;
  reset: () => void;
}

export function createOverlay(deps: RendererDeps, shared: RenderShared): OverlayApi {
  const {
    state,
    textures,
    originalCanvas,
    previewCanvas,
    forEachViewport,
    getAOScene,
    getOriginalPreviewMode,
    getProcessedPreviewMode,
  } = deps;

  let uvOverlapMaskCanvas: HTMLCanvasElement | null = null;
  let uvWireframeTriangles: UVTriangle[] | null = null;
  let uvWaveCanvas: HTMLCanvasElement | null = null;
  let uvOverlayComposite: HTMLCanvasElement | null = null;
  let uvOverlayFrame = 0;

  function uvOverlapResolution(source: SourceImage): { width: number; height: number } {
    const maxDimension = Math.max(source.width, source.height);
    const scale = maxDimension > 1024 ? 1024 / maxDimension : 1;
    return {
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale)),
    };
  }

  function uvOverlapMask(counts: Uint8Array, width: number, height: number): HTMLCanvasElement {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < counts.length; i += 1) {
      if (counts[i] < 2) continue;
      const offset = i * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
    return pixelsToCanvas(pixels, width, height);
  }

  function refreshUVWireframe(): void {
    const scene = getAOScene();
    uvWireframeTriangles = scene ? collectUVTriangles(scene) : null;
  }

  function refreshUVOverlap(): void {
    uvOverlapMaskCanvas = null;
    forEachViewport((viewport) => viewport.setUVOverlap(null));
    refreshUVWireframe();
    const scene = getAOScene();
    if (!state.showUVOverlap || !scene) {
      stopUVOverlayAnimation();
      return;
    }
    const source = textures.base.image!;
    const { width, height } = uvOverlapResolution(source);
    const result = computeUVOverlap(scene, width, height);
    uvOverlapMaskCanvas = uvOverlapMask(result.counts, width, height);
    forEachViewport((viewport) => viewport.setUVOverlap(result.overlapping));
    startUVOverlayAnimation();
  }

  function renderWaveTile(time: number): HTMLCanvasElement {
    const size = 256;
    if (!uvWaveCanvas) {
      uvWaveCanvas = document.createElement('canvas');
      uvWaveCanvas.width = size;
      uvWaveCanvas.height = size;
    }
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
        context.fillText('UV OVERLAP', col * spacing + offset, row * spacing + offset);
      }
    }
    context.restore();
  }

  function drawWireframe(context: CanvasRenderingContext2D, width: number, height: number): void {
    const triangles = uvWireframeTriangles;
    if (!triangles || triangles.length === 0) return;
    context.save();
    context.beginPath();
    for (const triangle of triangles) {
      const [a, b, c] = triangle.uv;
      context.moveTo(a[0] * width, (1 - a[1]) * height);
      context.lineTo(b[0] * width, (1 - b[1]) * height);
      context.lineTo(c[0] * width, (1 - c[1]) * height);
      context.closePath();
    }
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = 'rgba(10, 12, 16, 0.6)';
    context.lineWidth = 2;
    context.stroke();
    context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    context.lineWidth = 1;
    context.stroke();
    context.restore();
  }

  function hasWireframe(): boolean {
    return (uvWireframeTriangles?.length ?? 0) > 0;
  }

  function drawAnimatedOverlay(canvas: HTMLCanvasElement, base: HTMLCanvasElement | null, time: number): void {
    if (!base || !uvOverlapMaskCanvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const { width, height } = canvas;
    context.drawImage(base, 0, 0, width, height);
    if (state.showUVWireframe) drawWireframe(context, width, height);

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

  function reset(): void {
    uvOverlapMaskCanvas = null;
    uvWireframeTriangles = null;
    stopUVOverlayAnimation();
  }

  return { refreshUVWireframe, refreshUVOverlap, hasWireframe, drawWireframe, reset };
}
