import { bakeMeshAOAsync } from '../aoBake';
import { getBakeScene, invalidateBakeSceneCache } from '../bakeSceneCache';
import { factorsToCanvas, pixelsToCanvas } from '../canvas';
import { bakeMeshLightmap, type BakeLightmapOptions } from '../lightmapBake';
import { imageNormalMapPixels } from '../normal';
import { lightmapIsActive, type SourceImage } from '../state';
import type { Render2DApi } from './render2d';
import type { RendererDeps, RenderShared } from './types';

const AO_BAKE_SAMPLES = 128;

export interface BakeApi {
  generateAo: () => Promise<boolean>;
  bakeLighting: () => Promise<boolean>;
  clearLightmap: (suppressImplicit?: boolean) => void;
  reengageImplicitLightmap: () => void;
  scheduleImplicitLightmapBake: () => void;
  scheduleNormalAdjustedLighting: () => void;
  invalidateBakeScene: () => void;
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
    onAoProgress,
  } = deps;

  // The AO scene geometry is static between UV/LOD/world-axis/model changes, so
  // the decoded normal-map pixels are memoized per image — re-baking on a sun
  // or strength tweak shouldn't re-read the whole map off the canvas.
  let cachedNormalMap: { image: SourceImage; source: ReturnType<typeof imageNormalMapPixels> } | null = null;

  function normalMapOptions() {
    const normalFlipY = state.normalFormat === 'directx';
    const image = textures.normal.image;
    if (!image) return { normalStrength: state.normalStrength, normalFlipY };
    if (!cachedNormalMap || cachedNormalMap.image !== image) {
      cachedNormalMap = { image, source: imageNormalMapPixels(image) };
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

  function bakeLightmapCanvas(): HTMLCanvasElement | null {
    const scene = getAOScene();
    if (!scene || !textures.base.image) return null;
    // Baked maps render at the dithered texture resolution — identical to the
    // processed output — so lighting and occlusion align 1:1 with the texture.
    const { width, height } = dimensions();
    const bakeScene = getBakeScene(scene);
    const pixels = bakeMeshLightmap(scene, width, height, currentLightmapBakeOptions(), bakeScene ?? undefined);
    return pixelsToCanvas(pixels, width, height);
  }

  async function computeAO(): Promise<boolean> {
    const scene = getAOScene();
    if (!scene) {
      textures.ao.image = null;
      textures.ao.name = '';
      return false;
    }
    const { width, height } = dimensions();
    const factors = await bakeMeshAOAsync(
      scene,
      width,
      height,
      { samples: AO_BAKE_SAMPLES, distance: state.aoDistance },
      onAoProgress,
      getBakeScene(scene, state.aoDistance) ?? undefined,
    );
    textures.ao.image = factorsToCanvas(factors, width, height);
    textures.ao.name = 'Generated AO';
    return true;
  }

  // Shared async-bake runner: scene guard, deferred try/catch. Resolves true
  // when the bake completed, false on early exit or failure (failures are
  // logged to the console) — callers that need the result, like the
  // texture-slot download button, can await it.
  function runBakeTask(failureMessage: string, work: () => boolean | Promise<boolean>): Promise<boolean> {
    if (!getAOScene()) return Promise.resolve(false);
    return new Promise((resolve) => {
      window.setTimeout(() => {
        Promise.resolve()
          .then(work)
          .then(resolve)
          .catch((error) => {
            console.error(failureMessage, error);
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
    return runBakeTask('Could not bake lighting.', () => {
      const canvas = bakeLightmapCanvas();
      if (!canvas) return false;
      textures.lightmap.image = canvas;
      textures.lightmap.name = 'Baked lighting';
      // An explicit bake re-engages the live implicit preview for future edits.
      shared.lightmapCleared = false;
      renderLightmapControls();
      renderNormalControls();
      renderTextureRibbon();
      applySun();
      render2d.render();
      return true;
    });
  }

  function clearLightmap(suppressImplicit = false): void {
    textures.lightmap.image = null;
    textures.lightmap.name = '';
    // The slot previews the live implicit bake, so removing the lightmap must
    // also drop that canvas and cancel any pending re-bake — otherwise the
    // preview (and the render) keep the lightmap alive and X appears to do
    // nothing. `suppressImplicit` (the slot X button) additionally stops the
    // implicit bake from restarting: no lightmap means a pure-white multiply,
    // i.e. unlit, until the user explicitly bakes or loads one.
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

  /** Re-engages the live implicit bake after the user cleared the lightmap
   * slot — explicit actions (e.g. orient sun with camera) must still produce
   * a lightmap. */
  function reengageImplicitLightmap(): void {
    shared.lightmapCleared = false;
  }

  function bakeImplicitLightmap(): void {
    if (!getAOScene() || !textures.base.image || lightmapIsActive(textures) || shared.lightmapCleared) {
      shared.implicitLightmapCanvas = null;
      renderTextureRibbon();
      return;
    }
    try {
      shared.implicitLightmapCanvas = bakeLightmapCanvas();
      render2d.render();
      // The lightmap slot previews the implicit bake, so the ribbon needs a
      // refresh when the canvas lands (or disappears on failure).
      renderTextureRibbon();
    } catch (error) {
      shared.implicitLightmapCanvas = null;
      console.error('Implicit lightmap bake failed.', error);
      renderTextureRibbon();
    }
  }

  function scheduleImplicitLightmapBake(): void {
    if (shared.implicitLightmapTimer) window.clearTimeout(shared.implicitLightmapTimer);
    shared.implicitLightmapTimer = 0;
    if (lightmapIsActive(textures) || getAOScene() === null || shared.lightmapCleared) return;
    shared.implicitLightmapTimer = window.setTimeout(() => {
      shared.implicitLightmapTimer = 0;
      bakeImplicitLightmap();
    }, 200);
  }

  function scheduleNormalAdjustedLighting(): void {
    scheduleImplicitLightmapBake();
  }

  function reset(): void {
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
    reengageImplicitLightmap,
    scheduleImplicitLightmapBake,
    scheduleNormalAdjustedLighting,
    invalidateBakeScene: invalidateBakeSceneCache,
    reset,
  };
}
