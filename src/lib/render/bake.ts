import { bakeMeshAO } from '../aoBake';
import { factorsToCanvas, pixelsToCanvas } from '../canvas';
import { errorMessage } from '../strings';
import { bakeMeshLightmap, type BakeLightmapOptions } from '../lightmapBake';
import { imageNormalMapPixels } from '../normal';
import type { Render2DApi } from './render2d';
import type { RendererDeps, RenderShared } from './types';

const AO_BAKE_SAMPLES = 128;

export interface BakeApi {
  generateAo: () => void;
  bakeLighting: () => void;
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
  } = deps;

  function normalMapOptions() {
    const image = textures.normal.image;
    if (!image) return { normalStrength: state.normalStrength, normalFlipY: state.normalFormat === 'directx' };
    return {
      normalMap: imageNormalMapPixels(image),
      normalStrength: state.normalStrength,
      normalFlipY: state.normalFormat === 'directx',
    };
  }

  function currentLightmapBakeOptions(): BakeLightmapOptions {
    return {
      sunDirection: state.sun.direction,
      sunColor: state.sun.color,
      sunIntensity: state.sun.intensity,
      sunEnabled: state.sun.enabled,
      ambientColor: state.ambient.color,
      ambientIntensity: state.ambient.intensity,
      ambientEnabled: state.ambient.enabled,
      ...normalMapOptions(),
    };
  }

  function bakeLightmapCanvas(): HTMLCanvasElement | null {
    const scene = getAOScene();
    if (!scene || !textures.base.image) return null;
    const baseColor = textures.base.image;
    const pixels = bakeMeshLightmap(scene, baseColor.width, baseColor.height, currentLightmapBakeOptions());
    return pixelsToCanvas(pixels, baseColor.width, baseColor.height);
  }

  function computeAO(): void {
    const scene = getAOScene();
    if (!scene) {
      textures.ao.image = null;
      textures.ao.name = '';
      return;
    }
    const baseColor = textures.base.image!;
    textures.ao.image = factorsToCanvas(
      bakeMeshAO(scene, baseColor.width, baseColor.height, { samples: AO_BAKE_SAMPLES, distance: state.aoDistance }),
      baseColor.width,
      baseColor.height,
    );
    textures.ao.name = 'Generated AO';
  }

  function generateAo(): void {
    if (!getAOScene()) {
      showToast('Load a model to generate AO');
      return;
    }
    showToast('Generating AO…');
    window.setTimeout(() => {
      try {
        computeAO();
        renderTextureRibbon();
        render2d.render();
        showToast('Ambient occlusion generated');
      } catch (error) {
        showToast(errorMessage(error, 'Could not generate ambient occlusion.'));
      }
    }, 30);
  }

  function bakeLighting(): void {
    if (!getAOScene()) {
      showToast('Load a model to bake lighting');
      return;
    }
    showToast('Baking lighting…');
    window.setTimeout(() => {
      try {
        const canvas = bakeLightmapCanvas();
        if (!canvas) {
          showToast('Load a base texture to bake lighting');
          return;
        }
        textures.lightmap.image = canvas;
        textures.lightmap.name = 'Baked lighting';
        renderLightmapControls();
        renderNormalControls();
        renderTextureRibbon();
        applySun();
        render2d.render();
        showToast('Lighting baked');
      } catch (error) {
        showToast(errorMessage(error, 'Could not bake lighting.'));
      }
    }, 30);
  }

  function clearLightmap(): void {
    textures.lightmap.image = null;
    textures.lightmap.name = '';
    renderLightmapControls();
    renderNormalControls();
    renderTextureRibbon();
    applySun();
    render2d.render();
  }

  function bakeImplicitLightmap(): void {
    if (!getAOScene() || !textures.base.image || textures.lightmap.image) {
      shared.implicitLightmapCanvas = null;
      return;
    }
    try {
      shared.implicitLightmapCanvas = bakeLightmapCanvas();
      render2d.render();
    } catch {
      shared.implicitLightmapCanvas = null;
    }
  }

  function scheduleImplicitLightmapBake(): void {
    if (shared.implicitLightmapTimer) window.clearTimeout(shared.implicitLightmapTimer);
    shared.implicitLightmapTimer = 0;
    if (textures.lightmap.image !== null || getAOScene() === null) return;
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
