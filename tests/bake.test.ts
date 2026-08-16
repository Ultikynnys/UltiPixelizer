import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { createBake } from '../src/lib/render/bake';
import type { RenderShared } from '../src/lib/render/types';
import { createRendererDeps } from './helpers/rendererDeps';
import { asSourceImage, FakeCanvas, installDomStubs } from './helpers/domStubs';

const mocks = vi.hoisted(() => ({ bakeMeshAO: vi.fn(), bakeMeshLightmap: vi.fn() }));
vi.mock('../src/lib/aoBake', () => ({ bakeMeshAO: mocks.bakeMeshAO }));
vi.mock('../src/lib/lightmapBake', () => ({ bakeMeshLightmap: mocks.bakeMeshLightmap }));

beforeAll(() => {
  installDomStubs();
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.bakeMeshAO.mockReset();
  mocks.bakeMeshLightmap.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function base8() {
  const canvas = new FakeCanvas();
  canvas.width = 8;
  canvas.height = 8;
  return asSourceImage(canvas);
}

function setup(overrides: Parameters<typeof createRendererDeps>[0] = {}) {
  const deps = createRendererDeps(overrides);
  const shared: RenderShared = {
    renderedCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
    originalBaseCanvas: null,
    implicitLightmapCanvas: null,
    implicitLightmapTimer: 0,
  };
  const render2d = { render: vi.fn() };
  const bake = createBake(deps, shared, render2d);
  return { deps, shared, render2d, bake };
}

describe('generateAo', () => {
  it('toasts and does nothing without a loaded scene', () => {
    const { deps, render2d, bake } = setup();
    bake.generateAo();
    expect(deps.showToast).toHaveBeenCalledWith('Load a model to generate AO');
    vi.advanceTimersByTime(1000);
    expect(mocks.bakeMeshAO).not.toHaveBeenCalled();
    expect(render2d.render).not.toHaveBeenCalled();
  });

  it('bakes AO into the texture slot after the deferral', () => {
    const scene = new Scene();
    mocks.bakeMeshAO.mockReturnValue(new Uint8ClampedArray(64).fill(200));
    const { deps, render2d, bake } = setup({ getAOScene: () => scene });
    deps.textures.base.image = base8();

    bake.generateAo();
    expect(deps.showToast).toHaveBeenCalledWith('Generating AO…');
    expect(mocks.bakeMeshAO).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30);
    expect(mocks.bakeMeshAO).toHaveBeenCalledWith(scene, 8, 8, { samples: 128, distance: 2 });
    expect(deps.textures.ao.image).not.toBeNull();
    expect(deps.textures.ao.name).toBe('Generated AO');
    expect(deps.renderTextureRibbon).toHaveBeenCalled();
    expect(render2d.render).toHaveBeenCalledOnce();
    expect(deps.showToast).toHaveBeenLastCalledWith('Ambient occlusion generated');
  });

  it('bakes AO at a low resolution independent of the source size', () => {
    const scene = new Scene();
    mocks.bakeMeshAO.mockReturnValue(new Uint8ClampedArray(64 * 32).fill(255));
    const { deps, bake } = setup({ getAOScene: () => scene });
    const large = new FakeCanvas();
    large.width = 512;
    large.height = 256;
    deps.textures.base.image = asSourceImage(large);

    bake.generateAo();
    vi.advanceTimersByTime(30);

    expect(mocks.bakeMeshAO).toHaveBeenCalledWith(scene, 64, 32, { samples: 128, distance: 2 });
  });

  it('reports bake failures through the toast', () => {
    mocks.bakeMeshAO.mockImplementation(() => {
      throw new Error('gpu exploded');
    });
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();

    bake.generateAo();
    vi.advanceTimersByTime(30);
    expect(deps.showToast).toHaveBeenLastCalledWith('gpu exploded');
  });
});

describe('bakeLighting', () => {
  it('toasts without a loaded scene', () => {
    const { deps, bake } = setup();
    bake.bakeLighting();
    expect(deps.showToast).toHaveBeenCalledWith('Load a model to bake lighting');
    vi.advanceTimersByTime(1000);
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });

  it('toasts when the base texture is missing', () => {
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    bake.bakeLighting();
    expect(deps.showToast).toHaveBeenCalledWith('Baking lighting…');
    vi.advanceTimersByTime(30);
    expect(deps.showToast).toHaveBeenLastCalledWith('Load a base texture to bake lighting');
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });

  it('stores the baked lightmap and re-renders every dependent control', () => {
    const scene = new Scene();
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4).fill(255));
    const { deps, render2d, bake } = setup({ getAOScene: () => scene });
    deps.textures.base.image = base8();

    bake.bakeLighting();
    vi.advanceTimersByTime(30);

    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
    expect(deps.textures.lightmap.image).not.toBeNull();
    expect(deps.textures.lightmap.name).toBe('Baked lighting');
    expect(deps.renderLightmapControls).toHaveBeenCalled();
    expect(deps.renderNormalControls).toHaveBeenCalled();
    expect(deps.renderTextureRibbon).toHaveBeenCalled();
    expect(deps.applySun).toHaveBeenCalled();
    expect(render2d.render).toHaveBeenCalledOnce();
    expect(deps.showToast).toHaveBeenLastCalledWith('Lighting baked');
  });

  it('reads an uploaded normal map when one is present', () => {
    const normalCanvas = new FakeCanvas();
    normalCanvas.width = 1;
    normalCanvas.height = 1;
    normalCanvas.context.pixels.set([128, 128, 255, 255]);
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    deps.textures.normal.image = asSourceImage(normalCanvas);

    bake.bakeLighting();
    vi.advanceTimersByTime(30);

    const [scene, width, height, options] = mocks.bakeMeshLightmap.mock.calls[0];
    expect(scene).toBeInstanceOf(Scene);
    expect(width).toBe(8);
    expect(height).toBe(8);
    expect(options.normalMap.data).toEqual(new Uint8ClampedArray([128, 128, 255, 255]));
  });

  it('bakes the lightmap at a low resolution independent of the source size', () => {
    const scene = new Scene();
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(64 * 32 * 4));
    const { deps, bake } = setup({ getAOScene: () => scene });
    const large = new FakeCanvas();
    large.width = 512;
    large.height = 256;
    deps.textures.base.image = asSourceImage(large);

    bake.bakeLighting();
    vi.advanceTimersByTime(30);

    // 512 × 256 caps to the default bake resolution of 64 on the longest side,
    // preserving aspect ratio (64 × 32).
    expect(mocks.bakeMeshLightmap).toHaveBeenCalledWith(scene, 64, 32, expect.anything());
  });

  it('reports bake failures through the toast', () => {
    mocks.bakeMeshLightmap.mockImplementation(() => {
      throw new Error('no memory');
    });
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();

    bake.bakeLighting();
    vi.advanceTimersByTime(30);
    expect(deps.showToast).toHaveBeenLastCalledWith('no memory');
  });
});

describe('clearLightmap', () => {
  it('drops the lightmap and refreshes the pipeline', () => {
    const { deps, render2d, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.lightmap.image = asSourceImage(new FakeCanvas());
    deps.textures.lightmap.name = 'Baked lighting';

    bake.clearLightmap();

    expect(deps.textures.lightmap.image).toBeNull();
    expect(deps.textures.lightmap.name).toBe('');
    expect(deps.renderLightmapControls).toHaveBeenCalled();
    expect(deps.applySun).toHaveBeenCalled();
    expect(render2d.render).toHaveBeenCalledOnce();
  });
});

describe('implicit lightmap scheduling', () => {
  it('does nothing without a scene or with a lightmap already set', () => {
    const { shared, bake } = setup();
    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(1000);
    expect(shared.implicitLightmapCanvas).toBeNull();
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();

    const { bake: withLightmap, deps } = setup({ getAOScene: () => new Scene() });
    deps.textures.lightmap.image = asSourceImage(new FakeCanvas());
    withLightmap.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(1000);
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });

  it('bakes the implicit lightmap after the debounce and renders', () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, render2d, shared, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();

    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(199);
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
    expect(shared.implicitLightmapCanvas).not.toBeNull();
    expect(render2d.render).toHaveBeenCalledOnce();
  });

  it('coalesces rapid requests into a single bake', () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();

    bake.scheduleImplicitLightmapBake();
    bake.scheduleImplicitLightmapBake();
    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(200);
    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
  });

  it('drops the implicit canvas when the bake fails', () => {
    mocks.bakeMeshLightmap.mockImplementation(() => {
      throw new Error('bake failed');
    });
    const { render2d, shared, bake } = setup({ getAOScene: () => new Scene() });
    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(200);
    expect(shared.implicitLightmapCanvas).toBeNull();
    expect(render2d.render).not.toHaveBeenCalled();
  });

  it('scheduleNormalAdjustedLighting reuses the same debounce path', () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    bake.scheduleNormalAdjustedLighting();
    vi.advanceTimersByTime(200);
    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
  });

  it('reset cancels any pending bake', () => {
    const { shared, bake } = setup({ getAOScene: () => new Scene() });
    bake.scheduleImplicitLightmapBake();
    bake.reset();
    vi.advanceTimersByTime(1000);
    expect(shared.implicitLightmapCanvas).toBeNull();
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });
});
