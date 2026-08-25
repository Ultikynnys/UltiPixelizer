import { vi } from 'vitest';
import type { RendererDeps, RenderShared } from '../../src/lib/render/types';
import type { State, TextureChannelId, TextureSlot } from '../../src/lib/state';
import { FakeCanvas, FakeSvg } from './domStubs';
import { computeOutputDimensions } from '../../src/lib/canvas';

/** A RenderShared with the usual defaults — a fresh FakeCanvas for the
 * rendered canvas and nulls for the lazy lightmap slots. Tests that need a
 * non-null slot (e.g. the overlay suite's originalBaseCanvas) pass overrides.
 * Shared by the bake / overlay / render2d suites. */
export function createRenderShared(overrides: Partial<RenderShared> = {}): RenderShared {
  return {
    renderedCanvas: new FakeCanvas() as unknown as HTMLCanvasElement,
    originalBaseCanvas: null,
    implicitLightmapCanvas: null,
    implicitLightmapTimer: 0,
    lightmapCleared: false,
    ...overrides,
  };
}

/** A complete serializable State so render submodules read real values. */
export function createStateFixture(): State {
  return {
    paletteKey: 'pico8',
    customColors: [],
    // Small by default so tests with tiny sources exercise exact pixel math
    // (no upscale); tests that assert downscale dimensions pin 64. The default
    // mode is the zero-strength ordered grid — plain palette mapping with no
    // pattern (the empty 'none' mode now passes the source through unchanged).
    resolution: 2,
    mode: 'ordered',
    strength: 0,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    pixelation: 0,
    upscale: 'nearest',
    quadTessellation: 16,
    quadGrid: false,
    displacementStrength: 0.15,
    displacementFlip: false,
    paletteFilter: 'compact',
    uvMap: 'uv',
    lodLevel: 0,
    sun: { color: '#ffffff', intensity: 1, direction: { x: -0.5, y: -0.5, z: -0.5 } },
    ambient: { color: '#ffffff', intensity: 0.2 },
    worldAxis: 'maya',
    stripeAngle: 45,
    noiseScale: 1,
    halftoneScale: 1,
    seed: 1,
    aoBias: 0,
    aoPower: 1,
    aoDistance: 2,
    normalStrength: 1,
    normalFormat: 'opengl',
    cameraDirection: { x: 0, y: 0, z: -1 },
    navigationPan: false,
    showFloorGrid: false,
    paletteSearchQuery: '',
    paletteSearchSort: 'name',
    showUVOverlapOriginal: false,
    showUVOverlapProcessed: false,
    showUVWireframeOriginal: false,
    showUVWireframeProcessed: false,
    viewModeOriginal: 'flat',
    viewModeProcessed: 'flat',
  } as State;
}

export function emptyTextures(): RendererDeps['textures'] {
  return {
    base: { image: null, name: '' },
    ao: { image: null, name: '' },
    normal: { image: null, name: '' },
    lightmap: { image: null, name: '' },
    displacement: { image: null, name: '' },
  };
}

/** A full RendererDeps with inert defaults; overrides win via spread. The
 * canvas properties keep their FakeCanvas type so tests can read the stubbed
 * pixel buffers back, while remaining assignable to RendererDeps. */
export function createRendererDeps(overrides: Omit<Partial<RendererDeps>, 'textures'> & { textures?: Partial<Record<TextureChannelId, TextureSlot>> } = {}): RendererDeps & {
  previewCanvas: FakeCanvas;
  originalCanvas: FakeCanvas;
  wireframeOverlays: { original: FakeSvg; processed: FakeSvg };
  luminosityHistograms: { original: FakeCanvas; processed: FakeCanvas };
} {
  const originalWireframeOverlay = new FakeSvg();
  const processedWireframeOverlay = new FakeSvg();
  const originalLuminosityHistogram = new FakeCanvas();
  const processedLuminosityHistogram = new FakeCanvas();
  const { textures: texturesOverride, ...restOverrides } = overrides;
  const deps = {
    state: createStateFixture(),
    textures: { ...emptyTextures(), ...texturesOverride },
    previewCanvas: new FakeCanvas(),
    originalCanvas: new FakeCanvas(),
    luminosityHistograms: {
      original: originalLuminosityHistogram as unknown as HTMLCanvasElement,
      processed: processedLuminosityHistogram as unknown as HTMLCanvasElement,
    },
    showLuminosityHistograms: () => true,
    wireframeOverlays: {
      original: originalWireframeOverlay as unknown as SVGSVGElement,
      processed: processedWireframeOverlay as unknown as SVGSVGElement,
    },
    getAOScene: () => null,
    forEachViewport: vi.fn(),
    getOriginalViewport: vi.fn(() => null),
    getProcessedViewport: vi.fn(() => null),
    getOriginalPreviewMode: () => '2d',
    getProcessedPreviewMode: () => '2d',
    // Mirrors main.ts dimensions(): the dithered texture (and therefore the
    // AO/lightmap bake) resamples the source to the pixelization width with
    // the height scaled to preserve aspect ratio — smaller sources upscale.
    dimensions: () => {
      const source = deps.textures.base.image;
      if (!source) return { width: 2, height: 2 };
      return computeOutputDimensions(deps.state.resolution, source);
    },
    currentColors: () => ['#000000', '#ffffff'],
    updatePreviewBadge: vi.fn(),
    renderLightmapControls: vi.fn(),
    renderNormalControls: vi.fn(),
    renderTextureRibbon: vi.fn(),
    applySun: vi.fn(),
    onAoProgress: vi.fn(),
    ...restOverrides,
  } as unknown as RendererDeps & {
    previewCanvas: FakeCanvas;
    originalCanvas: FakeCanvas;
    wireframeOverlays: { original: FakeSvg; processed: FakeSvg };
    luminosityHistograms: { original: FakeCanvas; processed: FakeCanvas };
  };
  return deps;
}
