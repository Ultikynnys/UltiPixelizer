/**
 * Headless AO and lighting bakes. Drives the app's synchronous CPU bake cores
 * (`bakeMeshAO` / `bakeMeshLightmap`) — byte-identical to the app's fallback
 * path — with no workers or GPU.
 */
import type { Object3D } from 'three';
import { bakeMeshAO } from '../src/lib/aoBake';
import { bakeMeshLightmap } from '../src/lib/lightmapBake';
import { getBakeScene } from '../src/lib/bakeSceneCache';
import type { ConversionConfig } from '../src/lib/presets';
import type { DecodedImage } from './imageIo';
import { resampleAndPixelate, type UpscaleMethod } from './resample';

/** AO factor map (255 = unoccluded) as `width*height` bytes. */
export function bakeAO(
  scene: Object3D,
  width: number,
  height: number,
  config: ConversionConfig,
  samples: number,
  normalMap: DecodedImage | null,
): Uint8ClampedArray {
  const bakeScene = getBakeScene(scene, config.aoDistance) ?? undefined;
  return bakeMeshAO(scene, width, height, {
    samples,
    distance: config.aoDistance,
    normalMap: normalMap ?? undefined,
    normalStrength: config.normalStrength,
    normalFlipY: config.normalFormat === 'directx',
  }, bakeScene);
}

/** Lightmap RGBA pixels (`width*height*4`), irradiance only. */
export function bakeLighting(
  scene: Object3D,
  width: number,
  height: number,
  config: ConversionConfig,
  normalMap: DecodedImage | null,
): Uint8ClampedArray {
  const bakeScene = getBakeScene(scene) ?? undefined;
  return bakeMeshLightmap(scene, width, height, {
    sunDirection: config.sunDirection,
    sunColor: config.sunColor,
    sunIntensity: config.sunIntensity,
    ambientColor: config.ambientColor,
    ambientIntensity: config.ambientIntensity,
    normalMap: normalMap ?? undefined,
    normalStrength: config.normalStrength,
    normalFlipY: config.normalFormat === 'directx',
  }, bakeScene);
}

/** Resamples + pixelates a normal map to the bake grid, matching the app's
 * `normalMapOptions` (the bakes sample the same chunky normals the panes show). */
export function normalMapAtBakeResolution(
  normal: DecodedImage,
  width: number,
  height: number,
  pixelation: number,
  upscale: UpscaleMethod,
): DecodedImage {
  return resampleAndPixelate(normal, width, height, pixelation, upscale);
}

/** Expands a grayscale AO factor map to RGBA (r=g=b=factor, a=255). */
export function factorsToRgba(factors: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const value = factors[i];
    const offset = i * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return rgba;
}
