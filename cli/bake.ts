/**
 * Headless AO and lighting bakes. The AO bake runs on the GPU when a headless
 * WebGPU device is available (cli/gpu.ts) and falls back to the app's
 * synchronous CPU bake cores (`bakeMeshAO` / `bakeMeshLightmap`) otherwise.
 *
 * The GPU AO path mirrors `bakeMeshAOAsync`'s ladder (src/lib/aoBake.ts) minus
 * the web-worker branch, which does not exist in Node: serialize the collected
 * scene, ray-cast on the GPU, fall back to the single-threaded CPU bake on any
 * GPU failure. It is wired by hand rather than by calling `bakeMeshAOAsync`
 * so the CLI never emits the app's `[AO bake] ...` console diagnostics on
 * stdout (they would corrupt `--json`).
 */
import type { Object3D } from 'three';
import { bakeMeshAO, roundedSamples } from '../src/lib/aoBake';
import { bakeMeshLightmap } from '../src/lib/lightmapBake';
import { bakeAOWithGpu } from '../src/lib/aoGpu';
import { serializeBakeScene } from '../src/lib/aoRaster';
import { normalMapPayload } from '../src/lib/normal';
import { webgpuUsable } from '../src/lib/gpuCommon';
import { getBakeScene } from '../src/lib/bakeSceneCache';
import type { ConversionConfig } from '../src/lib/presets';
import type { DecodedImage } from './imageIo';
import { resampleAndPixelate, type UpscaleMethod } from './resample';

/** AO factor map (255 = unoccluded) as `width*height` bytes. Uses the GPU when
 * `useGpu` is set and WebGPU is available, else the exact CPU path. */
export async function bakeAO(
  scene: Object3D,
  width: number,
  height: number,
  config: ConversionConfig,
  samples: number,
  normalMap: DecodedImage | null,
  useGpu: boolean,
): Promise<Uint8ClampedArray> {
  const bakeScene = getBakeScene(scene, config.aoDistance) ?? undefined;
  const normal = normalMapPayload({
    normalMap: normalMap ?? undefined,
    normalStrength: config.normalStrength,
    normalFlipY: config.normalFormat === 'directx',
  });
  if (useGpu && bakeScene && webgpuUsable()) {
    try {
      const input = serializeBakeScene(bakeScene, roundedSamples(samples), normal);
      return await bakeAOWithGpu(input, width, height);
    } catch {
      // Any GPU failure (device loss, validation) falls through to the CPU bake.
    }
  }
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
