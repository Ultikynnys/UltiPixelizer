import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { createBake } from '../src/lib/render/bake';
import type { RenderShared } from '../src/lib/render/types';
import { createRendererDeps } from './helpers/rendererDeps';
import { asSourceImage, FakeCanvas, installDomStubs } from './helpers/domStubs';

const mocks = vi.hoisted(() => ({ bakeMeshAOAsync: vi.fn(), bakeMeshLightmap: vi.fn() }));
vi.mock('../src/lib/aoBake', () => ({ bakeMeshAOAsync: mocks.bakeMeshAOAsync }));
vi.mock('../src/lib/lightmapBake', () => ({ bakeMeshLightmap: mocks.bakeMeshLightmap }));

beforeAll(() => {
  installDomStubs();
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.bakeMeshAOAsync.mockReset();
  mocks.bakeMeshLightmap.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function base8() {
  const canvas = new FakeCanvas();
  canvas.width = 8;
  canvas.height = 8;
  return asSourceImage(canvas);
}

function setup(overrides: Parameters<typeof createRendererDeps>[0] = {}) {
  const deps = createRendererDeps(overrides);
  // Bake at 8×8 by default so base8 fixtures match their 8×8 mock buffers;
  // downscale-dimension tests override to 64 explicitly.
  deps.state.resolution = 8;
  const shared: RenderShared = {
    renderedCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
    originalBaseCanvas: null,
    implicitLightmapCanvas: null,
    implicitLightmapTimer: 0,
    lightmapCleared: false,
  };
  const render2d = { render: vi.fn() };
  const bake = createBake(deps, shared, render2d);
  return { deps, shared, render2d, bake };
}

describe('generateAo', () => {
  it('does nothing without a loaded scene', () => {
    const { render2d, bake } = setup();
    bake.generateAo();
    vi.advanceTimersByTime(1000);
    expect(mocks.bakeMeshAOAsync).not.toHaveBeenCalled();
    expect(render2d.render).not.toHaveBeenCalled();
  });

  it('bakes AO into the texture slot after the deferral', async () => {
    const scene = new Scene();
    mocks.bakeMeshAOAsync.mockResolvedValue(new Uint8ClampedArray(64).fill(200));
    const { deps, render2d, bake } = setup({ getAOScene: () => scene });
    deps.textures.base.image = base8();

    const promise = bake.generateAo();
    expect(mocks.bakeMeshAOAsync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30);
    await promise;
    expect(mocks.bakeMeshAOAsync).toHaveBeenCalledWith(scene, 8, 8, { samples: 128, distance: 2 }, expect.any(Function), expect.any(Object));
    expect(deps.textures.ao.image).not.toBeNull();
    expect(deps.textures.ao.name).toBe('Generated AO');
    expect(deps.renderTextureRibbon).toHaveBeenCalled();
    expect(render2d.render).toHaveBeenCalledOnce();
  });

  it('bakes AO at the dithered texture resolution', async () => {
    const scene = new Scene();
    mocks.bakeMeshAOAsync.mockResolvedValue(new Uint8ClampedArray(64 * 32).fill(255));
    const { deps, bake } = setup({ getAOScene: () => scene });
    const large = new FakeCanvas();
    large.width = 512;
    large.height = 256;
    deps.state.resolution = 64;
    deps.textures.base.image = asSourceImage(large);

    const promise = bake.generateAo();
    vi.advanceTimersByTime(30);
    await promise;

    // 512 × 256 dithers to 64 × 32 (pixelization width 64, aspect preserved)
    // and the AO bake matches that exactly.
    expect(mocks.bakeMeshAOAsync).toHaveBeenCalledWith(scene, 64, 32, { samples: 128, distance: 2 }, expect.any(Function), expect.any(Object));
  });

  it('bakes AO at the dithered width for portrait textures', async () => {
    const scene = new Scene();
    mocks.bakeMeshAOAsync.mockResolvedValue(new Uint8ClampedArray(64 * 128).fill(255));
    const { deps, bake } = setup({ getAOScene: () => scene });
    const portrait = new FakeCanvas();
    portrait.width = 256;
    portrait.height = 512;
    deps.state.resolution = 64;
    deps.textures.base.image = asSourceImage(portrait);

    const promise = bake.generateAo();
    vi.advanceTimersByTime(30);
    await promise;

    // 256 × 512 dithers to 64 × 128 — the width is capped, not the longest
    // side, so the bake stays identical to the dithered texture.
    expect(mocks.bakeMeshAOAsync).toHaveBeenCalledWith(scene, 64, 128, { samples: 128, distance: 2 }, expect.any(Function), expect.any(Object));
  });

  it('reports bake failures to the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.bakeMeshAOAsync.mockRejectedValue(new Error('gpu exploded'));
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();

    const promise = bake.generateAo();
    vi.advanceTimersByTime(30);
    await promise;
    expect(consoleError).toHaveBeenCalledWith('Could not generate ambient occlusion.', expect.any(Error));
  });
});

describe('bakeLighting', () => {
  it('does nothing without a loaded scene', () => {
    const { bake } = setup();
    bake.bakeLighting();
    vi.advanceTimersByTime(1000);
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });

  it('does nothing when the base texture is missing', async () => {
    const { bake } = setup({ getAOScene: () => new Scene() });
    const promise = bake.bakeLighting();
    vi.advanceTimersByTime(30);
    await promise;
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });

  it('stores the baked lightmap and re-renders every dependent control', async () => {
    const scene = new Scene();
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4).fill(255));
    const { deps, render2d, bake } = setup({ getAOScene: () => scene });
    deps.textures.base.image = base8();

    const promise = bake.bakeLighting();
    vi.advanceTimersByTime(30);
    await promise;

    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
    expect(deps.textures.lightmap.image).not.toBeNull();
    expect(deps.textures.lightmap.name).toBe('Baked lighting');
    expect(deps.renderLightmapControls).toHaveBeenCalled();
    expect(deps.renderNormalControls).toHaveBeenCalled();
    expect(deps.renderTextureRibbon).toHaveBeenCalled();
    expect(deps.applySun).toHaveBeenCalled();
    expect(render2d.render).toHaveBeenCalledOnce();
  });

  it('re-engages the implicit preview after a suppressed clear', async () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, shared, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    shared.lightmapCleared = true;

    const promise = bake.bakeLighting();
    vi.advanceTimersByTime(30);
    await promise;

    expect(shared.lightmapCleared).toBe(false);
  });

  it('reads an uploaded normal map when one is present', async () => {
    const normalCanvas = new FakeCanvas();
    normalCanvas.width = 1;
    normalCanvas.height = 1;
    normalCanvas.context.pixels.set([128, 128, 255, 255]);
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    deps.textures.normal.image = asSourceImage(normalCanvas);

    const promise = bake.bakeLighting();
    vi.advanceTimersByTime(30);
    await promise;

    const [scene, width, height, options] = mocks.bakeMeshLightmap.mock.calls[0];
    expect(scene).toBeInstanceOf(Scene);
    expect(width).toBe(8);
    expect(height).toBe(8);
    expect(options.normalMap.data).toEqual(new Uint8ClampedArray([128, 128, 255, 255]));
  });

  it('bakes the lightmap at the dithered texture resolution', async () => {
    const scene = new Scene();
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(64 * 32 * 4));
    const { deps, bake } = setup({ getAOScene: () => scene });
    const large = new FakeCanvas();
    large.width = 512;
    large.height = 256;
    deps.state.resolution = 64;
    deps.textures.base.image = asSourceImage(large);

    const promise = bake.bakeLighting();
    vi.advanceTimersByTime(30);
    await promise;

    // 512 × 256 dithers to 64 × 32 (pixelization width 64, aspect preserved)
    // and the lightmap bake matches that exactly.
    expect(mocks.bakeMeshLightmap).toHaveBeenCalledWith(scene, 64, 32, expect.anything(), expect.any(Object));
  });

  it('reports bake failures to the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.bakeMeshLightmap.mockImplementation(() => {
      throw new Error('no memory');
    });
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();

    const promise = bake.bakeLighting();
    vi.advanceTimersByTime(30);
    await promise;
    expect(consoleError).toHaveBeenCalledWith('Could not bake lighting.', expect.any(Error));
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

  it('drops the implicit lightmap and cancels a pending re-bake', () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, shared, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    bake.scheduleImplicitLightmapBake();
    shared.implicitLightmapCanvas = new FakeCanvas() as unknown as HTMLCanvasElement;

    bake.clearLightmap();

    expect(shared.implicitLightmapCanvas).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });

  it('suppressing the clear keeps the render unlit until an explicit bake', () => {
    const { deps, render2d, shared, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();

    bake.clearLightmap(true);

    expect(shared.lightmapCleared).toBe(true);
    // Sun/ambient changes after the clear must not resurrect the lightmap.
    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(1000);
    expect(shared.implicitLightmapCanvas).toBeNull();
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
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

  it('does not bake while the lightmap was explicitly cleared', () => {
    const { shared, bake } = setup({ getAOScene: () => new Scene() });
    shared.lightmapCleared = true;
    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(1000);
    expect(shared.implicitLightmapCanvas).toBeNull();
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });

  it('reengageImplicitLightmap resumes baking after a cleared slot', () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, shared, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    shared.lightmapCleared = true;

    bake.reengageImplicitLightmap();
    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(200);

    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
    expect(shared.implicitLightmapCanvas).not.toBeNull();
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
    // The ribbon slot previews the implicit lightmap, so it refreshes too.
    expect(deps.renderTextureRibbon).toHaveBeenCalledOnce();
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
    const { deps, render2d, shared, bake } = setup({ getAOScene: () => new Scene() });
    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(200);
    expect(shared.implicitLightmapCanvas).toBeNull();
    expect(render2d.render).not.toHaveBeenCalled();
    // The ribbon still refreshes so the slot preview drops the stale canvas.
    expect(deps.renderTextureRibbon).toHaveBeenCalledOnce();
  });

  it('scheduleNormalAdjustedLighting reuses the same debounce path', () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    bake.scheduleNormalAdjustedLighting();
    vi.advanceTimersByTime(200);
    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
  });

  it('reset cancels any pending bake and re-engages the preview', () => {
    const { shared, bake } = setup({ getAOScene: () => new Scene() });
    shared.lightmapCleared = true;
    bake.scheduleImplicitLightmapBake();
    bake.reset();
    vi.advanceTimersByTime(1000);
    expect(shared.implicitLightmapCanvas).toBeNull();
    expect(shared.lightmapCleared).toBe(false);
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
  });
});
