import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene } from 'three';
import { createOverlay } from '../src/lib/render/overlay';
import type { RenderShared } from '../src/lib/render/types';
import type { ModelViewport } from '../src/lib/modelPreview';
import { createRendererDeps } from './helpers/rendererDeps';
import { asSourceImage, FakeCanvas, flushRaf, installDomStubs, rafCount } from './helpers/domStubs';

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

describe('UV wireframe', () => {
  it('collects triangles from the scene and draws them onto a context', () => {
    const { overlay } = setup({ getAOScene: () => overlappingScene() });
    overlay.refreshUVWireframe();
    expect(overlay.hasWireframe()).toBe(true);

    const context = new FakeCanvas().context as unknown as CanvasRenderingContext2D;
    overlay.drawWireframe(context, 10, 10);
    expect(context.beginPath).toHaveBeenCalled();
    // One moveTo + two lineTo per triangle; two overlapping triangles total.
    expect(context.moveTo).toHaveBeenCalledTimes(2);
    expect(context.lineTo).toHaveBeenCalledTimes(4);
    expect(context.stroke).toHaveBeenCalledTimes(2);
  });

  it('reports no wireframe without a scene and draws nothing', () => {
    const { overlay } = setup();
    overlay.refreshUVWireframe();
    expect(overlay.hasWireframe()).toBe(false);
    const context = new FakeCanvas().context as unknown as CanvasRenderingContext2D;
    overlay.drawWireframe(context, 10, 10);
    expect(context.stroke).not.toHaveBeenCalled();
  });
});

describe('UV overlap overlay', () => {
  it('computes the overlap mask, notifies viewports, and animates', () => {
    const viewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      forEachViewport: (callback) => callback(viewport as unknown as ModelViewport),
    });
    deps.state.showUVOverlap = true;
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

  it('skips the original pane when its preview mode is 3D', () => {
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      getOriginalPreviewMode: () => '3d',
      forEachViewport: (callback) => callback({ setUVOverlap: vi.fn() } as unknown as ModelViewport),
    });
    deps.state.showUVOverlap = true;
    deps.textures.base.image = baseImage();

    overlay.refreshUVOverlap();
    flushRaf(500);
    expect(deps.originalCanvas.context.drawn).toHaveLength(0);
    expect(deps.previewCanvas.context.drawn.length).toBeGreaterThan(0);
  });

  it('scales the overlap analysis down for very large base textures', () => {
    const viewport = { setUVOverlap: vi.fn() };
    const { deps, overlay } = setup({
      getAOScene: () => overlappingScene(),
      forEachViewport: (callback) => callback(viewport as unknown as ModelViewport),
    });
    deps.state.showUVOverlap = true;
    deps.textures.base.image = baseImage(2000, 1000);

    overlay.refreshUVOverlap();
    expect(viewport.setUVOverlap).toHaveBeenCalledTimes(2);
    expect(rafCount()).toBe(1);
  });

  it('does nothing when the overlap view is disabled', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    deps.textures.base.image = baseImage();
    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(0);
    expect(overlay.hasWireframe()).toBe(true); // wireframe still collected
  });

  it('stops the animation when the scene disappears', () => {
    let scene: Scene | null = overlappingScene();
    const { deps, overlay } = setup({ getAOScene: () => scene });
    deps.state.showUVOverlap = true;
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
    deps.state.showUVOverlap = true;
    deps.textures.base.image = baseImage();
    shared.originalBaseCanvas = null;
    overlay.refreshUVOverlap();
    flushRaf(500);
    // The original pane could not be composited, but the processed pane still draws.
    expect(deps.previewCanvas.context.drawn.length).toBeGreaterThan(0);
  });

  it('reset cancels the animation and clears the wireframe state', () => {
    const { deps, overlay } = setup({ getAOScene: () => overlappingScene() });
    deps.state.showUVOverlap = true;
    deps.textures.base.image = baseImage();
    overlay.refreshUVOverlap();
    expect(rafCount()).toBe(1);

    overlay.reset();
    expect(rafCount()).toBe(0);
    expect(overlay.hasWireframe()).toBe(false);
    // A later frame no longer animates.
    flushRaf(500);
    expect(deps.previewCanvas.context.drawn).toHaveLength(0);
  });
});
