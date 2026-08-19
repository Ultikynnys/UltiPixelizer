import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { createBake } from '../src/lib/render/bake';
import { createFallbackQuadScene } from '../src/lib/modelScene';
import { createRendererDeps, createRenderShared } from './helpers/rendererDeps';
import { expectFallbackQuad } from './helpers/bakeFixtures';
import { asSourceImage, FakeCanvas, installDomStubs } from './helpers/domStubs';

const mocks = vi.hoisted(() => ({ bakeMeshAOAsync: vi.fn(), bakeMeshLightmap: vi.fn() }));
vi.mock('../src/lib/aoBake', () => ({
  bakeMeshAOAsync: mocks.bakeMeshAOAsync,
  logAOBakeStage: () => {},
}));
vi.mock('../src/lib/lightmapBake', () => ({
  bakeMeshLightmap: mocks.bakeMeshLightmap,
  // bake.ts routes both the explicit and implicit bakes through the async
  // wrapper — point it at the same spy so call-count assertions hold.
  bakeLightmapAsync: mocks.bakeMeshLightmap,
}));

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
  const shared = createRenderShared();
  const render2d = { render: vi.fn(), applyViewportImages: vi.fn() };
  const bake = createBake(deps, shared, render2d);
  return { deps, shared, render2d, bake };
}

describe('setFallbackQuad', () => {
  it('replaces the bake geometry when no model is loaded', async () => {
    mocks.bakeMeshAOAsync.mockResolvedValue(new Uint8ClampedArray(64).fill(200));
    const { deps, bake } = setup();
    deps.textures.base.image = base8();
    const custom = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    try {
      bake.setFallbackQuad(custom);

      const promise = bake.generateAo();
      vi.advanceTimersByTime(30);
      await promise;

      expect(mocks.bakeMeshAOAsync.mock.calls[0][0]).toBe(custom);
    } finally {
      // The fallback is a module-level singleton shared across bakes — restore
      // the default quad so later tests see the pristine fallback.
      bake.setFallbackQuad(createFallbackQuadScene());
    }
  });

  it('bakes AO against the full 3×3 grid so the neighbors occlude the middle tile', async () => {
    mocks.bakeMeshAOAsync.mockResolvedValue(new Uint8ClampedArray(64).fill(200));
    const { deps, bake } = setup();
    deps.textures.base.image = base8();
    const grid = createFallbackQuadScene(2, true);
    try {
      bake.setFallbackQuad(grid);

      const promise = bake.generateAo();
      vi.advanceTimersByTime(30);
      await promise;

      // The AO bake receives the whole grid — collectBakeScene marks the
      // neighbors occluder-only, so they occlude the middle tile's hemisphere
      // rays without ever rasterizing over its texture.
      expect(mocks.bakeMeshAOAsync.mock.calls[0][0]).toBe(grid);
      expect((mocks.bakeMeshAOAsync.mock.calls[0][0] as Object3D).children).toHaveLength(9);
    } finally {
      bake.setFallbackQuad(createFallbackQuadScene());
    }
  });
});

describe('generateAo', () => {
  it('bakes onto the fallback quad when no model is loaded', async () => {
    mocks.bakeMeshAOAsync.mockResolvedValue(new Uint8ClampedArray(64).fill(200));
    const { deps, render2d, bake } = setup();
    deps.textures.base.image = base8();

    const promise = bake.generateAo();
    vi.advanceTimersByTime(30);
    await promise;

    expect(mocks.bakeMeshAOAsync).toHaveBeenCalledOnce();
    expect(mocks.bakeMeshAOAsync.mock.calls[0][0]).toBeInstanceOf(Mesh);
    expect(deps.textures.ao.image).not.toBeNull();
    expect(deps.textures.ao.name).toBe('Generated AO');
    expect(render2d.render).toHaveBeenCalledOnce();
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
    expect(mocks.bakeMeshAOAsync).toHaveBeenCalledWith(scene, 8, 8, { samples: 64, distance: 2, normalStrength: 1, normalFlipY: false }, undefined, expect.any(Object));
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
    expect(mocks.bakeMeshAOAsync).toHaveBeenCalledWith(scene, 64, 32, { samples: 64, distance: 2, normalStrength: 1, normalFlipY: false }, undefined, expect.any(Object));
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
    expect(mocks.bakeMeshAOAsync).toHaveBeenCalledWith(scene, 64, 128, { samples: 64, distance: 2, normalStrength: 1, normalFlipY: false }, undefined, expect.any(Object));
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
  it('bakes onto the fallback quad when no model is loaded', async () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4).fill(255));
    const { deps, bake } = setup();
    deps.textures.base.image = base8();

    const promise = bake.bakeLighting();
    vi.advanceTimersByTime(30);
    await promise;

    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
    expect(mocks.bakeMeshLightmap.mock.calls[0][0]).toBeInstanceOf(Mesh);
    expect(deps.textures.lightmap.image).not.toBeNull();
    expect(deps.textures.lightmap.name).toBe('Baked lighting');
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
    // The bake consumes the processed normal map: the 1×1 source resampled to
    // the 8×8 output resolution (pixelation 1 = no block filter).
    expect(options.normalMap.width).toBe(8);
    expect(options.normalMap.height).toBe(8);
    expect(Array.from(options.normalMap.data)).toEqual(new Array(8 * 8).fill([128, 128, 255, 255]).flat());
  });

  it('feeds the pixelized normal map to both bakes at the output resolution', async () => {
    const normalCanvas = new FakeCanvas();
    normalCanvas.width = 2;
    normalCanvas.height = 2;
    normalCanvas.context.pixels.set([
      10, 10, 10, 255, 20, 20, 20, 255,
      30, 30, 30, 255, 40, 40, 40, 255,
    ]);
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    mocks.bakeMeshAOAsync.mockResolvedValue(new Uint8ClampedArray(64).fill(200));
    const { deps, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    deps.textures.normal.image = asSourceImage(normalCanvas);
    deps.state.pixelation = 50; // downscale/upscale: 8×8 → 4×4 → 8×8 chunky blocks

    const lightmapPromise = bake.bakeLighting();
    vi.advanceTimersByTime(30);
    await lightmapPromise;
    const [, , , lightmapOptions] = mocks.bakeMeshLightmap.mock.calls[0];
    // 2×2 source → 8×8 output, pixelized into chunky blocks (top-left 10, bottom-right 40).
    expect(lightmapOptions.normalMap.width).toBe(8);
    expect(lightmapOptions.normalMap.height).toBe(8);
    expect(lightmapOptions.normalMap.data[0]).toBe(10);
    expect(lightmapOptions.normalMap.data[(4 * 8 + 4) * 4]).toBe(40);

    const aoPromise = bake.generateAo();
    vi.advanceTimersByTime(30);
    await aoPromise;
    const [, , , aoOptions] = mocks.bakeMeshAOAsync.mock.calls[0];
    // The AO bake gets the same processed map, driving the hemisphere normals.
    expect(aoOptions.normalMap.width).toBe(8);
    expect(aoOptions.normalMap.data[0]).toBe(10);
    expect(aoOptions.normalMap.data[(4 * 8 + 4) * 4]).toBe(40);
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
  it('bakes onto the fallback quad without a scene; skips when a lightmap is set', async () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, shared, bake } = setup();
    deps.textures.base.image = base8();

    bake.scheduleImplicitLightmapBake();
    // The bake now resolves through the async wrapper — advanceTimersByTimeAsync
    // flushes the microtask that lands the canvas.
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
    expect(shared.implicitLightmapCanvas).not.toBeNull();

    mocks.bakeMeshLightmap.mockClear();
    const { bake: withLightmap, deps: lightmapDeps } = setup({ getAOScene: () => new Scene() });
    lightmapDeps.textures.lightmap.image = asSourceImage(new FakeCanvas());
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

  it('reengageImplicitLightmap resumes baking after a cleared slot', async () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, shared, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();
    shared.lightmapCleared = true;

    bake.reengageImplicitLightmap();
    bake.scheduleImplicitLightmapBake();
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.bakeMeshLightmap).toHaveBeenCalledOnce();
    expect(shared.implicitLightmapCanvas).not.toBeNull();
  });

  it('bakes the implicit lightmap after the debounce and renders', async () => {
    mocks.bakeMeshLightmap.mockReturnValue(new Uint8ClampedArray(8 * 8 * 4));
    const { deps, render2d, shared, bake } = setup({ getAOScene: () => new Scene() });
    deps.textures.base.image = base8();

    bake.scheduleImplicitLightmapBake();
    vi.advanceTimersByTime(199);
    expect(mocks.bakeMeshLightmap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
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

describe('fallback bake scene', () => {
  it('is a flat quad facing up with full-UV coverage when no model is loaded', async () => {
    mocks.bakeMeshAOAsync.mockResolvedValue(new Uint8ClampedArray(64));
    const { deps, bake } = setup();
    deps.textures.base.image = base8();

    const promise = bake.generateAo();
    vi.advanceTimersByTime(30);
    await promise;

    const scene = mocks.bakeMeshAOAsync.mock.calls[0][0] as Mesh;
    // The fallback quad's contract (flat +Y normal, full 0..1 UV span) is
    // asserted once in the factory test — this test only checks the wiring.
    expectFallbackQuad(scene);
  });
});
