import type { DitherMode } from './dither';
import type { WorldAxis } from './modelFiles';
import type { NormalFormat } from './normal';
import type { Palette, PaletteCategory } from './palettes';
import type { DirectionVector } from './sunDirection';

export type SourceImage = CanvasImageSource & { width: number; height: number };

export type TextureChannelId = 'base' | 'ao' | 'normal' | 'lightmap';

export type PreviewMode = '2d' | '3d';

export type PreviewViewMode = 'flat' | 'basecolor' | 'normals' | 'ao' | 'lightmap' | 'lightmap-ao';

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
  paletteFilter: PaletteCategory;
  uvMap: string;
  lodLevel: number;
  sun: SunState;
  ambient: LightState;
  worldAxis: WorldAxis;
  cameraDirection: DirectionVector;
  stripeAngle: number;
  noiseScale: number;
  seed: number;
  aoBias: number;
  aoPower: number;
  aoDistance: number;
  normalStrength: number;
  normalFormat: NormalFormat;
  showUVOverlap: boolean;
  showUVWireframe: boolean;
  viewModeOriginal: PreviewViewMode;
  viewModeProcessed: PreviewViewMode;
};

/** True when a lightmap is loaded (the lightmap slot holds an image). Shared by
 * the light-map controls, sun sync, and the bake scheduler so the predicate
 * lives in one place. */
export function lightmapIsActive(textures: Record<TextureChannelId, TextureSlot>): boolean {
  return textures.lightmap.image !== null;
}
