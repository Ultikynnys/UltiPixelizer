import { applyAO, aoMultiplier, imageAOFactors } from '../ao';
import { drawImageToCanvas, imagePixels, pixelsToCanvas, processLitImageData, resizeNearest } from '../canvas';
import { processImageData } from '../dither';
import { applyLightmap } from '../lightmap';
import type { PreviewViewMode, SourceImage } from '../state';
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
    if (aoFactors) applyAO(data, aoFactors, state.aoBias, state.aoPower);
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
    // Lightmap+AO inspection shows the combined map — AO visibility (remapped
    // by bias/scale exactly as the lighting pass applies it) multiplied into
    // the lightmap on white, staged at the target resolution.
    const lightmapCanvas = textures.lightmap.image ?? shared.implicitLightmapCanvas;
    const lightmapAoSelected = state.viewModeOriginal === 'lightmap-ao' || state.viewModeProcessed === 'lightmap-ao';
    let lightmapAoSource: SourceImage | null = null;
    if (lightmapAoSelected && textures.ao.image && lightmapCanvas) {
      const aoFactors = imageAOFactors(textures.ao.image, width, height);
      const lightmapPixels = imagePixels(lightmapCanvas, width, height);
      const combined = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        const offset = i * 4;
        const visibility = aoMultiplier(aoFactors[i], state.aoBias, state.aoPower);
        combined[offset] = lightmapPixels[offset] * visibility;
        combined[offset + 1] = lightmapPixels[offset + 1] * visibility;
        combined[offset + 2] = lightmapPixels[offset + 2] * visibility;
        combined[offset + 3] = 255;
      }
      lightmapAoSource = pixelsToCanvas(combined, width, height);
    }
    // AO inspection shows the bias/scale-remapped occlusion — the exact
    // multiplier the lighting pass applies — so tuning Bias/Scale updates the
    // AO preview (at defaults the remap is the identity, matching the raw
    // bake). Staged at the map's native resolution.
    const aoImage = textures.ao.image;
    const aoSelected = state.viewModeOriginal === 'ao' || state.viewModeProcessed === 'ao';
    let aoInspectionSource: SourceImage | null = null;
    if (aoSelected && aoImage) {
      const aoPixels = imagePixels(aoImage, aoImage.width, aoImage.height);
      const aoWidth = aoImage.width;
      const aoHeight = aoImage.height;
      const remapped = new Uint8ClampedArray(aoPixels.length);
      for (let i = 0; i < aoWidth * aoHeight; i += 1) {
        const gray = Math.round(aoMultiplier(aoPixels[i * 4], state.aoBias, state.aoPower) * 255);
        const offset = i * 4;
        remapped[offset] = gray;
        remapped[offset + 1] = gray;
        remapped[offset + 2] = gray;
        remapped[offset + 3] = 255;
      }
      aoInspectionSource = pixelsToCanvas(remapped, aoWidth, aoHeight);
    }

    // Per-pane inspection enum: each preview pane picks its own source, so the
    // original can show the AO while the dithered pane quantizes the base.
    // BaseColor shows the base texture with no lighting; AO shows the
    // bias/scale-remapped occlusion; Lightmap shows the raw map; Normals shows
    // the raw normal map; Lightmap+AO shows the remapped AO×lightmap. Lighting
    // (AO + lightmap multiply) is skipped for whichever pane inspects a raw
    // map, since lighting the map being inspected would alter it.
    const inspectionSource = (viewMode: PreviewViewMode): SourceImage | null =>
      viewMode === 'basecolor' ? textures.base.image
      : viewMode === 'normals' ? textures.normal.image
      : viewMode === 'ao' ? aoInspectionSource
      : viewMode === 'lightmap' ? lightmapCanvas
      : viewMode === 'lightmap-ao' ? lightmapAoSource
      : null;
    const originalOnlySource = inspectionSource(state.viewModeOriginal);
    const processedOnlySource = inspectionSource(state.viewModeProcessed);

    // Dithered pane: quantize the processed pane's chosen source. Normals are
    // the exception — a normal map can't be palette-dithered, so it's
    // pixelized with nearest-neighbor at the target resolution instead (the
    // same map the 3D processed viewport displays).
    const processedSource = processedOnlySource ?? textures.base.image!;
    const normalsInspection = state.viewModeProcessed === 'normals' && processedOnlySource !== null;
    let nextCanvas: HTMLCanvasElement;
    let renderContext: CanvasRenderingContext2D | null;
    if (normalsInspection) {
      nextCanvas = resizeNearest(processedSource, width, height);
      renderContext = nextCanvas.getContext('2d');
    } else {
      // Upscaling (grid finer than the source) must stay crisp — the browser's
      // smoothed resample would blur source pixels before dithering. Only
      // downscales keep the filtered drawImage path.
      if (width > processedSource.width) {
        nextCanvas = resizeNearest(processedSource, width, height);
        renderContext = nextCanvas.getContext('2d');
      } else {
        const staged = drawImageToCanvas(processedSource, width, height);
        nextCanvas = staged.canvas;
        renderContext = staged.context;
      }
    }
    shared.renderedCanvas = nextCanvas;
    if (!renderContext) return;
    // The pixelized normals map is already final — the dither pass would
    // corrupt it.
    if (!normalsInspection) {
      const sourceData = renderContext.getImageData(0, 0, width, height);

      const processedOptions = {
        palette: currentColors(), mode: state.mode, strength: state.strength,
        brightness: state.brightness, contrast: state.contrast, saturation: state.saturation,
        stripeAngle: state.stripeAngle, noiseScale: state.noiseScale, seed: state.seed,
      };
      const { processed: processedData } = processLitImageData(
        sourceData,
        processedOnlySource ? skipLighting : applyLighting,
        (lit) => processImageData(lit, processedOptions),
      );
      renderContext.putImageData(processedData, 0, 0);
    }

    previewCanvas.width = width;
    previewCanvas.height = height;
    previewCanvas.getContext('2d')?.drawImage(shared.renderedCanvas, 0, 0);

    // Original pane shows its chosen source at native resolution — the pixel
    // grid slider must not affect it.
    const originalSource = originalOnlySource ?? textures.base.image!;
    const litSourceNative = originalOnlySource
      ? drawImageToCanvas(originalSource, originalSource.width, originalSource.height).canvas
      : litCanvas(originalSource, originalSource.width, originalSource.height);
    shared.originalBaseCanvas = litSourceNative;
    originalCanvas.width = originalSource.width;
    originalCanvas.height = originalSource.height;
    originalCanvas.getContext('2d')?.drawImage(litSourceNative, 0, 0);

    if (state.showUVWireframe && overlay.hasWireframe()) {
      const originalContext = originalCanvas.getContext('2d');
      if (originalContext) overlay.drawWireframe(originalContext, originalSource.width, originalSource.height);
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
