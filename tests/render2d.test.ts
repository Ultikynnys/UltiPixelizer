import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRender2D } from '../src/lib/render/render2d';
import type { RenderShared } from '../src/lib/render/types';
import type { ModelViewport } from '../src/lib/modelPreview';
import { createRendererDeps } from './helpers/rendererDeps';
import { asSourceImage, FakeCanvas, installDomStubs, stubDocument } from './helpers/domStubs';

beforeAll(() => {
  installDomStubs();
});

function baseTexture() {
  const canvas = new FakeCanvas();
  canvas.width = 2;
  canvas.height = 2;
  canvas.context.pixels.set([
    10, 10, 10, 255,
    20, 20, 20, 255,
    30, 30, 30, 255,
    40, 40, 40, 255,
  ]);
  return asSourceImage(canvas);
}

function sharedState(): RenderShared {
  return {
    renderedCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
    originalBaseCanvas: null,
    implicitLightmapCanvas: null,
    implicitLightmapTimer: 0,
  };
}

/** A source canvas that carries a fixed 1×1 pixel value. */
function solidTexture(rgba: number[]) {
  const canvas = new FakeCanvas();
  canvas.width = 1;
  canvas.height = 1;
  canvas.context.pixels.set(rgba);
  return asSourceImage(canvas);
}

describe('createRender2D render pipeline', () => {
  it('dithers the source into the preview and shows the lit source in the original pane', () => {
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    const shared = sharedState();
    const overlay = { hasWireframe: vi.fn(() => false), drawWireframe: vi.fn() };
    createRender2D(deps, shared, overlay).render();

    // Every pixel quantizes to the nearest of black/white — all black.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
    // The original pane keeps the unquantized lit source.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255]);
    expect(shared.renderedCanvas).toBeDefined();
    expect(deps.updatePreviewBadge).toHaveBeenCalledWith(2, 2);
    expect(overlay.drawWireframe).not.toHaveBeenCalled();
  });

  it('applies AO factors before dithering, darkening the original pane', () => {
    const ao = solidTexture([0, 0, 0, 255]); // fully occluded (red = 0)
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: ao, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    const shared = sharedState();
    createRender2D(deps, shared, { hasWireframe: () => false, drawWireframe: vi.fn() }).render();
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('multiplies the lightmap into the lit source', () => {
    const lightmap = solidTexture([0, 0, 0, 255]); // black lightmap at full contribution
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: lightmap, name: '' } } });
    const shared = sharedState();
    createRender2D(deps, shared, { hasWireframe: () => false, drawWireframe: vi.fn() }).render();
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('draws the UV wireframe onto both panes when enabled and available', () => {
    const drawWireframe = vi.fn();
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.showUVWireframe = true;
    const shared = sharedState();
    createRender2D(deps, shared, { hasWireframe: () => true, drawWireframe }).render();
    expect(drawWireframe).toHaveBeenCalledTimes(2);
  });

  it('skips wireframe drawing when the overlay has no triangles', () => {
    const drawWireframe = vi.fn();
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.showUVWireframe = true;
    createRender2D(deps, sharedState(), { hasWireframe: () => false, drawWireframe }).render();
    expect(drawWireframe).not.toHaveBeenCalled();
  });

  it('feeds the viewports when both are available', () => {
    const originalViewport = { applyImage: vi.fn() };
    const processedViewport = { applyImage: vi.fn() };
    const deps = createRendererDeps({
      textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } },
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    createRender2D(deps, sharedState(), { hasWireframe: () => false, drawWireframe: vi.fn() }).render();
    expect(originalViewport.applyImage).toHaveBeenCalledOnce();
    expect(processedViewport.applyImage).toHaveBeenCalledOnce();
  });

  it('stops early when the canvas context is unavailable', () => {
    stubDocument(() => ({ width: 0, height: 0, getContext: () => null }));
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    const shared = sharedState();
    createRender2D(deps, shared, { hasWireframe: () => false, drawWireframe: vi.fn() }).render();
    expect(shared.renderedCanvas).toBeDefined();
    expect(deps.updatePreviewBadge).not.toHaveBeenCalled();
  });
});
