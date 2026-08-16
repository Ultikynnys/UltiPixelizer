import { createBake } from './bake';
import { createOverlay } from './overlay';
import { createRender2D } from './render2d';
import type { RendererDeps, RendererApi, RenderShared } from './types';

export type { RendererApi, RendererDeps } from './types';

export function createRenderer(deps: RendererDeps): RendererApi {
  const shared: RenderShared = {
    renderedCanvas: document.createElement('canvas'),
    originalBaseCanvas: null,
    implicitLightmapCanvas: null,
    implicitLightmapTimer: 0,
  };

  const overlay = createOverlay(deps, shared);
  const render2d = createRender2D(deps, shared, overlay);
  const bake = createBake(deps, shared, render2d);

  return {
    render: render2d.render,
    generateAo: bake.generateAo,
    bakeLighting: bake.bakeLighting,
    clearLightmap: bake.clearLightmap,
    scheduleImplicitLightmapBake: bake.scheduleImplicitLightmapBake,
    scheduleNormalAdjustedLighting: bake.scheduleNormalAdjustedLighting,
    refreshUVWireframe: overlay.refreshUVWireframe,
    refreshUVOverlap: overlay.refreshUVOverlap,
    resetPreview: () => {
      overlay.reset();
      bake.reset();
    },
    getRenderedCanvas: () => shared.renderedCanvas,
  };
}
