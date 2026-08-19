import { applyAO, aoMultiplier, imageAOFactors, redChannelFactors } from '../ao';
import { cloneImageData, drawImageToCanvas, imagePixels, pixelateCanvas, pixelsToCanvas, resampleAndPixelate, resizeImage } from '../canvas';
import { processImageData, type ProcessOptions } from '../dither';
import { webgpuUsable } from '../gpuCommon';
import { gpuDitherCovers, processImageDataAsync } from '../gpuDither';
import { applyLightmap } from '../lightmap';
import { LUMA } from '../math';
import type { PreviewViewMode, SourceImage } from '../state';
import type { RendererDeps, RenderShared } from './types';

export interface Render2DApi {
  render: () => Promise<void>;
  applyViewportImages: () => void;
}

export function createRender2D(deps: RendererDeps, shared: RenderShared): Render2DApi {
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
    repeatTextureOriginal,
    repeatTextureProcessed,
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
   * entry instead of returning stale output. Bounded LRU over the options
   * key, following the fallbackQuadCache pattern in modelScene.ts. */
  const DITHER_CACHE_MAX = 3;
  const ditherCache = new Map<string, { input: Uint8ClampedArray; output: ImageData }>();

  /** Cache key for the dither options: everything that changes the output
   * besides the input pixels. Slider values are discrete state, so String()
   * round-trips exactly. */
  function ditherKey(options: ProcessOptions, extra = ''): string {
    return `${options.mode}|${options.palette.join(',')}|${options.strength}|${options.brightness}|${options.contrast}|${options.saturation}|${options.stripeAngle}|${options.noiseScale}|${options.seed}|${options.halftoneScale ?? 1}|${extra}`;
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
    while (ditherCache.size > DITHER_CACHE_MAX) {
      ditherCache.delete(ditherCache.keys().next().value as string);
    }
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
   * lands — even if a newer render then drops this frame, the cached entry is
   * still a valid output for its key. */
  async function ditherAsync(key: string, input: Uint8ClampedArray, compute: () => Promise<ImageData>): Promise<ImageData> {
    const cached = lookupDither(key, input);
    if (cached) return cached;
    const output = await compute();
    storeDither(key, input, output);
    return output;
  }

  /** Resamples a lighting map at the processed resolution, then pixelizes it
   * with the same downscale/upscale amount as the base — each base block gets
   * one uniform AO/lighting value, so the shading follows the chunky grid
   * instead of varying smoothly inside a block. */
  function resamplePixelated(image: SourceImage, width: number, height: number): Uint8ClampedArray {
    const canvas = pixelateCanvas(drawImageToCanvas(image, width, height).canvas, state.pixelation, state.upscale);
    return imagePixels(canvas, width, height);
  }

  function currentAOFactors(width: number, height: number, pixelate = false): Uint8ClampedArray | null {
    const source = textures.ao.image;
    if (!source) return null;
    if (pixelate && state.pixelation > 0) {
      return redChannelFactors({ data: resamplePixelated(source, width, height), width, height });
    }
    return imageAOFactors(source, width, height);
  }

  function currentLightmapPixels(width: number, height: number, pixelate = false): Uint8ClampedArray | null {
    const image = textures.lightmap.image ?? shared.implicitLightmapCanvas;
    if (!image) return null;
    return pixelate && state.pixelation > 0 ? resamplePixelated(image, width, height) : imagePixels(image, width, height);
  }

  function applyLighting(data: Uint8ClampedArray, width: number, height: number, pixelate = false): void {
    const aoFactors = currentAOFactors(width, height, pixelate);
    if (aoFactors) applyAO(data, aoFactors, state.aoBias, state.aoPower);
    const lightmapPixels = currentLightmapPixels(width, height, pixelate);
    if (lightmapPixels) applyLightmap(data, lightmapPixels);
  }

  /** Per-pixel shading factor for the halftone dot screen: AO visibility
   * (bias/power remapped exactly as the lighting pass applies it) times the
   * lightmap's luminance. 1 = fully lit, 0 = fully dark. Returns null when
   * there is no AO bake and no lightmap at all (halftone then falls back to
   * luminance-driven dots). The lightmap source matches the lighting pass:
   * the explicit bake if present, else the live implicit bake, so moving the
   * sun re-sizes the dots. */
  function halftoneLighting(width: number, height: number): Float32Array | null {
    const aoFactors = currentAOFactors(width, height, true);
    const lightmap = textures.lightmap.image ?? shared.implicitLightmapCanvas;
    if (!aoFactors && !lightmap) return null;
    const lightmapPixels = currentLightmapPixels(width, height, true);
    const lighting = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
      let factor = 1;
      if (aoFactors) factor *= aoMultiplier(aoFactors[i], state.aoBias, state.aoPower);
      if (lightmapPixels) {
        const offset = i * 4;
        factor *= (lightmapPixels[offset] * LUMA.red + lightmapPixels[offset + 1] * LUMA.green + lightmapPixels[offset + 2] * LUMA.blue) / 255;
      }
      lighting[i] = factor;
    }
    return lighting;
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
    // seams at tile boundaries are visible. Only the display canvases tile —
    // shared.renderedCanvas / originalBaseCanvas (export, viewports, UV
    // overlays) keep the single-tile image. Each pane tiles independently.
    const repeatOriginal = repeatTextureOriginal?.() ? 3 : 1;
    const repeatProcessed = repeatTextureProcessed?.() ? 3 : 1;
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
    if (normalsInspection) {
      // The normals inspection shows the same chunky blocks as the dithered
      // base: the downscale/upscale pixelization applies on top of the
      // target-resolution resample (normals can't be palette-dithered).
      nextCanvas = resampleAndPixelate(processedSource, width, height, state.pixelation, state.upscale);
    } else if (width > processedSource.width) {
      // Upscaling (grid finer than the source) follows the chosen upscale
      // method — nearest keeps the resample crisp for dithering, bilinear
      // smooths it. Downscales keep the filtered drawImage path.
      nextCanvas = pixelateCanvas(resizeImage(processedSource, width, height, state.upscale), state.pixelation, state.upscale);
    } else {
      nextCanvas = pixelateCanvas(drawImageToCanvas(processedSource, width, height).canvas, state.pixelation, state.upscale);
    }
    shared.renderedCanvas = nextCanvas;
    const renderContext = nextCanvas.getContext('2d');
    if (!renderContext) return;
    // The pixelized normals map is already final; the dither pass would
    // corrupt it.
    if (!normalsInspection) {
      const sourceData = renderContext.getImageData(0, 0, width, height);

      const processedOptions = {
        palette: currentColors(), mode: state.mode, strength: state.strength,
        brightness: state.brightness, contrast: state.contrast, saturation: state.saturation,
        stripeAngle: state.stripeAngle, noiseScale: state.noiseScale, seed: state.seed,
        halftoneScale: state.halftoneScale,
      };
      let processedData: ImageData;
      if (state.mode === 'halftone') {
        // Halftone splits color from shading: the dot screen carries the
        // lighting, so the base is the hard-mapped *unlit* color (lighting is
        // not multiplied into it). Inspected maps still skip lighting, exactly
        // like the other modes. The lighting array is part of the cache input.
        const lighting = processedOnlySource ? null : halftoneLighting(width, height);
        const lightingBytes = lighting ? new Uint8ClampedArray(lighting.buffer, lighting.byteOffset, lighting.byteLength) : null;
        const input = new Uint8ClampedArray(sourceData.data.length + (lightingBytes ? lightingBytes.length : 0));
        input.set(sourceData.data);
        if (lightingBytes) input.set(lightingBytes, sourceData.data.length);
        processedData = ditherSync(
          `${ditherKey(processedOptions)}|halftone-light|${lightingBytes ? 1 : 0}`,
          input,
          () => processImageData(sourceData, { ...processedOptions, lighting }),
        );
      } else {
        // Lighting stays synchronous; the dither itself may go to the GPU.
        const lit = cloneImageData(sourceData);
        if (!processedOnlySource) applyLighting(lit.data, lit.width, lit.height, true);
        if (state.mode === 'none') {
          // 'none' passes the lit source through unchanged — the dither is
          // free, so there is nothing worth caching.
          processedData = processImageData(lit, processedOptions);
        } else {
          if (webgpuUsable() && gpuDitherCovers(state.mode)) {
            // The GPU dither is async: a newer render supersedes this frame, so
            // a stale result is dropped instead of overwriting the freshest one.
            const token = ++ditherToken;
            processedData = await ditherAsync(ditherKey(processedOptions), lit.data, () => processImageDataAsync(lit, processedOptions));
            if (token !== ditherToken) return;
          } else {
            // No WebGPU (or a mode the GPU pass does not cover): the exact
            // synchronous CPU path — byte-identical to the pre-GPU pipeline.
            processedData = ditherSync(ditherKey(processedOptions), lit.data, () => processImageData(lit, processedOptions));
          }
        }
      }
      renderContext.putImageData(processedData, 0, 0);
    }

    previewCanvas.width = width * repeatProcessed;
    previewCanvas.height = height * repeatProcessed;
    // Mark the display canvas so preview2d shows the 3× buffer at 3× scale —
    // a pure transform: each tile keeps the single-tile size, the window
    // layout never moves, and the grid overflows until the user scrolls out.
    previewCanvas.classList.toggle('repeat-tiled', repeatProcessed === 3);
    const previewContext = previewCanvas.getContext('2d');
    if (previewContext) {
      for (let ty = 0; ty < repeatProcessed; ty += 1) {
        for (let tx = 0; tx < repeatProcessed; tx += 1) {
          previewContext.drawImage(shared.renderedCanvas, tx * width, ty * height);
        }
      }
    }

    // Original pane shows its chosen source at native resolution — the pixel
    // grid slider must not affect it.
    const originalSource = originalOnlySource ?? textures.base.image!;
    const litSourceNative = originalOnlySource
      ? drawImageToCanvas(originalSource, originalSource.width, originalSource.height).canvas
      : litCanvas(originalSource, originalSource.width, originalSource.height);
    shared.originalBaseCanvas = litSourceNative;
    originalCanvas.width = originalSource.width * repeatOriginal;
    originalCanvas.height = originalSource.height * repeatOriginal;
    originalCanvas.classList.toggle('repeat-tiled', repeatOriginal === 3);
    const originalContext = originalCanvas.getContext('2d');
    if (originalContext) {
      for (let ty = 0; ty < repeatOriginal; ty += 1) {
        for (let tx = 0; tx < repeatOriginal; tx += 1) {
          originalContext.drawImage(litSourceNative, tx * originalSource.width, ty * originalSource.height);
        }
      }
    }

    // The UV wireframe is drawn on display-resolution overlay canvases
    // (overlay.syncWireframeOverlays) — never into the low-res texture
    // bitmaps, where antialiased lines would upscale into dithered speckles.

    updatePreviewBadge(width, height);
    applyViewportImages();
  }

  /** Re-applies the last rendered frames to both 3D viewports. Runs at the
   * end of every render, and is re-invoked by main.ts immediately after a
   * fallback-quad swap — the freshly installed quads' materials carry no map
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
