/**
 * View composition core — the single implementation of the processed-pane
 * rules, shared by the web app (`render2d.ts`) and the CLI (`cli/compose.ts`):
 * which map a view inspects, how it is resampled/pixelated, how AO/lightmap are
 * applied (or, for halftone, folded into the lighting dots), and the dither
 * call. Both pipelines therefore produce identical pixels for the same inputs.
 *
 * Rules (mirrored from the app):
 *  - `basecolor` / `ao` / `lightmap` / `lightmap-ao` show that map, palette-dithered,
 *    with lighting skipped (lighting a map you're inspecting would alter it).
 *  - `flat` (Combined) shows the base, palette-dithered, with AO × lightmap applied.
 *  - `normals` / `uv-stretch` / `texel-variance` / `directionality` are pixelized
 *    nearest (no dither) — a normal map can't be palette-quantized.
 *  - `halftone` leaves the base unlit and carries AO × lightmap in the
 *    per-dot `lighting` array instead.
 */
import type { Object3D } from 'three';
import { processImageData, type ProcessOptions } from '../dither';
import { aoMultiplier, applyAO, redChannelFactors } from '../ao';
import { applyLightmap } from '../lightmap';
import { rasterizeBake, type WorldPositionMap } from '../bakeGeometry';
import { computeTexelVarianceData, computeUVStretchData, recolorUVStretchData, type UVStretchData } from '../texelDensity';
import type { ConversionConfig } from '../presets';
import type { PreviewViewMode } from '../state';
import { factorRgba, pixelate, resampleAndPixelate, type PixelBuffer, type UpscaleMethod } from './pixel';

export type ComposeInput = {
  base: PixelBuffer | null;
  normal: PixelBuffer | null;
  /** AO factor map at (width,height) — 255 = unoccluded. */
  aoFactors: Uint8ClampedArray | null;
  /** Lightmap RGBA at (width,height)*4. */
  lightmap: Uint8ClampedArray | null;
  /** Scene for uv-stretch / texel-variance views (may be null). */
  scene: Object3D | null;
  /** Per-texel world positions for `patternSpace: 'world'` (may be null). */
  worldPositions: WorldPositionMap | null;
  width: number;
  height: number;
  config: ConversionConfig;
  colors: string[];
  view: PreviewViewMode;
};

type ImageDataCtor = new (data: Uint8ClampedArray, width: number, height: number) => ImageData;

/** Builds an ImageData on demand: the app/browser, the CLI webview, and the
 * Node test host all provide `ImageData` at different times, so it is resolved
 * per call rather than captured at module load. */
function createImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  const ctor = (globalThis as unknown as { ImageData: ImageDataCtor }).ImageData;
  return new ctor(data, width, height);
}

const DIRECT_INSPECTION = new Set<PreviewViewMode>(['normals', 'uv-stretch', 'texel-variance', 'directionality']);

function rgbaFrom(factors: (i: number) => number, width: number, height: number): Uint8ClampedArray {
  return factorRgba(width, height, (i) => Math.round(factors(i) * 255));
}

function rasterizeFaces(data: UVStretchData, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  rasterizeBake(width, height, data.faces, (px, py, _w0, _w1, _w2, face) => {
    const offset = (py * width + px) * 4;
    out[offset] = face.color[0];
    out[offset + 1] = face.color[1];
    out[offset + 2] = face.color[2];
    out[offset + 3] = 255;
  });
  return out;
}

/** Vertical sawtooth of 16 waves over V — the 2D directionality reference. */
function directionality(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py += 1) {
    const v = (height - 1 - py) / Math.max(height - 1, 1);
    const gray = Math.round((v * 16 - Math.floor(v * 16)) * 255);
    for (let px = 0; px < width; px += 1) {
      const offset = (py * width + px) * 4;
      out[offset] = gray; out[offset + 1] = gray; out[offset + 2] = gray; out[offset + 3] = 255;
    }
  }
  return out;
}

/** Per-pixel RGB lighting for the halftone dot screen: AO visibility folded into
 * every lightmap channel, normalized to 0..1. Returns null when neither AO nor a
 * lightmap is active (no lighting-dot layer). Matches the app's halftone pass. */
function halftoneLighting(
  width: number,
  height: number,
  config: ConversionConfig,
  factors: Uint8ClampedArray | null,
  lightmap: Uint8ClampedArray | null,
): Float32Array | null {
  if (!factors && !lightmap) return null;
  const lighting = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const ao = factors ? aoMultiplier(factors[i], config.aoBias, config.aoPower) : 1;
    const lightOffset = i * 3;
    if (lightmap) {
      const sourceOffset = i * 4;
      lighting[lightOffset] = (lightmap[sourceOffset] / 255) * ao;
      lighting[lightOffset + 1] = (lightmap[sourceOffset + 1] / 255) * ao;
      lighting[lightOffset + 2] = (lightmap[sourceOffset + 2] / 255) * ao;
    } else {
      lighting[lightOffset] = ao;
      lighting[lightOffset + 1] = ao;
      lighting[lightOffset + 2] = ao;
    }
  }
  return lighting;
}

/** The shared composition rules, up to (but not including) the dither call:
 * picks the inspected map, resamples/pixelates it, applies AO/lightmap (or
 * assembles the halftone lighting), and returns everything the dither needs.
 * `render2d.ts` calls this and runs its own (cached / GPU) dither on the result;
 * `composeView` runs the synchronous dither. Both produce identical pixels. */
export type PreparedView =
  | { direct: true; rgba: Uint8ClampedArray }
  | { direct: false; lit: ImageData; options: ProcessOptions; lighting: Float32Array | null };

export function prepareView(input: ComposeInput): PreparedView {
  const { width, height, config, colors, view } = input;
  const upscale: UpscaleMethod = config.upscale;

  // Per-pixel AO multiplier (bias/power remapped), the exact value lighting uses.
  const aoMultiplierAt = (i: number): number =>
    input.aoFactors ? aoMultiplier(input.aoFactors[i], config.aoBias, config.aoPower) : 1;

  const aoRgba = input.aoFactors ? rgbaFrom((i) => aoMultiplierAt(i), width, height) : null;
  const lightmapRgba = input.lightmap;

  const combinedRgba = (): Uint8ClampedArray | null => {
    if (!aoRgba || !lightmapRgba) return null;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      const offset = i * 4;
      const vis = aoMultiplierAt(i);
      out[offset] = lightmapRgba[offset] * vis;
      out[offset + 1] = lightmapRgba[offset + 1] * vis;
      out[offset + 2] = lightmapRgba[offset + 2] * vis;
      out[offset + 3] = 255;
    }
    return out;
  };

  const stretchRgba = (): Uint8ClampedArray | null => {
    if (!input.scene) return null;
    const data = computeUVStretchData(input.scene);
    if (!data) return null;
    return rasterizeFaces(recolorUVStretchData(data, config.uvStretchSensitivity), width, height);
  };

  const varianceRgba = (): Uint8ClampedArray | null => {
    if (!input.scene) return null;
    const data = computeTexelVarianceData(input.scene, width, height);
    return data ? rasterizeFaces(data, width, height) : null;
  };

  const asImage = (data: Uint8ClampedArray): PixelBuffer => ({ data, width, height });

  // The inspected map for this view mode (null for the 'flat' combined view).
  const inspectionSource = (): PixelBuffer | null => {
    switch (view) {
      case 'basecolor': return input.base;
      case 'normals': return input.normal;
      case 'ao': return aoRgba ? asImage(aoRgba) : null;
      case 'lightmap': return lightmapRgba ? asImage(lightmapRgba) : null;
      case 'lightmap-ao': { const rgba = combinedRgba(); return rgba ? asImage(rgba) : null; }
      case 'uv-stretch': { const rgba = stretchRgba(); return rgba ? asImage(rgba) : null; }
      case 'texel-variance': { const rgba = varianceRgba(); return rgba ? asImage(rgba) : null; }
      case 'directionality': return asImage(directionality(width, height));
      default: return null; // flat
    }
  };
  const inspected = inspectionSource();

  // Direct-inspection modes are pixelized nearest, never dithered.
  if (DIRECT_INSPECTION.has(view)) {
    if (!inspected) throw new Error(`View "${view}" needs input that was not provided (normal map, or a model for stretch/variance views).`);
    return { direct: true, rgba: resampleAndPixelate(inspected, width, height, config.pixelation, upscale).data };
  }

  // Everything else: resample + pixelate the inspected map (or the base for
  // 'flat'), optionally light it, then palette-dither.
  const source = inspected ?? input.base;
  if (!source) throw new Error('No base texture: pass --input <image> for Texture1 modes.');
  const working = resampleAndPixelate(source, width, height, config.pixelation, upscale);

  // Working AO/lightmap (pixelated when pixelation>0, so each base block gets
  // one uniform value). Used by the lit-base path and the halftone lighting.
  let workingFactors = input.aoFactors;
  let workingLightmap = input.lightmap;
  if (config.pixelation > 0) {
    if (input.aoFactors) {
      const aoImg = pixelate(asImage(rgbaFrom((i) => input.aoFactors![i] / 255, width, height)), config.pixelation, upscale);
      workingFactors = redChannelFactors(aoImg, false);
    }
    if (input.lightmap) {
      workingLightmap = pixelate(asImage(input.lightmap), config.pixelation, upscale).data;
    }
  }

  const imageData = createImageData(working.data, working.width, working.height);
  const world = config.patternSpace === 'world' ? input.worldPositions : null;
  const options = {
    palette: colors,
    mode: config.mode,
    strength: config.strength,
    brightness: config.brightness,
    contrast: config.contrast,
    saturation: config.saturation,
    stripeAngle: config.stripeAngle,
    seed: config.seed,
    uvScale: config.uvScale,
    worldspaceScale: config.worldspaceScale,
    patternSpace: config.patternSpace,
    worldPositions: world ? world.positions : null,
    worldNormals: world ? world.normals : null,
    worldPositionCoverage: world ? world.coverage : null,
  };

  // Halftone leaves the base unlit and rides AO × lightmap on the lighting dots
  // instead (only for the combined 'flat' view; an inspected map stays unlit).
  if (config.mode === 'halftone' && !inspected) {
    const lighting = halftoneLighting(width, height, config, workingFactors, workingLightmap);
    return { direct: false, lit: imageData, options, lighting };
  }

  if (!inspected) {
    if (workingFactors) applyAO(working.data, workingFactors, config.aoBias, config.aoPower);
    if (workingLightmap) applyLightmap(working.data, workingLightmap);
  }

  return { direct: false, lit: imageData, options, lighting: null };
}

/** Compose the full processed RGBA for a view by running the synchronous dither
 * over `prepareView`'s output. */
export function composeView(input: ComposeInput): Uint8ClampedArray {
  const prepared = prepareView(input);
  if (prepared.direct) return prepared.rgba;
  return processImageData(prepared.lit, { ...prepared.options, lighting: prepared.lighting }).data;
}
