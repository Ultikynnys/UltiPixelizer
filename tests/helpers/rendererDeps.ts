import { vi } from 'vitest';
import type { RendererDeps } from '../../src/lib/render/types';
import type { State, TextureChannelId, TextureSlot } from '../../src/lib/state';
import { FakeCanvas } from './domStubs';

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
    ditherScale: 1,
    halftoneScale: 1,
    seed: 1,
    aoBias: 0,
    aoPower: 1,
    aoDistance: 2,
    normalStrength: 1,
    normalFormat: 'opengl',
    cameraDirection: { x: 0, y: 0, z: -1 },
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
  wireframeOverlays: { original: FakeCanvas; processed: FakeCanvas };
} {
  const originalWireframeOverlay = new FakeCanvas();
  const processedWireframeOverlay = new FakeCanvas();
  const { textures: texturesOverride, ...restOverrides } = overrides;
  const deps = {
    state: createStateFixture(),
    textures: { ...emptyTextures(), ...texturesOverride },
    previewCanvas: new FakeCanvas(),
    originalCanvas: new FakeCanvas(),
    wireframeOverlays: {
      original: originalWireframeOverlay as unknown as HTMLCanvasElement,
      processed: processedWireframeOverlay as unknown as HTMLCanvasElement,
    },
    getAOScene: () => null,
    forEachViewport: vi.fn(),
    getOriginalViewport: () => null,
    getProcessedViewport: () => null,
    getOriginalPreviewMode: () => '2d',
    getProcessedPreviewMode: () => '2d',
    // Mirrors main.ts dimensions(): the dithered texture (and therefore the
    // AO/lightmap bake) resamples the source to the pixelization width with
    // the height scaled to preserve aspect ratio — smaller sources upscale.
    dimensions: () => {
      const source = deps.textures.base.image;
      if (!source) return { width: 2, height: 2 };
      const width = deps.state.resolution;
      return { width, height: Math.max(1, Math.round(width * source.height / source.width)) };
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
    wireframeOverlays: { original: FakeCanvas; processed: FakeCanvas };
  };
  return deps;
}
