/**
 * Headless port of `render2d.ts`'s processed-pane composition: turns the base /
 * normal / AO / lightmap inputs into the final RGBA for a chosen view mode,
 * exactly like the app's Export PNG button.
 *
 * Rules mirrored from render2d.ts:
 *  - `basecolor` / `ao` / `lightmap` / `lightmap-ao` show that map, palette-dithered,
 *    with lighting skipped (lighting a map you're inspecting would alter it).
 *  - `flat` (Combined) shows the base, palette-dithered, with AO x lightmap applied.
 *  - `normals` / `uv-stretch` / `texel-variance` / `directionality` are pixelized
 *    nearest (no dither) — a normal map can't be palette-quantized.
 */
import type { Object3D } from 'three';
import { processImageData } from '../src/lib/dither';
import { aoMultiplier, applyAO, redChannelFactors } from '../src/lib/ao';
import { applyLightmap } from '../src/lib/lightmap';
import { rasterizeBake, type WorldPositionMap } from '../src/lib/bakeGeometry';
import { computeTexelVarianceData, computeUVStretchData, recolorUVStretchData, type UVStretchData } from '../src/lib/texelDensity';
import type { ConversionConfig } from '../src/lib/presets';
import type { PreviewViewMode } from '../src/lib/state';
import type { DecodedImage } from './imageIo';
import { pixelate, resampleAndPixelate, type UpscaleMethod } from './resample';

export type ComposeInput = {
  base: DecodedImage | null;
  normal: DecodedImage | null;
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
const ImageDataCtorRef = (globalThis as unknown as { ImageData: ImageDataCtor }).ImageData;

const DIRECT_INSPECTION = new Set<PreviewViewMode>(['normals', 'uv-stretch', 'texel-variance', 'directionality']);

function rgbaFrom(factors: (i: number) => number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const gray = Math.round(factors(i) * 255);
    const offset = i * 4;
    out[offset] = gray;
    out[offset + 1] = gray;
    out[offset + 2] = gray;
    out[offset + 3] = 255;
  }
  return out;
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

export function composeView(input: ComposeInput): Uint8ClampedArray {
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

  const asImage = (data: Uint8ClampedArray): DecodedImage => ({ data, width, height });

  // The inspected map for this view mode (null for the 'flat' combined view).
  // Raw decoded inputs (base, normal) keep their own dimensions; every map the
  // CLI computes is already at (width, height).
  const inspectionSource = (): DecodedImage | null => {
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
    return resampleAndPixelate(inspected, width, height, config.pixelation, upscale).data;
  }

  // Everything else: resample + pixelate the inspected map (or the base for
  // 'flat'), optionally light it, then palette-dither.
  const source = inspected ?? input.base;
  if (!source) throw new Error('No base texture: pass --input <image> for Texture1 modes.');
  let working = resampleAndPixelate(source, width, height, config.pixelation, upscale);

  if (!inspected) {
    // 'flat' combined: apply AO x lightmap. When pixelating, the maps go chunky too.
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
    if (workingFactors) applyAO(working.data, workingFactors, config.aoBias, config.aoPower);
    if (workingLightmap) applyLightmap(working.data, workingLightmap);
  }

  const imageData = new ImageDataCtorRef(working.data, working.width, working.height);
  const world = config.patternSpace === 'world' ? input.worldPositions : null;
  const processed = processImageData(imageData, {
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
  });
  return processed.data;
}
