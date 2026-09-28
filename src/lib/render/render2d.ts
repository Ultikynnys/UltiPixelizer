import { applyAO, aoMultiplier, imageAOFactors } from '../ao';
import { createCanvas, drawImageToCanvas, imagePixels, pixelsToCanvas } from '../canvas';
import { collectConfigValues } from '../presets';
import { prepareView } from '../pipeline/compose';
import { processImageData, isWorldCapable, type ProcessOptions } from '../dither';
import { DEFAULT_WORLDSPACE_SCALE } from '../defaults';
import { webgpuUsable } from '../gpuCommon';
import { gpuDitherCovers, processImageDataAsync } from '../gpuDither';
import { applyLightmap } from '../lightmap';
import { rasterizeBake, rasterizeWorldPositions, type BakeScene, type WorldPositionMap } from '../bakeGeometry';
import { getBakeScene } from '../bakeSceneCache';
import { computeTexelVarianceData, computeUVStretchData, recolorUVStretchData, type UVStretchData } from '../texelDensity';
import { createBoundedLru } from '../lru';
import { drawLuminosityHistogram } from '../luminosityHistogram';
import type { PreviewViewMode, SourceImage } from '../state';
import type { RendererDeps, RenderShared } from './types';

export interface Render2DApi {
  render: () => Promise<void>;
  applyViewportImages: () => void;
}

/** Draws the repeat-tiled display for the image-repeat diagnostic: `repeat²`
 * copies of `source` at `width`×`height` each. The processed and original
 * panes tile independently (each with its own repeat factor)  one helper so
 * the two loops can't drift. */
function drawTiled(context: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, repeat: number): void {
  for (let ty = 0; ty < repeat; ty += 1) {
    for (let tx = 0; tx < repeat; tx += 1) {
      context.drawImage(source, tx * width, ty * height);
    }
  }
}

export function renderUVStretchCanvas(data: UVStretchData, width: number, height: number): HTMLCanvasElement {
  const { canvas, context } = createCanvas(width, height);
  if (!context) return canvas;
  const image = context.createImageData(width, height);
  rasterizeBake(width, height, data.faces, (px, py, _w0, _w1, _w2, face) => {
    const offset = (py * width + px) * 4;
    image.data[offset] = face.color[0];
    image.data[offset + 1] = face.color[1];
    image.data[offset + 2] = face.color[2];
    image.data[offset + 3] = 255;
  });
  context.putImageData(image, 0, 0);
  return canvas;
}

/** The 2D UV-space reference for the Directionality view mode: a vertical
 * sawtooth of 16 waves over the V (Y) UV coordinate, gray = fract(V * 16).
 * This matches the 3D viewports' fragment shader exactly, so a model's
 * directionality view lines up with the 2D reference. */
function renderDirectionalityCanvas(width: number, height: number): HTMLCanvasElement {
  const { canvas, context } = createCanvas(width, height);
  if (!context) return canvas;
  const image = context.createImageData(width, height);
  for (let py = 0; py < height; py += 1) {
    // Row 0 is the canvas top = V=1; the bottom row = V=0. gray = fract(V*16).
    const v = (height - 1 - py) / Math.max(height - 1, 1);
    const gray = Math.round((v * 16 - Math.floor(v * 16)) * 255);
    for (let px = 0; px < width; px += 1) {
      const offset = (py * width + px) * 4;
      image.data[offset] = gray;
      image.data[offset + 1] = gray;
      image.data[offset + 2] = gray;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function createRender2D(deps: RendererDeps, shared: RenderShared): Render2DApi {
  const {
    state,
    textures,
    previewCanvas,
    originalCanvas,
    luminosityHistograms,
    showLuminosityHistograms,
    dimensions,
    currentColors,
    updatePreviewBadge,
    getOriginalViewport,
    getProcessedViewport,
    repeatTextureOriginal,
    repeatTextureProcessed,
    getAOScene,
    getBakeSurface,
  } = deps;

  /** Supersedes an in-flight async GPU dither: every render bumps the token,
   * and a GPU result that lands after a newer render started is dropped. */
  let ditherToken = 0;

  /** Dither-result cache. The dither is a pure function of (input pixels,
   * options), and at 1k the CPU fallback takes seconds, so a repeat render
   * with the same input and options (swapping between palettes, toggling
   * strength back) skips the dither entirely. The input bytes are stored
   * alongside the output and byte-compared on hit, so any input change (AO /
   * lightmap re-bake, new base texture, resolution change) refreshes the
   * entry instead of returning stale output. Bounded LRU over the options key
   * (shared factory with the fallback-quad cache, see lru.ts). */
  const DITHER_CACHE_MAX = 3;
  const ditherCache = createBoundedLru<string, { input: Uint8ClampedArray; output: ImageData }>(DITHER_CACHE_MAX);
  let worldPositionCache: { scene: BakeScene; width: number; height: number; map: WorldPositionMap; id: number } | null = null;
  let nextWorldPositionMapId = 1;

  function currentWorldPositionMap(width: number, height: number): { map: WorldPositionMap; id: number } {
    const scene = getBakeScene(getBakeSurface());
    if (!scene) throw new Error('Worldspace dithering requires an active bake surface.');
    if (worldPositionCache?.scene === scene && worldPositionCache.width === width && worldPositionCache.height === height) {
      return worldPositionCache;
    }
    worldPositionCache = {
      scene,
      width,
      height,
      map: rasterizeWorldPositions(scene, width, height),
      id: nextWorldPositionMapId++,
    };
    return worldPositionCache;
  }

  /** Cache key for the dither options: everything that changes the output
   * besides the input pixels. Slider values are discrete state, so String()
   * round-trips exactly. */
  function ditherKey(options: ProcessOptions, extra = ''): string {
    return `${options.mode}|${options.palette.join(',')}|${options.strength}|${options.brightness}|${options.contrast}|${options.saturation}|${options.stripeAngle}|${options.seed}|${options.worldspaceScale ?? DEFAULT_WORLDSPACE_SCALE}|${options.uvScale ?? 1}|${options.patternSpace ?? 'uv'}|${extra}`;
  }

  function lookupDither(key: string, input: Uint8ClampedArray): ImageData | null {
    const hit = ditherCache.get(key);
    if (!hit || hit.input.length !== input.length) return null;
    for (let i = 0; i < input.length; i += 1) {
      if (hit.input[i] !== input[i]) return null;
    }
    // LRU bump: re-insert so the entry is most-recently-used.
    ditherCache.delete(key);
    ditherCache.set(key, hit);
    return hit.output;
  }

  function storeDither(key: string, input: Uint8ClampedArray, output: ImageData): void {
    ditherCache.delete(key);
    ditherCache.set(key, { input, output });
  }

  /** Cache-aware dither for synchronous computes: returns the cached result
   * when the input bytes match, otherwise computes, stores, and returns.
   * Stays fully synchronous so renders that never touch the GPU keep the
   * same single-tick completion as before the cache. */
  function ditherSync(key: string, input: Uint8ClampedArray, compute: () => ImageData): ImageData {
    const cached = lookupDither(key, input);
    if (cached) return cached;
    const output = compute();
    storeDither(key, input, output);
    return output;
  }

  /** Cache-aware dither for the async GPU path; the result is stored when it
   * lands  even if a newer render then drops this frame, the cached entry is
   * still a valid output for its key. */
  async function ditherAsync(key: string, input: Uint8ClampedArray, compute: () => Promise<ImageData>): Promise<ImageData> {
    const cached = lookupDither(key, input);
    if (cached) return cached;
    const output = await compute();
    storeDither(key, input, output);
    return output;
  }

  function currentAOFactors(width: number, height: number): Uint8ClampedArray | null {
    const source = textures.ao.image;
    if (!source) return null;
    return imageAOFactors(source, width, height);
  }

  function currentLightmapPixels(width: number, height: number): Uint8ClampedArray | null {
    const image = textures.lightmap.image ?? shared.implicitLightmapCanvas;
    if (!image) return null;
    return imagePixels(image, width, height);
  }

  function applyLighting(data: Uint8ClampedArray, width: number, height: number): void {
    const aoFactors = currentAOFactors(width, height);
    if (aoFactors) applyAO(data, aoFactors, state.aoBias, state.aoPower);
    const lightmapPixels = currentLightmapPixels(width, height);
    if (lightmapPixels) applyLightmap(data, lightmapPixels);
  }

  /** Reads a SourceImage (canvas) into the PixelBuffer the shared composition
   * core (../pipeline/compose) consumes. */
  function toPixelBuffer(image: SourceImage): { data: Uint8ClampedArray; width: number; height: number } {
    return { data: imagePixels(image, image.width, image.height), width: image.width, height: image.height };
  }

  function litCanvas(image: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
    const { canvas, context } = drawImageToCanvas(image, width, height);
    if (!context) return canvas;
    const data = context.getImageData(0, 0, width, height);
    applyLighting(data.data, width, height);
    context.putImageData(data, 0, 0);
    return canvas;
  }

  async function render(): Promise<void> {
    const { width, height } = dimensions();
    // Image-repeat diagnostic: render the texture tiled 3×3 in the 2D panes so
    // seams at tile boundaries are visible. Only the display canvases tile 
    // shared.renderedCanvas / originalBaseCanvas (export, viewports, UV
    // overlays) keep the single-tile image. Each pane tiles independently.
    const repeatOriginal = repeatTextureOriginal?.() ? 3 : 1;
    const repeatProcessed = repeatTextureProcessed?.() ? 3 : 1;
    // Lightmap+AO inspection shows the combined map  AO visibility (remapped
    // by bias/scale exactly as the lighting pass applies it) multiplied into
    // the lightmap on white, staged at the target resolution.
    const stretchSelected = state.viewModeOriginal === 'uv-stretch' || state.viewModeProcessed === 'uv-stretch';
    const stretchScene = stretchSelected ? getAOScene() : null;
    if (stretchScene !== shared.uvStretchScene) {
      shared.uvStretchScene = stretchScene;
      shared.uvStretchData = stretchScene ? computeUVStretchData(stretchScene) : null;
      // Force a re-color + re-rasterize for the new scene.
      shared.uvStretchColored = null;
      shared.uvStretchSensitivity = NaN;
    }
    const stretchData = shared.uvStretchData;
    // Re-color (cheap, O(faces)) only when the sensitivity moved; the expensive
    // per-face distortion walk above is cached on the scene.
    const stretchSensitivity = state.uvStretchSensitivity;
    if (stretchData && shared.uvStretchSensitivity !== stretchSensitivity) {
      shared.uvStretchColored = recolorUVStretchData(stretchData, stretchSensitivity);
      shared.uvStretchSensitivity = stretchSensitivity;
      shared.uvStretchCanvas = null; // force re-rasterize
    }
    const stretchSourceData = stretchData ? shared.uvStretchColored : null;
    if (stretchSourceData && (!shared.uvStretchCanvas || shared.uvStretchCanvasWidth !== width || shared.uvStretchCanvasHeight !== height)) {
      shared.uvStretchCanvas = renderUVStretchCanvas(stretchSourceData, width, height);
      shared.uvStretchCanvasWidth = width;
      shared.uvStretchCanvasHeight = height;
    }
    const stretchSource = stretchSourceData ? shared.uvStretchCanvas : null;

    // Texel-variance view: colors each face by its texel density relative to
    // the model-wide average (red below, blue above). Reuses the stretch view's
    // flat per-face overlay (`setUVStretch`) and UV-space raster.
    const varianceSelected = state.viewModeOriginal === 'texel-variance' || state.viewModeProcessed === 'texel-variance';
    const varianceScene = varianceSelected ? getAOScene() : null;
    if (varianceScene !== shared.varianceScene) {
      shared.varianceScene = varianceScene;
      shared.varianceData = varianceScene ? computeTexelVarianceData(varianceScene, width, height) : null;
    }
    const varianceData = shared.varianceData;
    if (varianceData && (!shared.varianceCanvas || shared.varianceCanvasWidth !== width || shared.varianceCanvasHeight !== height)) {
      shared.varianceCanvas = renderUVStretchCanvas(varianceData, width, height);
      shared.varianceCanvasWidth = width;
      shared.varianceCanvasHeight = height;
    }
    const varianceSource = varianceData ? shared.varianceCanvas : null;

    // The flat per-face overlay is shared by UV Stretch and Texel Variance;
    // each pane feeds whichever is active (the two view modes are exclusive).
    const originalOverlay = state.viewModeOriginal === 'uv-stretch' ? stretchSourceData
      : (state.viewModeOriginal === 'texel-variance' ? varianceData : null);
    const processedOverlay = state.viewModeProcessed === 'uv-stretch' ? stretchSourceData
      : (state.viewModeProcessed === 'texel-variance' ? varianceData : null);
    getOriginalViewport()?.setUVStretch(originalOverlay);
    getProcessedViewport()?.setUVStretch(processedOverlay);

    // Directionality view: stage a vertical V-sawtooth canvas for the 2D panes
    // and feed each 3D viewport's UV-directionality material.
    const directionalitySelected = state.viewModeOriginal === 'directionality' || state.viewModeProcessed === 'directionality';
    let directionalitySource: SourceImage | null = null;
    if (directionalitySelected && (!shared.directionalityCanvas || shared.directionalityCanvasWidth !== width || shared.directionalityCanvasHeight !== height)) {
      shared.directionalityCanvas = renderDirectionalityCanvas(width, height);
      shared.directionalityCanvasWidth = width;
      shared.directionalityCanvasHeight = height;
    }
    if (directionalitySelected) directionalitySource = shared.directionalityCanvas;
    getOriginalViewport()?.setDirectionalityView(state.viewModeOriginal === 'directionality');
    getProcessedViewport()?.setDirectionalityView(state.viewModeProcessed === 'directionality');

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
    // AO inspection shows the bias/scale-remapped occlusion  the exact
    // multiplier the lighting pass applies  so tuning Bias/Scale updates the
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
      : viewMode === 'uv-stretch' ? stretchSource
      : viewMode === 'texel-variance' ? varianceSource
      : viewMode === 'directionality' ? directionalitySource
      : null;
    const originalOnlySource = inspectionSource(state.viewModeOriginal);

    // Dithered pane: quantize the processed pane's chosen source. Normals are
    // the exception  a normal map can't be palette-dithered, so it's
    // pixelized with nearest-neighbor at the target resolution instead (the
    // same map the 3D processed viewport displays).
    // Processed pane: the SHARED composition rules (src/lib/pipeline/compose)
    // pick the inspected map, resample/pixelate it, and apply AO/lightmap — or
    // assemble the halftone lighting — so the app and CLI compose identically.
    // render2d still runs its (cached / GPU) dither on the prepared pixels.
    // Canvas availability is probed up front so an unavailable context returns
    // early (as before), without reading the source pixels.
    const { canvas: nextCanvas, context: renderContext } = createCanvas(width, height);
    if (!renderContext) return;
    const config = collectConfigValues(state);
    const worldPosition = state.patternSpace === 'world' && isWorldCapable(state.mode) ? currentWorldPositionMap(width, height) : null;
    const prepared = prepareView({
      base: toPixelBuffer(textures.base.image!),
      normal: textures.normal.image ? toPixelBuffer(textures.normal.image) : null,
      aoFactors: currentAOFactors(width, height),
      lightmap: currentLightmapPixels(width, height),
      scene: getAOScene(),
      worldPositions: worldPosition ? worldPosition.map : null,
      width, height, config, colors: currentColors(), view: state.viewModeProcessed,
    });

    let preparedData: Uint8ClampedArray;
    if (prepared.direct) {
      preparedData = prepared.rgba;
    } else {
      const options: ProcessOptions = { ...prepared.options, lighting: prepared.lighting };
      const lit = prepared.lit;
      let processedData: ImageData;
      if (state.mode === 'none') {
        // 'none' passes the lit source through unchanged — no dither to cache.
        processedData = processImageData(lit, options);
      } else if (state.mode === 'halftone') {
        // The lighting array rides in the cache input (it changes the dots).
        const lightingBytes = prepared.lighting
          ? new Uint8ClampedArray(prepared.lighting.buffer, prepared.lighting.byteOffset, prepared.lighting.byteLength)
          : null;
        const input = new Uint8ClampedArray(lit.data.length + (lightingBytes ? lightingBytes.length : 0));
        input.set(lit.data);
        if (lightingBytes) input.set(lightingBytes, lit.data.length);
        const worldKey = worldPosition ? `world-map-${worldPosition.id}` : '';
        processedData = ditherSync(`${ditherKey(options, worldKey)}|halftone-light|${lightingBytes ? 1 : 0}`, input, () => processImageData(lit, options));
      } else if (webgpuUsable() && gpuDitherCovers(state.mode)) {
        // The GPU dither is async: a newer render supersedes this frame, so a
        // stale result is dropped instead of overwriting the freshest one.
        const token = ++ditherToken;
        processedData = await ditherAsync(ditherKey(options), lit.data, () => processImageDataAsync(lit, options));
        if (token !== ditherToken) return;
      } else {
        const worldKey = worldPosition ? `world-map-${worldPosition.id}` : '';
        processedData = ditherSync(ditherKey(options, worldKey), lit.data, () => processImageData(lit, options));
      }
      preparedData = processedData.data;
    }

    renderContext.putImageData(new ImageData(preparedData as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
    shared.renderedCanvas = nextCanvas;

    const previewWidth = width * repeatProcessed;
    const previewHeight = height * repeatProcessed;
    if (previewCanvas.width !== previewWidth) previewCanvas.width = previewWidth;
    if (previewCanvas.height !== previewHeight) previewCanvas.height = previewHeight;
    // Mark the display canvas so preview2d shows the 3× buffer at 3× scale 
    // a pure transform: each tile keeps the single-tile size, the window
    // layout never moves, and the grid overflows until the user scrolls out.
    previewCanvas.classList.toggle('repeat-tiled', repeatProcessed === 3);
    const previewContext = previewCanvas.getContext('2d');
    if (previewContext) drawTiled(previewContext, shared.renderedCanvas, width, height, repeatProcessed);

    // Original pane shows its chosen source at native resolution  the pixel
    // grid slider must not affect it.
    const originalSource = originalOnlySource ?? textures.base.image!;
    const litSourceNative = originalOnlySource
      ? drawImageToCanvas(originalSource, originalSource.width, originalSource.height).canvas
      : litCanvas(originalSource, originalSource.width, originalSource.height);
    shared.originalBaseCanvas = litSourceNative;
    const originalWidth = originalSource.width * repeatOriginal;
    const originalHeight = originalSource.height * repeatOriginal;
    if (originalCanvas.width !== originalWidth) originalCanvas.width = originalWidth;
    if (originalCanvas.height !== originalHeight) originalCanvas.height = originalHeight;
    originalCanvas.classList.toggle('repeat-tiled', repeatOriginal === 3);
    const originalContext = originalCanvas.getContext('2d');
    if (originalContext) drawTiled(originalContext, litSourceNative, originalSource.width, originalSource.height, repeatOriginal);

    // Histograms use the final single-tile buffers, after each pane's selected
    // view mode and dither/lighting path. Image-repeat display copies must not
    // multiply the distribution by nine. Compact mode hides the graph entirely,
    // so skip its pixel reads there as well.
    if (showLuminosityHistograms()) {
      drawLuminosityHistogram(shared.originalBaseCanvas, luminosityHistograms.original);
      drawLuminosityHistogram(shared.renderedCanvas, luminosityHistograms.processed);
    }

    // The UV wireframe is rasterized into a separate cached overlay canvas
    // (overlay.syncWireframeOverlays), never into the texture bitmap itself.

    updatePreviewBadge(width, height);
    applyViewportImages();
  }

  /** Re-applies the last rendered frames to both 3D viewports. Runs at the
   * end of every render, and is re-invoked by main.ts immediately after a
   * fallback-quad swap  the freshly installed quads' materials carry no map
   * yet, so without a synchronous re-apply the viewport would flash white
   * until the next (debounced) render. No-op before the first render, while
   * the shared canvases are still null. */
  function applyViewportImages(): void {
    const originalViewport = getOriginalViewport();
    const processedViewport = getProcessedViewport();
    if (!originalViewport || !processedViewport) return;
    if (shared.originalBaseCanvas) originalViewport.applyImage(shared.originalBaseCanvas);
    if (shared.renderedCanvas) processedViewport.applyImage(shared.renderedCanvas);
  }

  return { render, applyViewportImages };
}
