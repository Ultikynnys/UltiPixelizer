import { Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { texelShadingNormal, type SerializedBakeScene } from './aoRaster';
import { blankBakeBuffers, castBakeRay, dilateUVBake, rasterizeBakeBand } from './bakeGeometry';
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
const _position = new Vector3();

/** Four deterministic subtexel locations. A directional light needs one ray
 * per surface point; spatially distinct samples provide shadow-edge
 * antialiasing without pretending duplicate parallel rays add information. */
const SUN_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
  [0.25, 0.25],
];

/** Returns barycentric weights at a subtexel offset from the current pixel
 * center. UV V is inverted because raster rows run top-to-bottom. */
function offsetBarycentrics(
  center: readonly [number, number, number],
  dx: number,
  dy: number,
  width: number,
  height: number,
  input: SerializedBakeScene,
  uvOffset: number,
): [number, number, number] | null {
  const u0 = input.triangleUVs[uvOffset];
  const v0 = 1 - input.triangleUVs[uvOffset + 1];
  const u1 = input.triangleUVs[uvOffset + 2];
  const v1 = 1 - input.triangleUVs[uvOffset + 3];
  const u2 = input.triangleUVs[uvOffset + 4];
  const v2 = 1 - input.triangleUVs[uvOffset + 5];
  const du = dx / width;
  const dv = dy / height;
  const denominator = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
  if (denominator === 0) return null;
  const centerU = center[0] * u0 + center[1] * u1 + center[2] * u2;
  const centerV = center[0] * v0 + center[1] * v1 + center[2] * v2;
  const w0 = ((v1 - v2) * (centerU + du - u2) + (u2 - u1) * (centerV + dv - v2)) / denominator;
  const w1 = ((v2 - v0) * (centerU + du - u2) + (u0 - u2) * (centerV + dv - v2)) / denominator;
  const w2 = 1 - w0 - w1;
  return w0 < 0 || w1 < 0 || w2 < 0 ? null : [w0, w1, w2];
}

/**
 * Rasterizes the lightmap bake directly from a serialized bake scene. Every
 * covered texel takes four spatially distinct subtexel samples; each sample
 * reconstructs its world-space position and shading normal, evaluates Lambert,
 * and casts its own shadow ray toward the sun. This avoids interpolating binary
 * visibility from sparse mesh vertices and antialiases shadow boundaries on
 * low-poly surfaces. The optional normal map perturbs each sample's shading
 * normal through a per-triangle tangent basis. `pixels` arrives
 * `255`-filled and `written` blank; the caller owns the UV dilation
 * (dilateUVBake) exactly like the sync rasterizer.
 */
export function rasterizeLightmap(
  pixels: Uint8ClampedArray,
  written: Uint8Array,
  input: SerializedBakeScene,
  bvh: MeshBVH | null,
  width: number,
  height: number,
  options: SerializedLightmapOptions,
): void {
  const { vertices, triangleUVs, triangleVerts } = input;
  const towardSun = _sun.set(options.sunDirection[0], options.sunDirection[1], options.sunDirection[2]);
  const ambientScale = clamp01(options.ambientIntensity);
  const sunScale = options.sunIntensity;

  rasterizeBakeBand(width, height, 0, height, triangleUVs, triangleVerts, written,
    (_px, _py, w0, w1, w2, index, _triangleIndex, uvOffset, _vertOffset, v0, v1, v2) => {
      const pixelOffset = index * 4;

      let sun = 0;
      let sampleCount = 0;
      const center: [number, number, number] = [w0, w1, w2];
      for (const [dx, dy] of SUN_SAMPLES) {
        const weights = offsetBarycentrics(center, dx, dy, width, height, input, uvOffset);
        if (!weights) continue;
        const [s0, s1, s2] = weights;
        const normal = texelShadingNormal(vertices, v0, v1, v2, s0, s1, s2, input, uvOffset);
        _mapped.set(normal.sx, normal.sy, normal.sz);
        const lambert = Math.max(0, _mapped.dot(towardSun));
        let visibility = lambert > 0 && sunScale > 0 ? 1 : 0;
        if (visibility && bvh) {
          _position.set(
            s0 * vertices[v0] + s1 * vertices[v1] + s2 * vertices[v2],
            s0 * vertices[v0 + 1] + s1 * vertices[v1 + 1] + s2 * vertices[v2 + 1],
            s0 * vertices[v0 + 2] + s1 * vertices[v1 + 2] + s2 * vertices[v2 + 2],
          );
          if (castBakeRay(bvh, _position, _mapped, towardSun, input.epsilon, input.epsilon)) visibility = 0;
        }
        sun += lambert * visibility;
        sampleCount += 1;
      }
      const sampledSun = sampleCount > 0 ? sun / sampleCount : 0;
      const light = combineLight(options.ambientColor, options.sunColor, ambientScale, sunScale, sampledSun, 1);
      pixels[pixelOffset] = Math.round(light[0] * 255);
      pixels[pixelOffset + 1] = Math.round(light[1] * 255);
      pixels[pixelOffset + 2] = Math.round(light[2] * 255);
    },
  );
}

/** The full raster pass every lightmap caller shares — blank buffers, per-
 * texel lighting, and UV dilation — the trio the sync bake, the GPU path, and
 * the worker each spelled out. Returns the pixel map plus the written mask
 * (the caller only needs the mask if it keeps the map). */
export function rasterizeLightmapFull(
  input: SerializedBakeScene,
  bvh: MeshBVH | null,
  width: number,
  height: number,
  options: SerializedLightmapOptions,
): { pixels: Uint8ClampedArray; written: Uint8Array } {
  const { pixels, written } = blankBakeBuffers(width, height, 4);
  rasterizeLightmap(pixels, written, input, bvh, width, height, options);
  dilateUVBake(pixels, written, width, height, 4);
  return { pixels, written };
}
