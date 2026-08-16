import { bakeMeshAOAsync } from '../aoBake';
import { factorsToCanvas, pixelsToCanvas } from '../canvas';
import { errorMessage } from '../strings';
import { bakeMeshLightmap, type BakeLightmapOptions } from '../lightmapBake';
import { imageNormalMapPixels } from '../normal';
import { lightmapIsActive } from '../state';
import type { Render2DApi } from './render2d';
import type { RendererDeps, RenderShared } from './types';

const AO_BAKE_SAMPLES = 128;

export interface BakeApi {
  generateAo: () => Promise<boolean>;
  bakeLighting: () => Promise<boolean>;
  clearLightmap: () => void;
  scheduleImplicitLightmapBake: () => void;
  scheduleNormalAdjustedLighting: () => void;
  reset: () => void;
}

export function createBake(deps: RendererDeps, shared: RenderShared, render2d: Render2DApi): BakeApi {
  const {
    state,
    textures,
    getAOScene,
    showToast,
    renderLightmapControls,
    renderNormalControls,
    renderTextureRibbon,
    applySun,
    dimensions,
  } = deps;

  function normalMapOptions() {
    const normalFlipY = state.normalFormat === 'directx';
    const image = textures.normal.image;
    if (!image) return { normalStrength: state.normalStrength, normalFlipY };
    return {
      normalMap: imageNormalMapPixels(image),
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
    const pixels = bakeMeshLightmap(scene, width, height, currentLightmapBakeOptions());
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
      (percent) => showToast(`Generating AO… ${percent}%`),
    );
    textures.ao.image = factorsToCanvas(factors, width, height);
    textures.ao.name = 'Generated AO';
    return true;
  }

  // Shared async-bake runner: scene guard, progress toast, deferred try/catch.
  // Resolves true when the bake completed, false on early exit or failure (the
  // relevant toast is already shown in both cases) — callers that need the
  // result, like the texture-slot download button, can await it.
  function runBakeTask(
    noSceneMessage: string,
    progressMessage: string,
    failureMessage: string,
    successMessage: string,
    work: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    if (!getAOScene()) {
      showToast(noSceneMessage);
      return Promise.resolve(false);
    }
    showToast(progressMessage);
    return new Promise((resolve) => {
      window.setTimeout(() => {
        Promise.resolve()
          .then(work)
          .then((completed) => {
            if (completed) showToast(successMessage);
            resolve(completed);
          })
          .catch((error) => {
            showToast(errorMessage(error, failureMessage));
            resolve(false);
          });
      }, 30);
    });
  }

  function generateAo(): Promise<boolean> {
    return runBakeTask('Load a model to generate AO', 'Generating AO…', 'Could not generate ambient occlusion.', 'Ambient occlusion generated', async () => {
      const completed = await computeAO();
      if (!completed) return false;
      renderTextureRibbon();
      render2d.render();
      return true;
    });
  }

  function bakeLighting(): Promise<boolean> {
    return runBakeTask('Load a model to bake lighting', 'Baking lighting…', 'Could not bake lighting.', 'Lighting baked', () => {
      const canvas = bakeLightmapCanvas();
      if (!canvas) {
        showToast('Load a base texture to bake lighting');
        return false;
      }
      textures.lightmap.image = canvas;
      textures.lightmap.name = 'Baked lighting';
      renderLightmapControls();
      renderNormalControls();
      renderTextureRibbon();
      applySun();
      render2d.render();
      return true;
    });
  }

  function clearLightmap(): void {
    textures.lightmap.image = null;
    textures.lightmap.name = '';
    if (state.viewMode === 'lightmap') state.viewMode = 'flat';
    renderLightmapControls();
    renderNormalControls();
    renderTextureRibbon();
    applySun();
    render2d.render();
  }

  function bakeImplicitLightmap(): void {
    if (!getAOScene() || !textures.base.image || lightmapIsActive(textures)) {
      shared.implicitLightmapCanvas = null;
      return;
    }
    try {
      shared.implicitLightmapCanvas = bakeLightmapCanvas();
      render2d.render();
    } catch (error) {
      shared.implicitLightmapCanvas = null;
      console.error('Implicit lightmap bake failed.', error);
    }
  }

  function scheduleImplicitLightmapBake(): void {
    if (shared.implicitLightmapTimer) window.clearTimeout(shared.implicitLightmapTimer);
    shared.implicitLightmapTimer = 0;
    if (lightmapIsActive(textures) || getAOScene() === null) return;
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
  }

  return {
    generateAo,
    bakeLighting,
    clearLightmap,
    scheduleImplicitLightmapBake,
    scheduleNormalAdjustedLighting,
    reset,
  };
}
