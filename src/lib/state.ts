import type { DitherMode } from './dither';
import type { UpscaleMethod } from './canvas';
import type { WorldAxis } from './modelFiles';
import type { NormalFormat } from './normal';
import type { Palette, PaletteCategory } from './palettes';
import type { DirectionVector } from './sunDirection';

export type SourceImage = CanvasImageSource & { width: number; height: number };

export type TextureChannelId = 'base' | 'ao' | 'normal' | 'lightmap' | 'displacement';

export type PreviewMode = '2d' | '3d';

export type PreviewViewMode = 'flat' | 'basecolor' | 'normals' | 'ao' | 'lightmap' | 'lightmap-ao' | 'uv-stretch' | 'directionality';

/** Palette-library search sort: name A–Z (default), fewest colors, most colors. */
export type PaletteSearchSort = 'name' | 'fewest' | 'most';

export type TextureSlot = { image: SourceImage | null; name: string };

export type LightState = { color: string; intensity: number };
export type SunState = LightState & { direction: DirectionVector };

export type State = {
  paletteKey: string;
  customColors: string[];
  paletteSnapshot?: Palette;
  resolution: number;
  mode: DitherMode;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  pixelation: number;
  /** How the pixelated image is upscaled back to full resolution. */
  upscale: UpscaleMethod;
  quadTessellation: number;
  quadGrid: boolean;
  displacementStrength: number;
  displacementFlip: boolean;
  paletteFilter: PaletteCategory;
  /** Palette-library search query (Search category)  remembered across restarts. */
  paletteSearchQuery: string;
  /** Search-category sort order  remembered across restarts. */
  paletteSearchSort: PaletteSearchSort;
  uvMap: string;
  lodLevel: number;
  sun: SunState;
  ambient: LightState;
  worldAxis: WorldAxis;
  cameraDirection: DirectionVector;
  stripeAngle: number;
  noiseScale: number;
  halftoneScale: number;
  seed: number;
  aoBias: number;
  aoPower: number;
  aoDistance: number;
  normalStrength: number;
  normalFormat: NormalFormat;
  showUVOverlapOriginal: boolean;
  showUVOverlapProcessed: boolean;
  showUVWireframeOriginal: boolean;
  showUVWireframeProcessed: boolean;
  viewModeOriginal: PreviewViewMode;
  viewModeProcessed: PreviewViewMode;
  /** Left-drag camera action for the 3D viewports: pan (on) or orbit (off) 
   * the "Alt controls" pill. Persisted like the other settings. */
  navigationPan: boolean;
  /** Shared 10 cm floor reference shown in both 3D viewports. */
  showFloorGrid: boolean;
};

/** True when a lightmap is loaded (the lightmap slot holds an image). Shared by
 * the light-map controls, sun sync, and the bake scheduler so the predicate
 * lives in one place. */
export function lightmapIsActive(textures: Record<TextureChannelId, TextureSlot>): boolean {
  return textures.lightmap.image !== null;
}
