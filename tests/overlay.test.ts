import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene } from 'three';
import { createOverlay } from '../src/lib/render/overlay';
import type { ModelViewport } from '../src/lib/modelPreview';
import { createRendererDeps, createRenderShared } from './helpers/rendererDeps';
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
  const shared = createRenderShared({ originalBaseCanvas: new FakeCanvas() as unknown as HTMLCanvasElement });
  const overlay = createOverlay(deps, shared);
  return { deps, shared, overlay };
}

function sizeOriginalPane(deps: ReturnType<typeof setup>['deps']): FakeCanvas {
  const overlayCanvas = deps.wireframeOverlays.original;
  overlayCanvas.clientWidth = 200;
  overlayCanvas.clientHeight = 100;
  deps.originalCanvas.offsetWidth = 200;
  deps.originalCanvas.offsetHeight = 100;
  deps.originalCanvas.width = 200;
  deps.originalCanvas.height = 100;
  return overlayCanvas;
}

describe('UV wireframe', () => {
  it('rasterizes edges in the same texture-pixel coordinates as UV overlap', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const overlayCanvas = sizeOriginalPane(deps);
    deps.state.showUVWireframeOriginal = true;

    overlay.refreshUVWireframe();
    expect(overlayCanvas.hidden).toBe(false);
    expect(overlayCanvas.width).toBe(200);
    expect(overlayCanvas.height).toBe(100);
    expect(overlayCanvas.context.moveTo).toHaveBeenNthCalledWith(1, 0, 100);
    expect(overlayCanvas.context.lineTo).toHaveBeenNthCalledWith(1, 200, 100);
    expect(overlayCanvas.context.lineTo).toHaveBeenNthCalledWith(2, 0, 0);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(2);
    expect(overlayCanvas.context.strokeStyle).toBe('#ffffff');
    expect(overlayCanvas.context.lineWidth).toBe(1);
  });

  it('uses the bitmap aspect ratio instead of a separately measured layout rect', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const overlayCanvas = deps.wireframeOverlays.original;
    overlayCanvas.clientWidth = 300;
    overlayCanvas.clientHeight = 180;
    deps.originalCanvas.offsetLeft = 37;
    deps.originalCanvas.offsetTop = 21;
    deps.originalCanvas.offsetWidth = 100;
    deps.originalCanvas.offsetHeight = 100;
    deps.originalCanvas.width = 200;
    deps.originalCanvas.height = 100;
    deps.state.showUVWireframeOriginal = true;

    overlay.refreshUVWireframe();
    expect(overlayCanvas.width).toBe(200);
    expect(overlayCanvas.height).toBe(100);
    expect(overlayCanvas.context.moveTo).toHaveBeenCalledWith(0, 100);
  });

  it('syncs both panes', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const originalOverlay = deps.wireframeOverlays.original;
    const processedOverlay = deps.wireframeOverlays.processed;
    for (const canvas of [deps.originalCanvas, deps.previewCanvas]) {
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
    expect(originalOverlay.context.stroke).toHaveBeenCalledTimes(2);
    expect(processedOverlay.context.stroke).toHaveBeenCalledTimes(2);
  });

  it('drives each pane independently', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    const originalOverlay = deps.wireframeOverlays.original;
    const processedOverlay = deps.wireframeOverlays.processed;
    for (const canvas of [deps.originalCanvas, deps.previewCanvas]) {
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

    // Repeated syncs and layout-only frame resizes reuse the rasterized bitmap.
    overlay.syncWireframeOverlays();
    overlayCanvas.clientWidth = 300;
    overlayCanvas.clientHeight = 150;
    domStubs.resizeObservers[0].callback([], domStubs.resizeObservers[0] as unknown as ResizeObserver);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(2);

    // A texture bitmap resize invalidates the cache and redraws at that size.
    deps.originalCanvas.width = 300;
    deps.originalCanvas.height = 150;
    overlay.syncWireframeOverlays();
    expect(overlayCanvas.width).toBe(300);
    expect(overlayCanvas.height).toBe(150);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(4);
  });

  it('reuses one rasterized layer for a 48k-triangle mesh', () => {
    const triangleCount = 48_000;
    const mesh = triMesh([[0, 0], [1, 0], [0, 1]]);
    mesh.geometry.setIndex(Array.from({ length: triangleCount * 3 }, (_, index) => index % 3));
    const scene = new Scene();
    scene.add(mesh);
    const { deps, overlay } = setup({ getAOScene: () => scene });
    const overlayCanvas = sizeOriginalPane(deps);
    deps.state.showUVWireframeOriginal = true;

    overlay.refreshUVWireframe();
    expect(overlayCanvas.context.moveTo).toHaveBeenCalledTimes(triangleCount);
    expect(overlayCanvas.context.lineTo).toHaveBeenCalledTimes(triangleCount * 2);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(2);

    overlay.syncWireframeOverlays();
    overlay.syncWireframeOverlays();
    expect(overlayCanvas.context.moveTo).toHaveBeenCalledTimes(triangleCount);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(2);
  });
});

describe('UV overlap overlay', () => {
  it('computes the overlap mask, notifies viewports, and animates', () => {
    const originalViewport = { setUVOverlap: vi.fn() };
    const processedViewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();

    overlay.refreshUVOverlap();
    // Each pane's viewport receives the overlap map (both toggles on).
    expect(originalViewport.setUVOverlap).toHaveBeenCalledTimes(1);
    expect(processedViewport.setUVOverlap).toHaveBeenCalledTimes(1);
    const overlapping = originalViewport.setUVOverlap.mock.calls[0][0] as Map<number, number[]>;
    expect(overlapping.get(0)).toEqual([0]);
    expect(rafCount()).toBe(1);

    // One animation frame draws the wave + mask into the 2D panes.
    flushRaf(500);
    expect(deps.originalCanvas.context.drawn.length).toBeGreaterThan(0);
    expect(deps.previewCanvas.context.drawn.length).toBeGreaterThan(0);
    expect(rafCount()).toBe(1); // re-registered for the next frame
  });

  it('re-shows the overlay after a toggle-off/toggle-on cycle', () => {
    const scene = overlappingScene(); // stable identity — the cache key
    const originalViewport = { setUVOverlap: vi.fn() };
    const processedViewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => scene,
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();

    // First toggle-on: mask computed, animation running, viewports notified.
    overlay.refreshUVOverlap();
    flushRaf(500);
    const drawsAfterFirstCycle = deps.originalCanvas.context.drawn.length;
    expect(drawsAfterFirstCycle).toBeGreaterThan(0);
    expect(originalViewport.setUVOverlap).toHaveBeenCalledTimes(1); // overlap map

    // Toggle off: the mask is cleared, the animation stops, viewports cleared.
    deps.state.showUVOverlapOriginal = false;
    deps.state.showUVOverlapProcessed = false;
    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(0);
    expect(originalViewport.setUVOverlap.mock.calls[1][0]).toBeNull();

    // Toggle back on: the cleared mask must be recomputed (the warm cache is
    // stale once the mask canvas is gone) and the viewports re-notified —
    // otherwise the animation restarts against a null mask and draws nothing.
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    overlay.refreshUVOverlap();
    expect(originalViewport.setUVOverlap.mock.calls[2][0]).toBeInstanceOf(Map);
    expect(rafCount()).toBe(1);
    flushRaf(600);
    expect(rafCount()).toBe(1); // still animating
    expect(deps.originalCanvas.context.drawn.length).toBeGreaterThan(drawsAfterFirstCycle);
  });

  it('invalidateUVOverlap forces the next refresh to recompute', () => {
    const scene = overlappingScene(); // stable identity — the cache key
    const originalViewport = { setUVOverlap: vi.fn() };
    const processedViewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => scene,
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();

    overlay.refreshUVOverlap();
    const calls = originalViewport.setUVOverlap.mock.calls.length;
    expect(calls).toBe(1); // the overlap map, once per pane

    // Warm cache: the mask is still valid, but the per-pane toggles may have
    // changed, so the viewport highlights are re-applied (not recomputed).
    overlay.refreshUVOverlap();
    expect(originalViewport.setUVOverlap.mock.calls.length).toBe(calls + 1);

    // Invalidation clears the cache, so the next refresh recomputes and
    // notifies the viewports again.
    overlay.invalidateUVOverlap();
    overlay.refreshUVOverlap();
    expect(originalViewport.setUVOverlap.mock.calls.length).toBe(calls + 2);

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
      getOriginalViewport: () => ({ setUVOverlap: vi.fn() }) as unknown as ModelViewport,
      getProcessedViewport: () => ({ setUVOverlap: vi.fn() }) as unknown as ModelViewport,
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
    const originalViewport = { setUVOverlap: vi.fn() };
    const processedViewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = false;
    deps.textures.base.image = baseImage();

    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(1); // animation runs for the original pane

    flushRaf(500);
    expect(deps.originalCanvas.context.drawn.length).toBeGreaterThan(0);
    expect(deps.previewCanvas.context.drawn).toHaveLength(0);
    // The viewport highlight follows the same per-pane rule: only the pane
    // whose toggle is on gets the overlap map.
    expect(originalViewport.setUVOverlap.mock.calls[0][0]).toBeInstanceOf(Map);
    expect(processedViewport.setUVOverlap.mock.calls[0][0]).toBeNull();
  });

  it('applies the viewport highlight per pane, independent of the other window', () => {
    const scene = overlappingScene(); // stable identity — the cache key
    const originalViewport = { setUVOverlap: vi.fn() };
    const processedViewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => scene,
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage();

    // Both toggles on: both viewports get the map.
    overlay.refreshUVOverlap();
    expect(originalViewport.setUVOverlap.mock.calls[0][0]).toBeInstanceOf(Map);
    expect(processedViewport.setUVOverlap.mock.calls[0][0]).toBeInstanceOf(Map);

    // Toggle the processed pane off: only its viewport clears (the warm cache
    // re-applies the per-pane state); the original pane keeps its highlight
    // and the animation keeps running.
    deps.state.showUVOverlapProcessed = false;
    overlay.refreshUVOverlap();
    expect(originalViewport.setUVOverlap).toHaveBeenCalledTimes(2);
    expect(originalViewport.setUVOverlap.mock.calls[1][0]).toBeInstanceOf(Map);
    expect(processedViewport.setUVOverlap.mock.calls[1][0]).toBeNull();
    expect(rafCount()).toBe(1);

    // And the reverse: the original pane off, the processed pane back on.
    deps.state.showUVOverlapOriginal = false;
    deps.state.showUVOverlapProcessed = true;
    overlay.refreshUVOverlap();
    expect(originalViewport.setUVOverlap.mock.calls[2][0]).toBeNull();
    expect(processedViewport.setUVOverlap.mock.calls[2][0]).toBeInstanceOf(Map);
  });

  it('scales the overlap analysis down for very large base textures', () => {
    const originalViewport = { setUVOverlap: vi.fn() };
    const processedViewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.showUVOverlapOriginal = true;
    deps.state.showUVOverlapProcessed = true;
    deps.textures.base.image = baseImage(2000, 1000);

    overlay.refreshUVOverlap();
    expect(originalViewport.setUVOverlap).toHaveBeenCalledTimes(1);
    expect(processedViewport.setUVOverlap).toHaveBeenCalledTimes(1);
    expect(rafCount()).toBe(1);
  });

  it('does nothing when the overlap view is disabled', () => {
    const originalViewport = { setUVOverlap: vi.fn() };
    const processedViewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.textures.base.image = baseImage();
    const overlayCanvas = sizeOriginalPane(deps);
    deps.state.showUVWireframeOriginal = true;
    deps.state.showUVWireframeProcessed = true;
    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(0);
    // Both viewports are cleared — their toggles are off.
    expect(originalViewport.setUVOverlap.mock.calls[0][0]).toBeNull();
    expect(processedViewport.setUVOverlap.mock.calls[0][0]).toBeNull();
    // Wireframe triangles are still collected and drawn on the overlay even
    // though the overlap wave animation stays off.
    expect(overlayCanvas.hidden).toBe(false);
    expect(overlayCanvas.context.stroke).toHaveBeenCalledTimes(2);
  });

  it('stops the animation when the scene disappears', () => {
    let scene: Scene | null = overlappingScene();
    const { deps, overlay } = setup({
      getAOScene: () => scene,
      getOriginalViewport: () => ({ setUVOverlap: vi.fn() }) as unknown as ModelViewport,
      getProcessedViewport: () => ({ setUVOverlap: vi.fn() }) as unknown as ModelViewport,
    });
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
      getOriginalViewport: () => ({ setUVOverlap: vi.fn() }) as unknown as ModelViewport,
      getProcessedViewport: () => ({ setUVOverlap: vi.fn() }) as unknown as ModelViewport,
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
