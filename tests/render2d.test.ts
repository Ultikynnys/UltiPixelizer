import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene } from 'three';
import { createRender2D } from '../src/lib/render/render2d';
import type { RenderShared } from '../src/lib/render/types';
import type { ModelViewport } from '../src/lib/modelPreview';
import { createRendererDeps, createRenderShared } from './helpers/rendererDeps';
import { asSourceImage, FakeCanvas, installDomStubs, stubDocument } from './helpers/domStubs';

// The pixelization filter must downscale the source before the dither pass
// consumes it; spy on both stages to pin the call order.
vi.mock('../src/lib/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/canvas')>();
  return { ...actual, pixelateCanvas: vi.fn(actual.pixelateCanvas) };
});
vi.mock('../src/lib/dither', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/dither')>();
  return { ...actual, processImageData: vi.fn(actual.processImageData) };
});
// The async GPU dither is replaced by a spy that answers with the exact CPU
// bytes, so a stubbed navigator.gpu exercises render2d's async branch without
// touching real WebGPU. gpuDitherCovers stays real  it gates the branch.
vi.mock('../src/lib/gpuDither', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/gpuDither')>();
  return {
    ...actual,
    processImageDataAsync: vi.fn(async (source: ImageData, options: ProcessOptions) => processImageData(source, options)),
  };
});
import { pixelateCanvas } from '../src/lib/canvas';
import { processImageData, type ProcessOptions } from '../src/lib/dither';
import { processImageDataAsync } from '../src/lib/gpuDither';

beforeEach(() => {
  // Re-install per test: the afterEach teardown (vi.unstubAllGlobals) removes
  // the DOM stubs too, and each test wants a fresh document/canvas/ImageData.
  installDomStubs();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  return createRenderShared();
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
    createRender2D(deps, shared).render();

    // Every pixel quantizes to the nearest of black/white  all black.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
    // The original pane keeps the unquantized lit source.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255]);
    expect(shared.renderedCanvas).toBeDefined();
    // Histograms read each pane's final selected-view result: four distinct
    // original levels, versus one black level after dithering.
    for (const level of [10, 20, 30, 40]) {
      expect(deps.luminosityHistograms.original.context.fillRect).toHaveBeenCalledWith(level, 0, 1, 48);
    }
    expect(deps.luminosityHistograms.processed.context.fillRect).toHaveBeenCalledTimes(1);
    expect(deps.luminosityHistograms.processed.context.fillRect).toHaveBeenCalledWith(0, 0, 1, 48);
    expect(deps.updatePreviewBadge).toHaveBeenCalledWith(2, 2);
    // Single-tile display: neither canvas is marked repeat-tiled.
    expect(deps.previewCanvas.classList.contains('repeat-tiled')).toBe(false);
    expect(deps.originalCanvas.classList.contains('repeat-tiled')).toBe(false);
  });

  it('keeps hidden 3D-pane histograms fresh for the next 2D entry', () => {
    const deps = createRendererDeps({
      getOriginalPreviewMode: () => '3d',
      getProcessedPreviewMode: () => '2d',
      textures: { base: { image: baseTexture(), name: '' } },
    });
    createRender2D(deps, sharedState()).render();

    expect(deps.luminosityHistograms.original.context.fillRect).toHaveBeenCalled();
    expect(deps.luminosityHistograms.processed.context.fillRect).toHaveBeenCalled();
  });

  it('skips both histograms in the compact single-pane layout', () => {
    const deps = createRendererDeps({
      showLuminosityHistograms: () => false,
      textures: { base: { image: baseTexture(), name: '' } },
    });
    createRender2D(deps, sharedState()).render();

    expect(deps.luminosityHistograms.original.context.fillRect).not.toHaveBeenCalled();
    expect(deps.luminosityHistograms.processed.context.fillRect).not.toHaveBeenCalled();
  });

  it('applies pixelization to the source before the dither pass', () => {
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Pixelation (downscale/upscale) runs first, then the dither consumes the
    // pixelated image, not the other way around.
    expect(vi.mocked(pixelateCanvas)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(processImageData)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pixelateCanvas).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(processImageData).mock.invocationCallOrder[0]);
  });

  it('quantizes the source into pixel blocks at the full output resolution', () => {
    const canvas = new FakeCanvas();
    canvas.width = 4;
    canvas.height = 4;
    canvas.context.pixels.set([
      10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255,
      11, 11, 11, 255, 21, 21, 21, 255, 31, 31, 31, 255, 41, 41, 41, 255,
      12, 12, 12, 255, 22, 22, 22, 255, 32, 32, 32, 255, 42, 42, 42, 255,
      13, 13, 13, 255, 23, 23, 23, 255, 33, 33, 33, 255, 43, 43, 43, 255,
    ]);
    const deps = createRendererDeps({ textures: { base: { image: asSourceImage(canvas), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.mode = 'none'; // dither is pass-through; output shows the pixelation alone
    deps.state.resolution = 4;
    deps.state.pixelation = 50; // downscale to half, then upscale back = 2×2 blocks
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // The 4×4 output keeps its resolution, but reads from 2×2 blocks: each
    // block carries its top-left pixel.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual([
      10, 10, 10, 255, 10, 10, 10, 255, 30, 30, 30, 255, 30, 30, 30, 255,
      10, 10, 10, 255, 10, 10, 10, 255, 30, 30, 30, 255, 30, 30, 30, 255,
      12, 12, 12, 255, 12, 12, 12, 255, 32, 32, 32, 255, 32, 32, 32, 255,
      12, 12, 12, 255, 12, 12, 12, 255, 32, 32, 32, 255, 32, 32, 32, 255,
    ]);
  });

  it('tiles both 2D panes 3×3 when image repeat is enabled, leaving the export buffers single-tile', () => {
    const deps = createRendererDeps({
      repeatTextureOriginal: () => true,
      repeatTextureProcessed: () => true,
      textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } },
    });
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Original pane: the 2×2 source tiles into a 6×6 buffer  the top-left
    // quadrant and the far corner both carry the source's pixels.
    expect(deps.originalCanvas.width).toBe(6);
    expect(deps.originalCanvas.height).toBe(6);
    const sourcePixels = [10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255];
    const pixels = deps.originalCanvas.context.pixels;
    // Top-left 2×2 block = pixels (0,0),(1,0),(0,1),(1,1)  row stride is 6.
    const topLeft = [...pixels.slice(0, 8), ...pixels.slice(24, 32)];
    expect(Array.from(topLeft)).toEqual(sourcePixels);
    // Far-corner 2×2 block = pixels (4,4),(5,4),(4,5),(5,5).
    const corner = [...pixels.slice(112, 120), ...pixels.slice(136, 144)];
    expect(Array.from(corner)).toEqual(sourcePixels);

    // Processed pane: the dithered 2×2 (all black) tiles into a 6×6 buffer.
    expect(deps.previewCanvas.width).toBe(6);
    expect(deps.previewCanvas.height).toBe(6);
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(Array.from({ length: 36 }, () => [0, 0, 0, 255]).flat());

    // The single-tile buffers behind the display canvases stay untouched, so
    // exports (getRenderedCanvas) and viewport textures keep the 1× image.
    expect(shared.renderedCanvas.width).not.toBe(6);
    expect(shared.originalBaseCanvas?.width).not.toBe(6);

    // Both display canvases are marked repeat-tiled  the signal preview2d
    // reads to display the 3× buffer at 3× scale (each tile keeps the
    // single-tile size; the grid overflows the frame until scrolled out).
    expect(deps.previewCanvas.classList.contains('repeat-tiled')).toBe(true);
    expect(deps.originalCanvas.classList.contains('repeat-tiled')).toBe(true);
  });

  it('tiles each pane independently', () => {
    const deps = createRendererDeps({
      repeatTextureOriginal: () => true, // processed getter absent → off
      textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } },
    });
    const shared = sharedState();
    createRender2D(deps, shared).render();

    expect(deps.originalCanvas.width).toBe(6); // original tiles 3×
    expect(deps.originalCanvas.height).toBe(6);
    expect(deps.previewCanvas.width).toBe(2); // processed stays single-tile
    expect(deps.previewCanvas.height).toBe(2);

    expect(deps.originalCanvas.classList.contains('repeat-tiled')).toBe(true);
    expect(deps.previewCanvas.classList.contains('repeat-tiled')).toBe(false);
  });

  it('applies AO factors before dithering, darkening the original pane', () => {
    const ao = solidTexture([0, 0, 0, 255]); // fully occluded (red = 0)
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: ao, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    const shared = sharedState();
    createRender2D(deps, shared).render();
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('multiplies the lightmap into the lit source', () => {
    const lightmap = solidTexture([0, 0, 0, 255]); // black lightmap at full contribution
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: lightmap, name: '' } } });
    const shared = sharedState();
    createRender2D(deps, shared).render();
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('pixelizes the AO factor in the dithered pane, keeping the original pane smooth', () => {
    const ao = new FakeCanvas();
    ao.width = 2;
    ao.height = 2;
    ao.context.pixels.set([
      255, 255, 255, 255, 128, 128, 128, 255,
      64, 64, 64, 255, 32, 32, 32, 255,
    ]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: asSourceImage(ao), name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.mode = 'none'; // dither is pass-through; the output shows the lighting alone
    deps.state.pixelation = 50; // downscale to half, then upscale back = 2×2 blocks
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Original pane: per-pixel AO multiply (smooth)  10×255/255=10, 20×128/255≈10,
    // 30×64/255≈8, 40×32/255≈5. The pixel grid slider must not affect it.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([
      10, 10, 10, 255, 10, 10, 10, 255,
      8, 8, 8, 255, 5, 5, 5, 255,
    ]);
    // Dithered pane: the AO block takes its top-left factor (255 = unoccluded),
    // so the whole 2×2 block keeps the base's top-left pixel  one uniform
    // lighting value per base block, matching the pixelized base.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(10).flatMap((_v, index) => (index % 4 === 3 ? [255] : [10])));
  });

  it('pixelizes the lightmap in the dithered pane, keeping the original pane smooth', () => {
    const lightmap = new FakeCanvas();
    lightmap.width = 2;
    lightmap.height = 2;
    lightmap.context.pixels.set([
      0, 0, 0, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 255, 255, 255, 255,
    ]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: asSourceImage(lightmap), name: '' } } });
    deps.state.mode = 'none';
    deps.state.pixelation = 50;
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Original pane: per-pixel multiply  only the black texel darkens.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([
      0, 0, 0, 255, 20, 20, 20, 255,
      30, 30, 30, 255, 40, 40, 40, 255,
    ]);
    // Dithered pane: the lightmap block takes its top-left texel (black), so
    // the whole block is shadowed like the base's own block.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('pixelizes the AO before driving the halftone dot screen', () => {
    const ao = new FakeCanvas();
    ao.width = 2;
    ao.height = 2;
    ao.context.pixels.set([
      255, 255, 255, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 0, 0, 0, 255,
    ]);
    const deps = createRendererDeps({ textures: { base: { image: solidTexture([200, 200, 200, 255]), name: '' }, ao: { image: asSourceImage(ao), name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.mode = 'halftone';
    deps.state.pixelation = 50; // the AO block's top-left texel (unoccluded) wins
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Without pixelation the mixed AO map would darken three quarters of the
    // dot screen; pixelization quantizes it to one uniform unoccluded block,
    // so the dots disappear and the hard-mapped white base shows through.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(255));
  });

  it('halftone dots follow implicit lightmap changes (sun re-bakes)', () => {
    const deps = createRendererDeps({ textures: { base: { image: solidTexture([200, 200, 200, 255]), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.mode = 'halftone';
    const shared = sharedState();
    const render2d = createRender2D(deps, shared);

    // Sun moved to full shadow: the implicit lightmap goes black and the dot
    // screen fills with black over the hard-mapped white base.
    shared.implicitLightmapCanvas = solidTexture([0, 0, 0, 255]) as unknown as HTMLCanvasElement;
    render2d.render();
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));

    // Sun moved to full light: the dots disappear and the plain base returns.
    shared.implicitLightmapCanvas = solidTexture([255, 255, 255, 255]) as unknown as HTMLCanvasElement;
    render2d.render();
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(255));
  });

  it('halftone dots follow AO changes', () => {
    const deps = createRendererDeps({ textures: { base: { image: solidTexture([200, 200, 200, 255]), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.mode = 'halftone';
    const shared = sharedState();
    const render2d = createRender2D(deps, shared);

    // No AO yet: luminance-driven dots on a bright base stay below dot size in
    // the 2×2 cell, so the preview is the plain white base.
    render2d.render();
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(255));

    // AO bake lands (fully occluded): the dot screen fills with black.
    deps.textures.ao.image = solidTexture([0, 0, 0, 255]);
    render2d.render();
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('shows the raw lightmap in both panes when lightmap-only mode is on', () => {
    const lightmap = solidTexture([200, 200, 200, 255]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: lightmap, name: '' } } });
    deps.state.viewModeOriginal = 'lightmap';
    deps.state.viewModeProcessed = 'lightmap';
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Original pane shows the unlit lightmap itself (not base × lightmap) at native resolution.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([200, 200, 200, 255]);
    // Dithered pane quantizes the lightmap (200 → white).
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(255));
  });

  it('pixelizes (never dithers) the normal map in the dithered pane', () => {
    const normal = solidTexture([128, 128, 255, 255]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: normal, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.viewModeOriginal = 'normals';
    deps.state.viewModeProcessed = 'normals';
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Original pane shows the raw normal map at native resolution.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([128, 128, 255, 255]);
    // Dithered pane shows the nearest-neighbor pixelized map (1×1 → 2×2), not
    // a palette-quantized copy  normals can't be dithered.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual([
      128, 128, 255, 255, 128, 128, 255, 255,
      128, 128, 255, 255, 128, 128, 255, 255,
    ]);
  });

  it('applies the pixelation percentage to the processed normals inspection', () => {
    const normal = new FakeCanvas();
    normal.width = 4;
    normal.height = 4;
    normal.context.pixels.set([
      10, 10, 10, 255, 11, 11, 11, 255, 20, 20, 20, 255, 21, 21, 21, 255,
      12, 12, 12, 255, 13, 13, 13, 255, 22, 22, 22, 255, 23, 23, 23, 255,
      30, 30, 30, 255, 31, 31, 31, 255, 40, 40, 40, 255, 41, 41, 41, 255,
      32, 32, 32, 255, 33, 33, 33, 255, 42, 42, 42, 255, 43, 43, 43, 255,
    ]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: asSourceImage(normal), name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.viewModeProcessed = 'normals';
    deps.state.resolution = 4;
    deps.state.pixelation = 50; // downscale to half, then upscale back = 2×2 blocks
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // The normals inspection shows the same chunky blocks as the dithered
    // base: 2×2 blocks of the top-left normal at full output resolution.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual([
      10, 10, 10, 255, 10, 10, 10, 255, 20, 20, 20, 255, 20, 20, 20, 255,
      10, 10, 10, 255, 10, 10, 10, 255, 20, 20, 20, 255, 20, 20, 20, 255,
      30, 30, 30, 255, 30, 30, 30, 255, 40, 40, 40, 255, 40, 40, 40, 255,
      30, 30, 30, 255, 30, 30, 30, 255, 40, 40, 40, 255, 40, 40, 40, 255,
    ]);
  });

  it('shows the AO-remapped combined map in both panes when Lightmap+AO mode is on', () => {
    const ao = solidTexture([128, 128, 128, 255]); // 50% visibility
    const lightmap = solidTexture([200, 200, 200, 255]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: ao, name: '' }, normal: { image: null, name: '' }, lightmap: { image: lightmap, name: '' } } });
    deps.state.viewModeOriginal = 'lightmap-ao';
    deps.state.viewModeProcessed = 'lightmap-ao';
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Combined = lightmap × AO visibility: 200 × (128/255) ≈ 100.
    // Original pane shows the combined map (identity remap at defaults) at the target resolution.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([
      100, 100, 100, 255, 100, 100, 100, 255,
      100, 100, 100, 255, 100, 100, 100, 255,
    ]);
    // Dithered pane quantizes the combined map (100 → black).
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('applies AO power in the Lightmap+AO view mode', () => {
    const ao = solidTexture([128, 128, 128, 255]); // 50% visibility
    const lightmap = solidTexture([200, 200, 200, 255]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: ao, name: '' }, normal: { image: null, name: '' }, lightmap: { image: lightmap, name: '' } } });
    deps.state.viewModeOriginal = 'lightmap-ao';
    deps.state.viewModeProcessed = 'lightmap-ao';
    deps.state.aoPower = 0.5;
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // 50% visibility at power 0.5 → visibility √(128/255) ≈ 0.708 → 200 × 0.708 ≈ 141.7 → 142 (clamped-array rounds).
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([
      142, 142, 142, 255, 142, 142, 142, 255,
      142, 142, 142, 255, 142, 142, 142, 255,
    ]);
  });

  it('shows the remapped AO map in both panes when AO-only mode is on', () => {
    const ao = solidTexture([200, 200, 200, 255]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: ao, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.viewModeOriginal = 'ao';
    deps.state.viewModeProcessed = 'ao';
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Original pane shows the AO factors  the bias/scale remap is the
    // identity at defaults, so the raw map passes through  at native resolution.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([200, 200, 200, 255]);
    // Dithered pane quantizes the AO map (200 → white).
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(255));
  });

  it('applies AO power in the AO-only view mode', () => {
    const ao = solidTexture([200, 200, 200, 255]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: ao, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.viewModeOriginal = 'ao';
    deps.state.viewModeProcessed = 'ao';
    deps.state.aoPower = 2;
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // 200/255 visibility at power 2 → (200/255)² ≈ 0.615 → 157 gray.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([157, 157, 157, 255]);
  });

  it('applies AO bias in the AO-only view mode', () => {
    const ao = solidTexture([255, 255, 255, 255]); // fully unoccluded
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: ao, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.viewModeOriginal = 'ao';
    deps.state.aoBias = 0.5;
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Bias re-floors the curve but the normalization keeps fully-unoccluded
    // pixels at full brightness: (1 − 0.5)/(1 − 0.5) = 1 → 255 white.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([255, 255, 255, 255]);
  });

  it('renders each pane from its own view mode', () => {
    const ao = solidTexture([200, 200, 200, 255]);
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: ao, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.viewModeOriginal = 'ao';
    // viewModeProcessed stays 'flat' → the dithered pane quantizes the lit base.
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // Original pane shows the AO factors (identity remap at defaults) at native resolution.
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual([200, 200, 200, 255]);
    // Dithered pane quantizes the lit base texture, not the AO map  all dark → black.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(16).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
  });

  it('renders a 16-wave V sawtooth in the 2D panes and feeds the viewports', () => {
    const originalViewport = { applyImage: vi.fn(), setUVStretch: vi.fn(), setDirectionalityView: vi.fn() };
    const processedViewport = { applyImage: vi.fn(), setUVStretch: vi.fn(), setDirectionalityView: vi.fn() };
    const deps = createRendererDeps({
      // 1×1 base + resolution 16 → a 16×16 output, so the sawtooth is sampled.
      textures: { base: { image: solidTexture([0, 0, 0, 255]), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } },
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.resolution = 16;
    deps.state.viewModeOriginal = 'directionality';
    deps.state.viewModeProcessed = 'directionality';
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // gray = fract(V*16), V = (height-1-py)/(height-1). First column pins the
    // 16-wave sawtooth (it resets to 0 at both V=1 and V=0 and spans every band).
    expect(shared.directionalityCanvas).not.toBeNull();
    const w = deps.originalCanvas.width;
    const pixels = deps.originalCanvas.context.pixels;
    const rowStride = w * 4;
    const expected = [0, 238, 221, 204, 187, 170, 153, 136, 119, 102, 85, 68, 51, 34, 17, 0];
    for (let py = 0; py < expected.length; py += 1) {
      expect(pixels[py * rowStride]).toBe(expected[py]);
    }
    expect(originalViewport.setDirectionalityView).toHaveBeenCalledWith(true);
    expect(processedViewport.setDirectionalityView).toHaveBeenCalledWith(true);
  });

  it('renders matching UV and world faces with the shared stretch colors', async () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0, 2, 0, 0, 0, 1, 0,
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([
      0, 0, 0.5, 0, 0, 1,
      0.5, 0, 1, 0, 1, 1,
    ], 2));
    const scene = new Scene();
    scene.add(new Mesh(geometry, new MeshBasicMaterial()));
    const originalViewport = { applyImage: vi.fn(), setUVStretch: vi.fn(), setDirectionalityView: vi.fn() };
    const processedViewport = { applyImage: vi.fn(), setUVStretch: vi.fn(), setDirectionalityView: vi.fn() };
    const deps = createRendererDeps({
      textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } },
      getAOScene: () => scene,
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.viewModeOriginal = 'uv-stretch';
    deps.state.viewModeProcessed = 'uv-stretch';
    await createRender2D(deps, sharedState()).render();

    const data = originalViewport.setUVStretch.mock.calls[0][0];
    expect(data.faces).toHaveLength(2);
    expect(data.faces[0].color).not.toEqual(data.faces[1].color);
    expect(processedViewport.setUVStretch).toHaveBeenCalledWith(data);
    expect(Array.from(deps.originalCanvas.context.pixels)).toEqual(Array.from(deps.previewCanvas.context.pixels));
  });

  it('recolors UV stretch faces and re-rasterizes when sensitivity changes', async () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0, 2, 0, 0, 0, 1, 0,
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([
      0, 0, 0.5, 0, 0, 1,
      0.5, 0, 1, 0, 1, 1,
    ], 2));
    const scene = new Scene();
    scene.add(new Mesh(geometry, new MeshBasicMaterial()));
    const originalViewport = { applyImage: vi.fn(), setUVStretch: vi.fn(), setDirectionalityView: vi.fn() };
    const processedViewport = { applyImage: vi.fn(), setUVStretch: vi.fn(), setDirectionalityView: vi.fn() };
    const deps = createRendererDeps({
      textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } },
      getAOScene: () => scene,
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    deps.state.viewModeOriginal = 'uv-stretch';
    deps.state.viewModeProcessed = 'uv-stretch';
    deps.state.uvStretchSensitivity = 1;
    const shared = sharedState();
    const render2d = createRender2D(deps, shared);
    await render2d.render();
    const dataAtIdentity = originalViewport.setUVStretch.mock.calls[0][0];
    const canvasAtIdentity = shared.uvStretchCanvas;

    deps.state.uvStretchSensitivity = 4;
    await render2d.render();

    // Raising sensitivity pushes the heatmap off blue toward red: a fresh data
    // reference (so the 3D overlay rebuilds), a fresh rasterized canvas, and a
    // real change in the per-face colors, while the measured distortion stands.
    const dataAt4x = originalViewport.setUVStretch.mock.calls[1][0];
    expect(dataAt4x).not.toBe(dataAtIdentity);
    expect(dataAt4x.faces.map((face) => face.distortion)).toEqual(dataAtIdentity.faces.map((face) => face.distortion));
    expect(dataAt4x.faces.map((face) => face.color)).not.toEqual(dataAtIdentity.faces.map((face) => face.color));
    expect(shared.uvStretchCanvas).not.toBe(canvasAtIdentity);
  });

  it('feeds the viewports when both are available', () => {
    const originalViewport = { applyImage: vi.fn(), setUVStretch: vi.fn(), setDirectionalityView: vi.fn() };
    const processedViewport = { applyImage: vi.fn(), setUVStretch: vi.fn(), setDirectionalityView: vi.fn() };
    const deps = createRendererDeps({
      textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } },
      getOriginalViewport: () => originalViewport as unknown as ModelViewport,
      getProcessedViewport: () => processedViewport as unknown as ModelViewport,
    });
    createRender2D(deps, sharedState()).render();
    expect(originalViewport.applyImage).toHaveBeenCalledOnce();
    expect(processedViewport.applyImage).toHaveBeenCalledOnce();
  });

  it('upscales a small source to the target resolution with nearest-neighbor', () => {
    const deps = createRendererDeps({ textures: { base: { image: solidTexture([40, 40, 40, 255]), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.resolution = 4;
    const shared = sharedState();
    createRender2D(deps, shared).render();

    // 1×1 source → 4×4 grid: every texel stays identical to its source pixel
    // (a smoothed resample would interpolate), and the badge reports the
    // requested dither size, not the source's 1 × 1.
    expect(Array.from(deps.previewCanvas.context.pixels)).toEqual(new Array(64).fill(0).flatMap((_v, index) => (index % 4 === 3 ? [255] : [0])));
    expect(deps.updatePreviewBadge).toHaveBeenCalledWith(4, 4);
  });

  it('stops early when the canvas context is unavailable', () => {
    stubDocument(() => ({ width: 0, height: 0, getContext: () => null }));
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    const shared = sharedState();
    createRender2D(deps, shared).render();
    expect(shared.renderedCanvas).toBeDefined();
    expect(deps.updatePreviewBadge).not.toHaveBeenCalled();
  });

  it('routes seamless modes through the async GPU dither and caches the result', async () => {
    const deps = createRendererDeps({ textures: { base: { image: baseTexture(), name: '' }, ao: { image: null, name: '' }, normal: { image: null, name: '' }, lightmap: { image: null, name: '' } } });
    deps.state.mode = 'floyd';
    const shared = sharedState();
    const render2d = createRender2D(deps, shared);
    const gpuDither = vi.mocked(processImageDataAsync);
    vi.stubGlobal('navigator', { gpu: {} });

    await render2d.render();
    expect(gpuDither).toHaveBeenCalledTimes(1);
    // Identical input and options on the second render: the cache serves the
    // stored GPU result without re-running the dither.
    await render2d.render();
    expect(gpuDither).toHaveBeenCalledTimes(1);
    expect(deps.updatePreviewBadge).toHaveBeenCalled();
  });
});
