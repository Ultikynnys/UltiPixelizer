import type { Object3D } from 'three';
import type { ModelViewport } from '../modelPreview';
import type { PreviewMode, State, TextureChannelId, TextureSlot } from '../state';

export interface RendererDeps {
  state: State;
  textures: Record<TextureChannelId, TextureSlot>;
  previewCanvas: HTMLCanvasElement;
  originalCanvas: HTMLCanvasElement;
  /** Fixed overlay graphs computed from each pane's final single-tile 2D
   * result after its selected view mode has been applied. */
  luminosityHistograms: { original: HTMLCanvasElement; processed: HTMLCanvasElement };
  /** False in the compact single-pane layout, where histogram overlays are hidden. */
  showLuminosityHistograms: () => boolean;
  /** Cached bitmap overlays for the UV wireframe, one per 2D pane, positioned
   * over the texture canvas and sharing its zoom transform. */
  wireframeOverlays: { original: HTMLCanvasElement; processed: HTMLCanvasElement };
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
  /** When set and true, the pane renders the texture tiled 3×3 (image repeat)
   * so tile-boundary seams are visible. Fallback-quad diagnostic, per pane. */
  repeatTextureOriginal?: () => boolean;
  repeatTextureProcessed?: () => boolean;
}

export interface RendererApi {
  render: () => Promise<void>;
  /** Re-applies the last rendered frames to both 3D viewports — call right
   * after swapping a viewport's model/quad so the fresh materials pick up the
   * texture synchronously instead of flashing white until the next render. */
  applyViewportImages: () => void;
  generateAo: () => Promise<boolean>;
  bakeLighting: () => Promise<boolean>;
  /** Removes the lightmap and cancels any in-flight lighting bake. */
  clearLightmap: (suppressImplicit?: boolean) => void;
  /** Whether the lightmap slot was explicitly cleared (X) — while true, the
   * implicit re-bake scheduler (sun/ambient sliders, normal-map slot edits)
   * stays quiet; see RenderShared.lightmapCleared. */
  isLightmapCleared: () => boolean;
  /** Clears the lightmap-cleared flag so the implicit re-bake scheduler runs
   * again. Called when the user adjusts a sun/ambient light control — a
   * deliberate lighting action must never leave the sliders silently dead
   * after the slot's X. Does not start a bake itself. */
  reengageLighting: () => void;
  /** Drops cached bake scenes (world transforms, BVH) after any in-place
   * change to the AO scene's geometry: UV channel, LOD visibility, world-axis
   * rotation, model import/close. Without this the next bake would reuse stale
   * UVs/visibility/rotation. */
  invalidateBakeScene: () => void;
  /** Replaces the bake geometry used when no model is loaded — the quad view's
   * tessellated middle tile. main.ts calls this when tessellation or
   * displacement changes; the bake cache must be invalidated alongside. */
  setFallbackQuad: (scene: Object3D) => void;
  refreshUVWireframe: () => void;
  refreshUVOverlap: () => void;
  /** Forces the next refreshUVOverlap to recompute — call after any in-place
   * change to the AO scene's UVs/visibility/rotation. */
  invalidateUVOverlap: () => void;
  /** Synchronizes the cached UV wireframe overlays after the toggle, pane
   * mode, frame resize, or texture bitmap size changes. */
  syncWireframeOverlays: () => void;
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
   * the implicit auto-bake from sun/ambient and normal-map changes is
   * suppressed so the render stays unlit (pure-white lightmap) until an
   * explicit bake, a loaded lightmap, or a reset. */
  lightmapCleared: boolean;
}
