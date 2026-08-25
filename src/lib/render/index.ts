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
    uvStretchData: null,
    uvStretchScene: null,
    uvStretchColored: null,
    uvStretchSensitivity: NaN,
    uvStretchCanvas: null,
    uvStretchCanvasWidth: 0,
    uvStretchCanvasHeight: 0,
    directionalityCanvas: null,
    directionalityCanvasWidth: 0,
    directionalityCanvasHeight: 0,
    varianceData: null,
    varianceScene: null,
    varianceCanvas: null,
    varianceCanvasWidth: 0,
    varianceCanvasHeight: 0,
    lightmapCleared: false,
  };

  const overlay = createOverlay(deps, shared);
  const render2d = createRender2D(deps, shared);
  const bake = createBake(deps, shared, render2d);

  return {
    render: async () => {
      // render2d.render() is async: on the WebGPU dither path it awaits the
      // GPU pass before resizing the display canvases. The wireframe overlay
      // must be rasterized at the *post-resize* resolution, so await the render
      // to completion before syncing  otherwise the overlay is drawn at the
      // previous resolution and CSS-upscaled into a blurry mess.
      await render2d.render();
      // The wireframe overlay's letterbox rect depends on the texture bitmap
      // size, which only changes in render  keep the overlays aligned.
      overlay.syncWireframeOverlays();
    },
    applyViewportImages: render2d.applyViewportImages,
    generateAo: bake.generateAo,
    bakeLighting: bake.bakeLighting,
    clearLightmap: bake.clearLightmap,
    isLightmapCleared: bake.isLightmapCleared,
    reengageLighting: bake.reengageLighting,
    invalidateBakeScene: bake.invalidateBakeScene,
    setFallbackQuad: bake.setFallbackQuad,
    refreshUVWireframe: overlay.refreshUVWireframe,
    refreshUVOverlap: overlay.refreshUVOverlap,
    invalidateUVOverlap: overlay.invalidateUVOverlap,
    invalidateUVStretch: () => {
      shared.uvStretchData = null;
      shared.uvStretchScene = null;
      shared.uvStretchColored = null;
      shared.uvStretchSensitivity = NaN;
      shared.uvStretchCanvas = null;
      shared.uvStretchCanvasWidth = 0;
      shared.uvStretchCanvasHeight = 0;
      shared.varianceData = null;
      shared.varianceScene = null;
      shared.varianceCanvas = null;
      shared.varianceCanvasWidth = 0;
      shared.varianceCanvasHeight = 0;
      deps.forEachViewport((viewport) => viewport.setUVStretch(null));
    },
    syncWireframeOverlays: overlay.syncWireframeOverlays,
    resetPreview: () => {
      overlay.reset();
      bake.reset();
    },
    getRenderedCanvas: () => shared.renderedCanvas,
    getImplicitLightmapCanvas: () => shared.implicitLightmapCanvas,
  };
}
