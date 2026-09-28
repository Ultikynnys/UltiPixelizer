/**
 * View modes and their export filename suffixes — the single source of truth
 * shared by the app (`src/main.ts` export) and the CLI (`cli/config.ts`), so
 * the view list and output filenames cannot drift between the two.
 */
import type { PreviewViewMode } from '../state';

export const VIEW_MODES: PreviewViewMode[] = [
  'flat', 'basecolor', 'normals', 'ao', 'lightmap', 'lightmap-ao', 'uv-stretch', 'directionality', 'texel-variance',
];

/** Output file suffix per view mode (spelled for filenames). */
export const EXPORT_VIEW_SUFFIX: Record<PreviewViewMode, string> = {
  flat: 'Combined',
  basecolor: 'BaseColor',
  normals: 'Normal',
  ao: 'AO',
  lightmap: 'Lightmap',
  'lightmap-ao': 'LightmapAO',
  'uv-stretch': 'UVStretch',
  directionality: 'Directionality',
  'texel-variance': 'TexelVariance',
};
