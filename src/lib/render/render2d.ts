import { applyAO, imageAOFactors } from '../ao';
import { drawImageToCanvas, imagePixels, processLitImageData } from '../canvas';
import { processImageData } from '../dither';
import { applyLightmap } from '../lightmap';
import type { RendererDeps, RenderShared } from './types';
import type { OverlayView } from './overlay';

export interface Render2DApi {
  render: () => void;
}

export function createRender2D(deps: RendererDeps, shared: RenderShared, overlay: OverlayView): Render2DApi {
  const {
    state,
    textures,
    previewCanvas,
    originalCanvas,
    dimensions,
    currentColors,
    updatePreviewBadge,
    getOriginalViewport,
    getProcessedViewport,
  } = deps;

  function currentAOFactors(width: number, height: number): Uint8ClampedArray | null {
    const source = textures.ao.image;
    if (!source) return null;
    return imageAOFactors(source, width, height);
  }

  function currentLightmapPixels(width: number, height: number): Uint8ClampedArray | null {
    const image = textures.lightmap.image ?? shared.implicitLightmapCanvas;
    return image ? imagePixels(image, width, height) : null;
  }

  function applyLighting(data: Uint8ClampedArray, width: number, height: number): void {
    const aoFactors = currentAOFactors(width, height);
    if (aoFactors) applyAO(data, aoFactors, state.aoBias, state.aoScale);
    const lightmapPixels = currentLightmapPixels(width, height);
    if (lightmapPixels) applyLightmap(data, lightmapPixels);
  }

  /** Inspection views (AO-only / lightmap-only) show the raw map, so lighting
   * (AO + lightmap multiply) is skipped — applying lighting to the map being
   * inspected would alter what it shows. */
  function skipLighting(): void {}

  function litCanvas(image: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
    const { canvas, context } = drawImageToCanvas(image, width, height);
    if (!context) return canvas;
    const data = context.getImageData(0, 0, width, height);
    applyLighting(data.data, width, height);
    context.putImageData(data, 0, 0);
    return canvas;
  }

  function render(): void {
    const { width, height } = dimensions();
    // Inspection modes swap the base color for the raw AO or lightmap in both
    // previews so the map can be inspected (and dithered) on its own. viewMode
    // is a single mutually-exclusive enum ('flat' | 'normals' | 'ao' | 'lightmap').
    const aoOnlySource = state.viewMode === 'ao' ? textures.ao.image : null;
    const lightmapOnlySource = state.viewMode === 'lightmap' ? (textures.lightmap.image ?? shared.implicitLightmapCanvas) : null;
    const onlySource = aoOnlySource ?? lightmapOnlySource;
    const source = onlySource ?? textures.base.image!;
    const { canvas: nextCanvas, context: renderContext } = drawImageToCanvas(source, width, height);
    shared.renderedCanvas = nextCanvas;
    if (!renderContext) return;
    const sourceData = renderContext.getImageData(0, 0, width, height);

    const processedOptions = {
      palette: currentColors(), mode: state.mode, strength: state.strength,
      brightness: state.brightness, contrast: state.contrast, saturation: state.saturation,
      stripeAngle: state.stripeAngle, noiseScale: state.noiseScale, seed: state.seed,
    };
    const { processed: processedData } = processLitImageData(
      sourceData,
      onlySource ? skipLighting : applyLighting,
      (lit) => processImageData(lit, processedOptions),
    );
    renderContext.putImageData(processedData, 0, 0);

    previewCanvas.width = width;
    previewCanvas.height = height;
    previewCanvas.getContext('2d')?.drawImage(shared.renderedCanvas, 0, 0);

    // Original pane shows the source at native resolution — the pixel grid slider must not affect it.
    const litSourceNative = onlySource
      ? drawImageToCanvas(source, source.width, source.height).canvas
      : litCanvas(source, source.width, source.height);
    shared.originalBaseCanvas = litSourceNative;
    originalCanvas.width = source.width;
    originalCanvas.height = source.height;
    originalCanvas.getContext('2d')?.drawImage(litSourceNative, 0, 0);

    if (state.showUVWireframe && overlay.hasWireframe()) {
      const originalContext = originalCanvas.getContext('2d');
      if (originalContext) overlay.drawWireframe(originalContext, source.width, source.height);
      const previewContext = previewCanvas.getContext('2d');
      if (previewContext) overlay.drawWireframe(previewContext, width, height);
    }

    updatePreviewBadge(width, height);
    const originalViewport = getOriginalViewport();
    const processedViewport = getProcessedViewport();
    if (originalViewport && processedViewport) {
      originalViewport.applyImage(litSourceNative);
      processedViewport.applyImage(shared.renderedCanvas);
    }
  }

  return { render };
}
