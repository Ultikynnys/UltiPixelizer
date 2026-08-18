import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene } from 'three';
import { createOverlay } from '../src/lib/render/overlay';
import type { RenderShared } from '../src/lib/render/types';
import type { ModelViewport } from '../src/lib/modelPreview';
import { createRendererDeps } from './helpers/rendererDeps';
import { asSourceImage, domStubs, FakeCanvas, flushRaf, installDomStubs, rafCount } from './helpers/domStubs';

beforeAll(() => {
  installDomStubs();
});

afterEach(() => {
  installDomStubs();
});

function triMesh(uv: [number, number][], position: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('uv', new Float32BufferAttribute(uv.flat(), 2));
  geometry.setAttribute('position', new Float32BufferAttribute(position.flat(), 3));
  return new Mesh(geometry, new MeshBasicMaterial());
}

function baseImage(width = 512, height = 512) {
  const canvas = new FakeCanvas();
  canvas.width = width;
  canvas.height = height;
  return asSourceImage(canvas);
}

function overlappingScene(): Scene {
  const scene = new Scene();
  scene.add(triMesh([[0, 0], [1, 0], [0, 1]]), triMesh([[0, 0], [1, 0], [0, 1]]));
  return scene;
}

function setup(overrides: Parameters<typeof createRendererDeps>[0] = {}) {
  const deps = createRendererDeps(overrides);
  const shared: RenderShared = {
    renderedCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
    originalBaseCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
    implicitLightmapCanvas: null,
    implicitLightmapTimer: 0,
    lightmapCleared: false,
  };
  const overlay = createOverlay(deps, shared);
  return { deps, shared, overlay };
}

/** Sizes the original pane's overlay, texture canvas box, and bitmap so
 * syncWireframeOverlay computes a real draw rect. */
function sizeOriginalPane(deps: ReturnType<typeof setup>['deps']): FakeCanvas {
  const overlayCanvas = deps.wireframeOverlays.original as unknown as FakeCanvas;
  overlayCanvas.clientWidth = 200;
  overlayCanvas.clientHeight = 100;
  deps.originalCanvas.offsetWidth = 200;
  deps.originalCanvas.offsetHeight = 100;
  deps.originalCanvas.width = 200;
  deps.originalCanvas.height = 100;
  return overlayCanvas;
}

describe('UV wireframe', () => {
  it('draws the triangles onto the display-resolution overlay when enabled', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const overlayCanvas = sizeOriginalPane(deps);
    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = true;

    overlay.refreshUVWireframe(); // collects triangles + syncs the overlay
    expect(overlayCanvas.hidden).toBe(false);
    const context = overlayCanvas.context;
    // One moveTo + two lineTo per triangle; two overlapping triangles total.
    expect(context.moveTo).toHaveBeenCalledTimes(2);
    expect(context.lineTo).toHaveBeenCalledTimes(4);
    expect(context.stroke).toHaveBeenCalledTimes(2);
    // Two opaque passes — a 2px #0a0c10 under-stroke then the 1px white
    // core — so no dither pattern bleeds through the lines. The final style
    // left on the context is the white core.
    expect(context.strokeStyle).toBe('#ffffff');
    expect(context.lineWidth).toBe(1);
  });

  it('maps UVs through the bitmap letterbox rect (object-fit: contain)', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const overlayCanvas = deps.wireframeOverlays.original as unknown as FakeCanvas;
    overlayCanvas.clientWidth = 200; // frame 200×100
    overlayCanvas.clientHeight = 100;
    deps.originalCanvas.offsetWidth = 100; // square canvas element box
    deps.originalCanvas.offsetHeight = 100;
    deps.originalCanvas.width = 100; // square bitmap
    deps.originalCanvas.height = 100;
    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = true;

    overlay.refreshUVWireframe();
    // Bitmap 100×100 contained in the 100×100 box, box centered in the
    // 200×100 frame → draw rect {50, 0, 100, 100}. Triangle uv (0,0) maps to
    // the rect's bottom-left (v is flipped).
    expect(overlayCanvas.context.moveTo).toHaveBeenNthCalledWith(1, 50, 100);
    expect(overlayCanvas.context.lineTo).toHaveBeenNthCalledWith(1, 150, 100);
    expect(overlayCanvas.context.lineTo).toHaveBeenNthCalledWith(2, 50, 0);
  });

  it('syncs both panes', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const originalOverlay = deps.wireframeOverlays.original as unknown as FakeCanvas;
    const processedOverlay = deps.wireframeOverlays.processed as unknown as FakeCanvas;
    for (const canvas of [originalOverlay, processedOverlay, deps.originalCanvas, deps.previewCanvas]) {
      canvas.clientWidth = 200;
      canvas.clientHeight = 100;
      canvas.offsetWidth = 200;
      canvas.offsetHeight = 100;
      canvas.width = 200;
      canvas.height = 100;
    }
    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = true;

    overlay.refreshUVWireframe();
    expect(originalOverlay.hidden).toBe(false);
    expect(processedOverlay.hidden).toBe(false);
    expect(processedOverlay.context.stroke).toHaveBeenCalledTimes(2);
  });

  it('drives each pane independently', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const originalOverlay = deps.wireframeOverlays.original as unknown as FakeCanvas;
    const processedOverlay = deps.wireframeOverlays.processed as unknown as FakeCanvas;
    for (const canvas of [originalOverlay, processedOverlay, deps.originalCanvas, deps.previewCanvas]) {
      canvas.clientWidth = 200;
      canvas.clientHeight = 100;
      canvas.offsetWidth = 200;
      canvas.offsetHeight = 100;
      canvas.width = 200;
      canvas.height = 100;
    }
    // Only the original pane's toggle is on — the processed overlay stays hidden.
    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = false;

    overlay.refreshUVWireframe();
    expect(originalOverlay.hidden).toBe(false);
    expect(processedOverlay.hidden).toBe(true);
  });

  it('hides the overlay when the toggle is off', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const overlayCanvas = sizeOriginalPane(deps);
    overlay.refreshUVWireframe(); // showUVWireframe stays false (fixture default)
    expect(overlayCanvas.hidden).toBe(true);
  });

  it('hides the overlay when the pane is in 3D mode', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const overlayCanvas = sizeOriginalPane(deps);
    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = true;
    deps.originalCanvas.hidden = true;
    overlay.refreshUVWireframe();
    expect(overlayCanvas.hidden).toBe(true);
  });

  it('hides the overlay without a scene', () => {
    const { deps, overlay } = setup();
    const overlayCanvas = sizeOriginalPane(deps);
    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = true;
    overlay.refreshUVWireframe();
    expect(overlayCanvas.hidden).toBe(true);
  });

  it('re-syncs on demand and when the frame resizes', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const overlayCanvas = sizeOriginalPane(deps);
    overlay.refreshUVWireframe();
    expect(overlayCanvas.hidden).toBe(true); // toggle off

    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = true;
    overlay.syncWireframeOverlays(); // main.ts calls this on the toggle
    expect(overlayCanvas.hidden).toBe(false);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(2);

    overlayCanvas.context.stroke.mockClear();
    overlayCanvas.clientWidth = 300; // frame grows
    overlayCanvas.clientHeight = 150;
    domStubs.resizeObservers[0].callback([], domStubs.resizeObservers[0] as unknown as ResizeObserver);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(2);
  });
});

describe('UV overlap overlay', () => {
  it('computes the overlap mask, notifies viewports, and animates', () => {
    const viewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      forEachViewport: (callback) => callback(viewport as unknown as ModelViewport),
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();

    overlay.refreshUVOverlap();
    // First pass clears every viewport, second pass hands out the overlap map.
    expect(viewport.setUVOverlap).toHaveBeenCalledTimes(2);
    expect(viewport.setUVOverlap.mock.calls[0][0]).toBeNull();
    const overlapping = viewport.setUVOverlap.mock.calls[1][0] as Map<number, number[]>;
    expect(overlapping.get(0)).toEqual([0]);
    expect(rafCount()).toBe(1);

    // One animation frame draws the wave + mask into the 2D panes.
    flushRaf(500);
    expect(deps.originalCanvas.context.drawn.length).toBeGreaterThan(0);
    expect(deps.previewCanvas.context.drawn.length).toBeGreaterThan(0);
    expect(rafCount()).toBe(1); // re-registered for the next frame
  });

  it('invalidateUVOverlap forces the next refresh to recompute', () => {
    const scene = overlappingScene(); // stable identity — the cache key
    const viewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => scene,
      forEachViewport: (callback) => callback(viewport as unknown as ModelViewport),
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();

    overlay.refreshUVOverlap();
    const calls = viewport.setUVOverlap.mock.calls.length;
    expect(calls).toBe(2); // null-clear + overlap map

    // Warm cache: a second refresh skips the recompute entirely.
    overlay.refreshUVOverlap();
    expect(viewport.setUVOverlap.mock.calls.length).toBe(calls);

    // Invalidation clears the cache, so the next refresh recomputes and
    // notifies the viewports again.
    overlay.invalidateUVOverlap();
    overlay.refreshUVOverlap();
    expect(viewport.setUVOverlap.mock.calls.length).toBe(calls + 2);

    // A pane resize mid-animation rebuilds the shared composite canvas at
    // the new size.
    deps.originalCanvas.width = 64;
    deps.originalCanvas.height = 64;
    flushRaf(600);
    expect(deps.originalCanvas.context.drawn.length).toBeGreaterThan(0);
  });

  it('skips the original pane when its preview mode is 3D', () => {
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      getOriginalPreviewMode: () => '3d',
      forEachViewport: (callback) => callback({ setUVOverlap: vi.fn() } as unknown as ModelViewport),
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();

    overlay.refreshUVOverlap();
    flushRaf(500);
    expect(deps.originalCanvas.context.drawn).toHaveLength(0);
    expect(deps.previewCanvas.context.drawn.length).toBeGreaterThan(0);
  });

  it('draws the animated overlap only on the pane whose toggle is on', () => {
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      forEachViewport: (callback) => callback({ setUVOverlap: vi.fn() } as unknown as ModelViewport),
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = false;
    deps.textures.base.image = baseImage();

    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(1); // animation runs for the original pane

    flushRaf(500);
    expect(deps.originalCanvas.context.drawn.length).toBeGreaterThan(0);
    expect(deps.previewCanvas.context.drawn).toHaveLength(0);
  });

  it('scales the overlap analysis down for very large base textures', () => {
    const viewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      forEachViewport: (callback) => callback(viewport as unknown as ModelViewport),
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage(2000, 1000);

    overlay.refreshUVOverlap();
    expect(viewport.setUVOverlap).toHaveBeenCalledTimes(2);
    expect(rafCount()).toBe(1);
  });

  it('does nothing when the overlap view is disabled', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    deps.textures.base.image = baseImage();
    const overlayCanvas = sizeOriginalPane(deps);
    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = true;
    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(0);
    // Wireframe triangles are still collected and drawn on the overlay even
    // though the overlap wave animation stays off.
    expect(overlayCanvas.hidden).toBe(false);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(2);
  });

  it('stops the animation when the scene disappears', () => {
    let scene: Scene | null = overlappingScene();
    const { deps, overlay } = setup({ getAOScene: () => scene });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();
    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(1);

    scene = null;
    flushRaf(500);
    expect(rafCount()).toBe(0);
  });

  it('stops drawing when the base canvas is missing', () => {
    const { deps, shared, overlay } = setup({
      getAOScene: () => overlappingScene(),
      forEachViewport: (callback) => callback({ setUVOverlap: vi.fn() } as unknown as ModelViewport),
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();
    shared.originalBaseCanvas = null;
    overlay.refreshUVOverlap();
    flushRaf(500);
    // The original pane could not be composited, but the processed pane still draws.
    expect(deps.previewCanvas.context.drawn.length).toBeGreaterThan(0);
  });

  it('reset cancels the animation and clears the wireframe state', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();
    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(1);

    overlay.reset();
    expect(rafCount()).toBe(0);
    expect(deps.wireframeOverlays.original.hidden).toBe(true);
    // A later frame no longer animates.
    flushRaf(500);
    expect(deps.previewCanvas.context.drawn).toHaveLength(0);
  });
});
