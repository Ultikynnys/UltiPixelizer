import { Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { SerializedBakeScene } from './aoRaster';
import { castBakeRay, type UvPair } from './bakeGeometry';
import { sampleNormalMap, type NormalMapSource } from './normal';

/**
 * Lightmap bake options flattened for the worker — colors are pre-parsed to
 * 0..1 RGB tuples and the normal map travels as plain pixels, so the worker
 * never touches DOM/color-string parsing.
 */
export type SerializedLightmapOptions = {
  sunDirection: [number, number, number];
  sunColor: [number, number, number];
  sunIntensity: number;
  ambientColor: [number, number, number];
  ambientIntensity: number;
  normalMap: NormalMapSource | null;
  normalStrength: number;
  normalFlipY: boolean;
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

/** Worker message: the bake failed. */
export type LightmapBakeError = {
  type: 'error';
  jobId: number;
  message: string;
};

const _sun = new Vector3();
const _mapped = new Vector3();
const _pa = new Vector3();

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Flattened port of lightmapBake.combineLight — additive ambient + sun, each
 * term clamped to [0, 1] before summing, the total clamped again. */
function combineLight(
  ambientColor: [number, number, number],
  sunColor: [number, number, number],
  ambientScale: number,
  sunScale: number,
  lambert: number,
  sunVisibility: number,
): [number, number, number] {
  return [0, 1, 2].map((channel) => {
    const ambient = clamp01(ambientColor[channel] * ambientScale);
    const sun = clamp01(sunColor[channel] * sunScale * lambert * sunVisibility);
    return clamp01(ambient + sun);
  }) as [number, number, number];
}

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
  const normalMap = options.normalMap;
  const normalStrength = clamp01(options.normalStrength);
  const normalFlipY = options.normalFlipY;

  const triangleCount = triangleVerts.length / 3;
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const uvOffset = triangleIndex * 6;
    const uva: UvPair = [triangleUVs[uvOffset], triangleUVs[uvOffset + 1]];
    const uvb: UvPair = [triangleUVs[uvOffset + 2], triangleUVs[uvOffset + 3]];
    const uvc: UvPair = [triangleUVs[uvOffset + 4], triangleUVs[uvOffset + 5]];
    const vertOffset = triangleIndex * 3;
    const v0 = triangleVerts[vertOffset] * 6;
    const v1 = triangleVerts[vertOffset + 1] * 6;
    const v2 = triangleVerts[vertOffset + 2] * 6;

    // Per-triangle tangent bases were computed once at scene collection and
    // ride in the serialized scene — the map only changes the sampled normals.
    const tangentBasis = normalMap && input.tangentBases
      ? input.tangentBases.subarray(triangleIndex * 6, triangleIndex * 6 + 6)
      : null;

    const ax = uva[0] * width;
    const ay = (1 - uva[1]) * height;
    const bx = uvb[0] * width;
    const by = (1 - uvb[1]) * height;
    const cx = uvc[0] * width;
    const cy = (1 - uvc[1]) * height;

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (denominator === 0) continue;

    for (let py = minY; py <= maxY; py += 1) {
      const rowOffset = py * width;
      for (let px = minX; px <= maxX; px += 1) {
        const x = px + 0.5;
        const y = py + 0.5;
        const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const texel = rowOffset + px;
        written[texel] = 1;
        const index = texel * 4;

        // Interpolate the smooth vertex normal at this texel, then light that
        // shading normal per pixel so smoothed normals stay continuous.
        const na = vertices[v0 + 3];
        const nb = vertices[v1 + 3];
        const nc = vertices[v2 + 3];
        const nx = w0 * na + w1 * nb + w2 * nc;
        const ny = w0 * vertices[v0 + 4] + w1 * vertices[v1 + 4] + w2 * vertices[v2 + 4];
        const nz = w0 * vertices[v0 + 5] + w1 * vertices[v1 + 5] + w2 * vertices[v2 + 5];
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        const nxl = nx / length;
        const nyl = ny / length;
        const nzl = nz / length;

        if (tangentBasis && normalMap) {
          const u = w0 * uva[0] + w1 * uvb[0] + w2 * uvc[0];
          const v = w0 * uva[1] + w1 * uvb[1] + w2 * uvc[1];
          const [sx, sy, sz] = sampleNormalMap(normalMap, u, v, normalStrength, normalFlipY);
          _mapped.set(
            tangentBasis[0] * sx + tangentBasis[3] * sy + nxl * sz,
            tangentBasis[1] * sx + tangentBasis[4] * sy + nyl * sz,
            tangentBasis[2] * sx + tangentBasis[5] * sy + nzl * sz,
          ).normalize();
        } else {
          _mapped.set(nxl, nyl, nzl);
        }

        const lambert = Math.max(0, _mapped.dot(towardSun));
        const sunVisibility = w0 * visibility[triangleVerts[vertOffset]]
          + w1 * visibility[triangleVerts[vertOffset + 1]]
          + w2 * visibility[triangleVerts[vertOffset + 2]];
        const light = combineLight(options.ambientColor, options.sunColor, ambientScale, sunScale, lambert, sunVisibility);
        pixels[index] = Math.round(light[0] * 255);
        pixels[index + 1] = Math.round(light[1] * 255);
        pixels[index + 2] = Math.round(light[2] * 255);
      }
    }
  }
}
