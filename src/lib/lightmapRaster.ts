import { Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { texelShadingNormal, type SerializedBakeScene } from './aoRaster';
import { castBakeRay, rasterizeBakeBand } from './bakeGeometry';
import { clamp01, combineLight } from './math';
import type { BakeWorkerError } from './workerCommon';

/**
 * Lightmap bake options flattened for the worker — colors are pre-parsed to
 * 0..1 RGB tuples so the worker never touches DOM/color-string parsing. The
 * normal map rides in the serialized bake scene (like the AO bake), not here,
 * so every raster mirror reads the same pixel payload.
 */
export type SerializedLightmapOptions = {
  sunDirection: [number, number, number];
  sunColor: [number, number, number];
  sunIntensity: number;
  ambientColor: [number, number, number];
  ambientIntensity: number;
};

/** Worker message: bake the whole lightmap in one job (the implicit bake has
 * no progress UI, so a single worker suffices — banding can follow the AO
 * pattern if parallelism is ever needed). */
export type LightmapBakeRequest = SerializedBakeScene & {
  type: 'bake';
  jobId: number;
  width: number;
  height: number;
  options: SerializedLightmapOptions;
};

/** Worker message: finished bake — full RGBA pixels (transferred, zero-copy). */
export type LightmapBakeResult = {
  type: 'result';
  jobId: number;
  pixels: Uint8ClampedArray;
};

/** Worker message: the bake failed — the shared bake-worker error wire shape
 * (see `BakeWorkerError` in workerCommon). */
export type LightmapBakeError = BakeWorkerError;

const _sun = new Vector3();
const _mapped = new Vector3();
const _pa = new Vector3();

/**
 * Computes the per-vertex sun visibility (binary occluder test) from a
 * serialized bake scene: the CPU mirror of `computeSunVisibilityGpu`, so the
 * worker and the GPU path share one visibility definition. One ray per vertex
 * from `position + epsilon * normal` toward the sun (`near = epsilon`,
 * `far = Infinity`), gated by the Lambert term so only sun-facing vertices
 * matter. Returns a `Float32Array` of 0 (shadowed/unlit) or 1 (lit) per vertex.
 */
export function computeSunVisibilityCpu(
  input: SerializedBakeScene,
  bvh: MeshBVH | null,
  sunDirection: [number, number, number],
  sunScale: number,
): Float32Array {
  const { vertices, epsilon } = input;
  const towardSun = _sun.set(sunDirection[0], sunDirection[1], sunDirection[2]);
  const visibility = new Float32Array(vertices.length / 6);
  for (let vi = 0; vi < visibility.length; vi += 1) {
    const offset = vi * 6;
    _pa.set(vertices[offset], vertices[offset + 1], vertices[offset + 2]);
    _mapped.set(vertices[offset + 3], vertices[offset + 4], vertices[offset + 5]);
    const lit = _mapped.dot(towardSun) > 0;
    let sunVisibility = lit && sunScale > 0 ? 1 : 0;
    if (sunVisibility && bvh && castBakeRay(bvh, _pa, _mapped, towardSun, epsilon, epsilon)) sunVisibility = 0;
    visibility[vi] = sunVisibility;
  }
  return visibility;
}

/**
 * Rasterizes the lightmap bake from a serialized bake scene and a pre-computed
 * per-vertex sun-visibility array: the worker-side mirror of
 * `bakeMeshLightmap`'s raster pass, reading the same flat arrays the AO band
 * rasterizer uses so the result is byte-identical to the sync path. The
 * visibility (binary occluder test) is computed by `computeSunVisibilityCpu` or
 * `computeSunVisibilityGpu` and interpolated per pixel; the smooth vertex
 * normal is interpolated and lit per texel; the optional normal map perturbs
 * the shading normal through a per-triangle tangent basis. `pixels` arrives
 * `255`-filled and `written` blank; the caller owns the UV dilation
 * (dilateUVBake) exactly like the sync rasterizer.
 */
export function rasterizeLightmap(
  pixels: Uint8ClampedArray,
  written: Uint8Array,
  visibility: Float32Array,
  input: SerializedBakeScene,
  width: number,
  height: number,
  options: SerializedLightmapOptions,
): void {
  const { vertices, triangleUVs, triangleVerts } = input;
  const towardSun = _sun.set(options.sunDirection[0], options.sunDirection[1], options.sunDirection[2]);
  const ambientScale = clamp01(options.ambientIntensity);
  const sunScale = options.sunIntensity;

  rasterizeBakeBand(width, height, 0, height, triangleUVs, triangleVerts, written,
    (_px, _py, w0, w1, w2, index, _triangleIndex, uvOffset, vertOffset, v0, v1, v2) => {
      const pixelOffset = index * 4;

      // The smooth vertex normal is interpolated at this texel and perturbed
      // by the normal map (when the serialized scene carries one) — the same
      // shared math the AO bake uses, so both pipelines shade identically.
      const normal = texelShadingNormal(vertices, v0, v1, v2, w0, w1, w2, input, uvOffset);
      _mapped.set(normal.sx, normal.sy, normal.sz);

      const lambert = Math.max(0, _mapped.dot(towardSun));
      const sunVisibility = w0 * visibility[triangleVerts[vertOffset]]
        + w1 * visibility[triangleVerts[vertOffset + 1]]
        + w2 * visibility[triangleVerts[vertOffset + 2]];
      const light = combineLight(options.ambientColor, options.sunColor, ambientScale, sunScale, lambert, sunVisibility);
      pixels[pixelOffset] = Math.round(light[0] * 255);
      pixels[pixelOffset + 1] = Math.round(light[1] * 255);
      pixels[pixelOffset + 2] = Math.round(light[2] * 255);
    },
  );
}
