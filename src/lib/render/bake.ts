import { bakeMeshAOAsync, logAOBakeStage } from '../aoBake';
import { getBakeScene, invalidateBakeSceneCache } from '../bakeSceneCache';
import { factorsToCanvas, pixelsToCanvas, resampleAndPixelate, type UpscaleMethod } from '../canvas';
import { bakeLightmapAsync, type BakeLightmapOptions } from '../lightmapBake';
import { getFallbackQuadScene } from '../modelScene';
import { imageNormalMapPixels } from '../normal';
import type { SourceImage } from '../state';
import { Object3D } from 'three';
import { WorkerJobCancelledError } from '../workerCommon';
import type { Render2DApi } from './render2d';
import type { RendererDeps, RenderShared } from './types';

// Hemisphere samples per texel. 64 cosine-weighted symmetric samples is
// visually near-identical to 128 at a fraction of the bake time — the AO bake
// cost scales linearly with this count (and with texel count, i.e. resolution).
const AO_BAKE_SAMPLES = 64;

// When no model is loaded the AO scene is null and every bake would otherwise
// no-op. Substitute a flat quad facing up (see createFallbackQuadScene): the
// default sun, which travels downward, lights it; a lone plane occludes
// nothing — the AO bake comes out white, which is exactly correct for a flat
// surface. Its UVs span 0..1, so the full texture bakes. main.ts replaces the
// quad via setFallbackQuad when the quad view's tessellation / grid /
// displacement settings change. In grid mode the bake scene is the full 3×3
// grid — the neighbors are occluder-only (see collectBakeScene), so they cast
// shadows on the middle tile's bake without rasterizing over its texture.
// Memoized (see getFallbackQuadScene) so the default quad is generated once
// and shares its bake-scene cache entry with main.ts's default instance.
let fallbackQuad: Object3D = getFallbackQuadScene(1, false);
function fallbackQuadScene(): Object3D {
  return fallbackQuad;
}

export interface BakeApi {
  generateAo: () => Promise<boolean>;
  bakeLighting: () => Promise<boolean>;
  clearLightmap: (suppressImplicit?: boolean) => void;
  /** Whether the lightmap slot was explicitly cleared (X) — while set, the
   * app-level implicit re-bake scheduler must stay quiet so the render keeps
   * the user's unlit choice until Orient Sun with Camera, a loaded lightmap,
   * or a reset re-engages it. */
  isLightmapCleared: () => boolean;
  invalidateBakeScene: () => void;
  /** Replaces the bake geometry used when no model is loaded — the quad view's
   * tessellated tile (or the full 3×3 grid in grid mode, whose neighbors are
   * occluder-only). Callers must invalidate the bake scene alongside
   * (invalidateBakeScene) so the next bake recollects the new quad. */
  setFallbackQuad: (scene: Object3D) => void;
  reset: () => void;
}
export function createBake(deps: RendererDeps, shared: RenderShared, render2d: Render2DApi): BakeApi {
  const {
    state,
    textures,
    getAOScene,
    renderLightmapControls,
    renderNormalControls,
    renderTextureRibbon,
    applySun,
    dimensions,
  } = deps;

  // The scene the bakes run against: the AO scene when a model is loaded,
  // otherwise the flat quad facing up (see fallbackQuadScene) so the bakes
  // always have geometry to light.
  function bakeSceneSource(): Object3D {
    return getAOScene() ?? fallbackQuadScene();
  }

  // The processed normal map — resampled to the output resolution and pixelized
  // with the downscale/upscale amount — is what the bakes sample, so lighting
  // and AO follow the same chunky normals the processed viewports display. The
  // decoded pixels are memoized per (image, bake size, pixelation, upscale):
  // re-baking on a sun or strength tweak shouldn't re-read the whole map off
  // the canvas.
  let cachedNormalMap: {
    image: SourceImage;
    width: number;
    height: number;
    pixelation: number;
    upscale: UpscaleMethod;
    source: ReturnType<typeof imageNormalMapPixels>;
  } | null = null;

  function normalMapOptions() {
    const normalFlipY = state.normalFormat === 'directx';
    const image = textures.normal.image;
    if (!image) return { normalStrength: state.normalStrength, normalFlipY };
    const { width, height } = dimensions();
    if (
      !cachedNormalMap
      || cachedNormalMap.image !== image
      || cachedNormalMap.width !== width
      || cachedNormalMap.height !== height
      || cachedNormalMap.pixelation !== state.pixelation
      || cachedNormalMap.upscale !== state.upscale
    ) {
      cachedNormalMap = {
        image,
        width,
        height,
        pixelation: state.pixelation,
        upscale: state.upscale,
        source: imageNormalMapPixels(resampleAndPixelate(image, width, height, state.pixelation, state.upscale)),
      };
    }
    return {
      normalMap: cachedNormalMap.source,
      normalStrength: state.normalStrength,
      normalFlipY,
    };
  }

  function currentLightmapBakeOptions(): BakeLightmapOptions {
    return {
      sunDirection: state.sun.direction,
      sunColor: state.sun.color,
      sunIntensity: state.sun.intensity,
      ambientColor: state.ambient.color,
      ambientIntensity: state.ambient.intensity,
      ...normalMapOptions(),
    };
  }

  let explicitBakeToken = 0;
  let explicitBakeController: AbortController | null = null;

  async function bakeLightmapCanvas(signal?: AbortSignal): Promise<HTMLCanvasElement | null> {
    if (!textures.base.image) return null;
    const scene = bakeSceneSource();
    // Baked maps render at the dithered texture resolution — identical to the
    // processed output — so lighting and occlusion align 1:1 with the texture.
    const { width, height } = dimensions();
    const bakeScene = getBakeScene(scene);
    const pixels = await bakeLightmapAsync(scene, width, height, currentLightmapBakeOptions(), bakeScene ?? undefined, signal);
    return pixelsToCanvas(pixels, width, height);
  }

  async function computeAO(): Promise<boolean> {
    const start = performance.now();
    const scene = bakeSceneSource();
    const { width, height } = dimensions();
    const normalStart = performance.now();
    const normalOptions = normalMapOptions();
    logAOBakeStage('normal map prep', normalStart);
    const collectStart = performance.now();
    const bakeScene = getBakeScene(scene, state.aoDistance) ?? undefined;
    logAOBakeStage('scene collection', collectStart);
    const factors = await bakeMeshAOAsync(
      scene,
      width,
      height,
      { samples: AO_BAKE_SAMPLES, distance: state.aoDistance, ...normalOptions },
      undefined,
      bakeScene,
    );
    const canvasStart = performance.now();
    textures.ao.image = factorsToCanvas(factors, width, height);
    textures.ao.name = 'Generated AO';
    logAOBakeStage('canvas', canvasStart);
    logAOBakeStage('total', start);
    return true;
  }

  // Shared async-bake runner: deferred try/catch. Resolves true when the bake
  // completed, false on early exit or failure (failures are logged to the
  // console) — callers that need the result, like the texture-slot download
  // button, can await it. No scene guard: bakeSceneSource guarantees the
  // bakes always have geometry to run against.
  function runBakeTask(failureMessage: string, work: () => boolean | Promise<boolean>): Promise<boolean> {
    return new Promise((resolve) => {
      window.setTimeout(() => {
        Promise.resolve()
          .then(work)
          .then(resolve)
          .catch((error) => {
            if (!(error instanceof WorkerJobCancelledError)) console.error(failureMessage, error);
            resolve(false);
          });
      }, 30);
    });
  }

  function generateAo(): Promise<boolean> {
    return runBakeTask('Could not generate ambient occlusion.', async () => {
      const completed = await computeAO();
      if (!completed) return false;
      renderTextureRibbon();
      render2d.render();
      return true;
    });
  }

  function bakeLighting(): Promise<boolean> {
    explicitBakeController?.abort();
    const token = ++explicitBakeToken;
    const controller = new AbortController();
    explicitBakeController = controller;
    return runBakeTask('Could not bake lighting.', async () => {
      const canvas = await bakeLightmapCanvas(controller.signal);
      if (!canvas || token !== explicitBakeToken) return false;
      textures.lightmap.image = canvas;
      textures.lightmap.name = 'Baked lighting';
      shared.lightmapCleared = false;
      renderLightmapControls();
      renderNormalControls();
      renderTextureRibbon();
      applySun();
      render2d.render();
      return true;
    }).finally(() => {
      if (explicitBakeController === controller) explicitBakeController = null;
    });
  }

  function clearLightmap(suppressImplicit = false): void {
    explicitBakeToken += 1;
    explicitBakeController?.abort();
    explicitBakeController = null;
    textures.lightmap.image = null;
    textures.lightmap.name = '';
    // Clear legacy in-memory preview state as well as the committed texture.
    // While suppressImplicit is set (the slot X), the app-level implicit
    // re-bake scheduler checks isLightmapCleared and stays quiet: lighting
    // remains absent until Orient Sun with Camera bakes again, the user loads
    // a lightmap, or a reset re-engages it.
    shared.implicitLightmapCanvas = null;
    if (shared.implicitLightmapTimer) window.clearTimeout(shared.implicitLightmapTimer);
    shared.implicitLightmapTimer = 0;
    if (suppressImplicit) shared.lightmapCleared = true;
    if (state.viewModeOriginal === 'lightmap') state.viewModeOriginal = 'flat';
    if (state.viewModeProcessed === 'lightmap') state.viewModeProcessed = 'flat';
    renderLightmapControls();
    renderNormalControls();
    renderTextureRibbon();
    applySun();
    render2d.render();
  }

  function reset(): void {
    explicitBakeToken += 1;
    explicitBakeController?.abort();
    explicitBakeController = null;
    shared.implicitLightmapCanvas = null;
    if (shared.implicitLightmapTimer) window.clearTimeout(shared.implicitLightmapTimer);
    shared.implicitLightmapTimer = 0;
    // Fresh state (model close / full reset) re-engages the live preview.
    shared.lightmapCleared = false;
    cachedNormalMap = null;
  }

  return {
    generateAo,
    bakeLighting,
    clearLightmap,
    isLightmapCleared: () => shared.lightmapCleared,
    invalidateBakeScene: invalidateBakeSceneCache,
    setFallbackQuad: (scene: Object3D) => {
      fallbackQuad = scene;
    },
    reset,
  };
}
