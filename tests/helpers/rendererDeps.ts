import { vi } from 'vitest';
import type { RendererDeps } from '../../src/lib/render/types';
import type { State } from '../../src/lib/state';
import { FakeCanvas } from './domStubs';

/** A complete serializable State so render submodules read real values. */
export function createStateFixture(): State {
  return {
    paletteKey: 'pico8',
    customColors: [],
    resolution: 64,
    mode: 'none',
    strength: 1,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    paletteFilter: 'all',
    uvMap: 'uv',
    lodLevel: 0,
    sun: { color: '#ffffff', intensity: 1, direction: { x: -0.5, y: -0.5, z: -0.5 } },
    ambient: { color: '#ffffff', intensity: 0.2 },
    worldAxis: 'maya',
    useSourceNormals: false,
    smoothAngle: 30,
    tessellation: 1,
    stripeAngle: 45,
    noiseScale: 1,
    seed: 1,
    aoBias: 0,
    aoScale: 1,
    aoDistance: 2,
    normalStrength: 1,
    normalFormat: 'opengl',
    cameraDirection: { x: 0, y: 0, z: -1 },
    showUVOverlap: false,
    showUVWireframe: false,
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
  };
}

/** A full RendererDeps with inert defaults; overrides win via spread. The
 * canvas properties keep their FakeCanvas type so tests can read the stubbed
 * pixel buffers back, while remaining assignable to RendererDeps. */
export function createRendererDeps(overrides: Partial<RendererDeps> = {}): RendererDeps & { previewCanvas: FakeCanvas; originalCanvas: FakeCanvas } {
  const deps = {
    state: createStateFixture(),
    textures: emptyTextures(),
    previewCanvas: new FakeCanvas(),
    originalCanvas: new FakeCanvas(),
    getAOScene: () => null,
    forEachViewport: vi.fn(),
    getOriginalViewport: () => null,
    getProcessedViewport: () => null,
    getOriginalPreviewMode: () => '2d',
    getProcessedPreviewMode: () => '2d',
    // Mirrors main.ts dimensions(): the dithered texture (and therefore the
    // AO/lightmap bake) is the source capped to the pixelization width, with
    // the height scaled to preserve aspect ratio.
    dimensions: () => {
      const source = deps.textures.base.image;
      if (!source) return { width: 2, height: 2 };
      const width = Math.min(deps.state.resolution, source.width);
      return { width, height: Math.max(1, Math.round(width * source.height / source.width)) };
    },
    currentColors: () => ['#000000', '#ffffff'],
    updatePreviewBadge: vi.fn(),
    showToast: vi.fn(),
    renderLightmapControls: vi.fn(),
    renderNormalControls: vi.fn(),
    renderTextureRibbon: vi.fn(),
    applySun: vi.fn(),
    ...overrides,
  } as unknown as RendererDeps & { previewCanvas: FakeCanvas; originalCanvas: FakeCanvas };
  return deps;
}
