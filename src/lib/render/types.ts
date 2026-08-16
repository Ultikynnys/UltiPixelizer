import type { Object3D } from 'three';
import type { ModelViewport } from '../modelPreview';
import type { PreviewMode, State, TextureChannelId, TextureSlot } from '../state';

export interface RendererDeps {
  state: State;
  textures: Record<TextureChannelId, TextureSlot>;
  previewCanvas: HTMLCanvasElement;
  originalCanvas: HTMLCanvasElement;
  getAOScene: () => Object3D | null;
  forEachViewport: (callback: (viewport: ModelViewport) => void) => void;
  getOriginalViewport: () => ModelViewport | null;
  getProcessedViewport: () => ModelViewport | null;
  getOriginalPreviewMode: () => PreviewMode;
  getProcessedPreviewMode: () => PreviewMode;
  dimensions: () => { width: number; height: number };
  currentColors: () => string[];
  updatePreviewBadge: (width?: number, height?: number) => void;
  renderLightmapControls: () => void;
  renderNormalControls: () => void;
  renderTextureRibbon: () => void;
  applySun: () => void;
  /** Whole-percent AO bake progress (0–100), forwarded from the worker bands. */
  onAoProgress?: (percent: number) => void;
}

export interface RendererApi {
  render: () => void;
  generateAo: () => Promise<boolean>;
  bakeLighting: () => Promise<boolean>;
  /** Removes the lightmap. Pass `suppressImplicit: true` (the slot X button)
   * to also drop the live implicit bake and keep the render unlit until the
   * user explicitly bakes or loads a lightmap. Plain clears (UV/LOD/base
   * invalidation) let the implicit bake re-run so live preview resumes. */
  clearLightmap: (suppressImplicit?: boolean) => void;
  /** Re-engages the live implicit lightmap bake after the user cleared the
   * slot. Explicit actions (e.g. orient sun with camera) must still generate a
   * lightmap regardless of the cleared state. */
  reengageImplicitLightmap: () => void;
  scheduleImplicitLightmapBake: () => void;
  scheduleNormalAdjustedLighting: () => void;
  refreshUVWireframe: () => void;
  refreshUVOverlap: () => void;
  resetPreview: () => void;
  getRenderedCanvas: () => HTMLCanvasElement;
  getImplicitLightmapCanvas: () => HTMLCanvasElement | null;
}

/** Mutable state shared across the render submodules. */
export interface RenderShared {
  renderedCanvas: HTMLCanvasElement;
  originalBaseCanvas: HTMLCanvasElement | null;
  implicitLightmapCanvas: HTMLCanvasElement | null;
  implicitLightmapTimer: number;
  /** Set when the user explicitly removes the lightmap (slot X). While set,
   * the implicit auto-bake from sun/ambient is suppressed so the render stays
   * unlit (pure-white lightmap) until an explicit bake, a loaded lightmap, or
   * a reset. */
  lightmapCleared: boolean;
}
