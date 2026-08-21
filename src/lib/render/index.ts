import { createBake } from './bake';
import { createOverlay } from './overlay';
import { createRender2D } from './render2d';
import { createCanvas } from '../canvas';
import type { RendererDeps, RendererApi, RenderShared } from './types';

export type { RendererApi, RendererDeps } from './types';

export function createRenderer(deps: RendererDeps): RendererApi {
  const shared: RenderShared = {
    renderedCanvas: createCanvas(0, 0).canvas,
    originalBaseCanvas: null,
    implicitLightmapCanvas: null,
    implicitLightmapTimer: 0,
    lightmapCleared: false,
  };

  const overlay = createOverlay(deps, shared);
  const render2d = createRender2D(deps, shared);
  const bake = createBake(deps, shared, render2d);

  return {
    render: () => {
      render2d.render();
      // The wireframe overlay's letterbox rect depends on the texture bitmap
      // size, which only changes in render — keep the overlays aligned.
      overlay.syncWireframeOverlays();
    },
    applyViewportImages: render2d.applyViewportImages,
    generateAo: bake.generateAo,
    bakeLighting: bake.bakeLighting,
    clearLightmap: bake.clearLightmap,
    invalidateBakeScene: bake.invalidateBakeScene,
    setFallbackQuad: bake.setFallbackQuad,
    refreshUVWireframe: overlay.refreshUVWireframe,
    refreshUVOverlap: overlay.refreshUVOverlap,
    invalidateUVOverlap: overlay.invalidateUVOverlap,
    syncWireframeOverlays: overlay.syncWireframeOverlays,
    resetPreview: () => {
      overlay.reset();
      bake.reset();
    },
    getRenderedCanvas: () => shared.renderedCanvas,
    getImplicitLightmapCanvas: () => shared.implicitLightmapCanvas,
  };
}
