import { Object3D } from 'three';
import { hexToRgb, isHexColor } from './palettes';
import { directionToSun, type DirectionVector } from './sunDirection';
import { collectBakeScene, dilateUVBake, type BakeScene } from './bakeGeometry';
import { clamp01, type RGB } from './math';
import type { NormalMapSource } from './normal';
import { serializeBakeScene, type SerializedNormalMap } from './aoRaster';
import { computeSunVisibilityGpu } from './lightmapGpu';
import { computeSunVisibilityCpu, rasterizeLightmap, type LightmapBakeRequest, type LightmapBakeResult, type SerializedLightmapOptions } from './lightmapRaster';
// The worker is inlined into the bundle (blob URL) — same rationale as the AO
// worker: Tauri/Electron shells and restricted CSPs can reject module workers
// loaded from a URL, whereas a blob-backed worker is protocol-agnostic.
import LightmapWorker from './lightmapWorker.worker?worker&inline';

export type BakeLightmapOptions = {
  sunDirection: DirectionVector;
  sunColor: string;
  sunIntensity: number;
  ambientColor: string;
  ambientIntensity: number;
  normalMap?: NormalMapSource;
  normalStrength?: number;
  normalFlipY?: boolean;
};

function parseColor(color: string): RGB {
  if (!isHexColor(color)) throw new Error(`Invalid light color: ${color}`);
  const [red, green, blue] = hexToRgb(color);
  return [red / 255, green / 255, blue / 255];
}

/**
 * Bakes ambient and shadowed directional illumination into UV-space RGBA pixels.
 * Output contains irradiance only (no albedo), with white representing neutral light.
 *
 * Lighting is evaluated per pixel (Phong), not per vertex: the smooth vertex
 * normal is interpolated at each texel and the Lambert term is taken from that
 * shading normal, so the sun follows smoothed normals continuously across faces
 * instead of averaging per-vertex light (Gouraud) and showing faceting seams.
 * Pass a pre-collected {@link BakeScene} as `bakeSceneOverride` to skip the
 * (potentially hundreds-of-ms) scene collection — the caller owns its
 * freshness via the bake-scene cache's invalidation contract.
 *
 * This sync path is the CPU mirror of the worker/GPU paths: it serializes the
 * collected scene once and funnels through the same per-vertex visibility and
 * per-texel raster the worker reads (`computeSunVisibilityCpu` +
 * `rasterizeLightmap` + UV dilation), so the result is byte-identical to the
 * async bake by construction.
 */
export function bakeMeshLightmap(scene: Object3D, width: number, height: number, options: BakeLightmapOptions, bakeSceneOverride?: BakeScene): Uint8ClampedArray {
  const bakeScene = bakeSceneOverride ?? collectBakeScene(scene);
  const serialized = serializeBakeScene(bakeScene, 2, lightmapNormalMap(options));
  const serializedOptions = serializeLightmapOptions(options);
  const visibility = computeSunVisibilityCpu(serialized, bakeScene.bvh, serializedOptions.sunDirection, serializedOptions.sunIntensity);
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const written = new Uint8Array(width * height);
  rasterizeLightmap(pixels, written, visibility, serialized, width, height, serializedOptions);
  dilateUVBake(pixels, written, width, height, 4);
  return pixels;
}

/** Flattens bake options into the worker-transportable shape. The normal map
 * rides in the serialized bake scene (like the AO bake), so this carries only
 * the parsed colors and the light geometry. */
function serializeLightmapOptions(options: BakeLightmapOptions): SerializedLightmapOptions {
  const sun = directionToSun(options.sunDirection);
  return {
    sunDirection: [sun.x, sun.y, sun.z],
    sunColor: parseColor(options.sunColor),
    sunIntensity: options.sunIntensity,
    ambientColor: parseColor(options.ambientColor),
    ambientIntensity: options.ambientIntensity,
  };
}

/** Bundles the normal map for the serialized bake scene — the same payload the
 * AO bake transfers, so both pipelines perturb shading normals through the
 * shared `texelShadingNormal` mirror. The strength is clamped to [0, 1] here
 * exactly where the old lightmap raster mirrored it. */
function lightmapNormalMap(options: BakeLightmapOptions): SerializedNormalMap | undefined {
  if (!options.normalMap) return undefined;
  return {
    map: options.normalMap,
    strength: clamp01(options.normalStrength ?? 1),
    flipY: options.normalFlipY ?? false,
  };
}

/**
 * Async equivalent of `bakeMeshLightmap` for the browser. When WebGPU is
 * available the per-vertex sun-visibility ray cast runs in a compute shader and
 * the (cheap) per-texel lighting runs on the main thread; otherwise the whole
 * bake (BVH build + per-texel Phong rasterization + UV dilation) runs in a web
 * worker so the main thread stays responsive: the implicit lightmap re-bakes on
 * every sun / quad / resolution change, and at 1024² on a heavily tessellated
 * fallback grid the sync path is hundreds of ms of main-thread work. The result
 * is byte-identical to the sync path (the worker raster reads the same
 * serialized scene the AO bake transfers); any GPU/worker failure falls back to
 * the CPU/worker path.
 */
export async function bakeLightmapAsync(
  scene: Object3D,
  width: number,
  height: number,
  options: BakeLightmapOptions,
  bakeSceneOverride?: BakeScene,
): Promise<Uint8ClampedArray> {
  const bakeScene = bakeSceneOverride ?? collectBakeScene(scene);
  const serializedOptions = serializeLightmapOptions(options);

  // GPU visibility runs on the main thread (the ray cast is the expensive part;
  // the raster pass is cheap). The navigator.gpu check is synchronous so the
  // device request never fires in tests; any throw falls through to the
  // worker/CPU path.
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const serialized = serializeBakeScene(bakeScene, 2, lightmapNormalMap(options));
      const visibility = await computeSunVisibilityGpu(serialized, serializedOptions.sunDirection, serializedOptions.sunIntensity);
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
      const written = new Uint8Array(width * height);
      rasterizeLightmap(pixels, written, visibility, serialized, width, height, serializedOptions);
      dilateUVBake(pixels, written, width, height, 4);
      return pixels;
    } catch (error) {
      console.error('Lightmap GPU bake failed, falling back to the CPU path.', error);
    }
  }

  if (typeof Worker === 'undefined') {
    return bakeMeshLightmap(scene, width, height, options, bakeScene);
  }
  try {
    const serialized = serializeBakeScene(bakeScene, 2, lightmapNormalMap(options));
    const request: LightmapBakeRequest = {
      ...serialized,
      type: 'bake',
      jobId: 1,
      width,
      height,
      options: serializedOptions,
    };
    return await new Promise<Uint8ClampedArray>((resolve, reject) => {
      const worker = new LightmapWorker();
      worker.onmessage = (event) => {
        const message = event.data as LightmapBakeResult | { type: 'error'; message: string };
        worker.terminate();
        if (message.type === 'result') resolve(message.pixels);
        else reject(new Error(message.message));
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || 'Lightmap worker failed.'));
      };
      worker.postMessage(request, [
        serialized.vertices.buffer,
        serialized.triangleUVs.buffer,
        serialized.triangleVerts.buffer,
        serialized.occluderPositions.buffer,
      ]);
    });
  } catch (error) {
    console.error('Lightmap worker bake failed, falling back to the main thread.', error);
    return bakeMeshLightmap(scene, width, height, options, bakeScene);
  }
}
