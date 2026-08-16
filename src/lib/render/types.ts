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
  showToast: (message: string) => void;
  renderLightmapControls: () => void;
  renderNormalControls: () => void;
  renderTextureRibbon: () => void;
  applySun: () => void;
}

export interface RendererApi {
  render: () => void;
  generateAo: () => void;
  bakeLighting: () => void;
  clearLightmap: () => void;
  scheduleImplicitLightmapBake: () => void;
  scheduleNormalAdjustedLighting: () => void;
  refreshUVWireframe: () => void;
  refreshUVOverlap: () => void;
  resetPreview: () => void;
  getRenderedCanvas: () => HTMLCanvasElement;
}

/** Mutable state shared across the render submodules. */
export interface RenderShared {
  renderedCanvas: HTMLCanvasElement;
  originalBaseCanvas: HTMLCanvasElement | null;
  implicitLightmapCanvas: HTMLCanvasElement | null;
  implicitLightmapTimer: number;
}
