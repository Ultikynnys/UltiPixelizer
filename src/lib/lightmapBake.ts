import { Object3D, Vector3 } from 'three';
import { hexToRgb, isHexColor } from './palettes';
import { directionToSun, type DirectionVector } from './sunDirection';
import { castBakeRay, collectBakeScene, dilateUVBake, rasterizeBakedPixels, type BakeScene } from './bakeGeometry';
import { clamp01, combineLight, type RGB } from './math';
import { sampleNormalMap, type NormalMapSource } from './normal';
import { serializeBakeScene } from './aoRaster';
import { computeSunVisibilityGpu } from './lightmapGpu';
import { rasterizeLightmap, type LightmapBakeRequest, type LightmapBakeResult, type SerializedLightmapOptions } from './lightmapRaster';
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

function lambertFactor(normal: Vector3, towardSun: Vector3): number {
  return Math.max(0, normal.dot(towardSun));
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
 */
export function bakeMeshLightmap(scene: Object3D, width: number, height: number, options: BakeLightmapOptions, bakeSceneOverride?: BakeScene): Uint8ClampedArray {
  const sun = directionToSun(options.sunDirection);
  const towardSun = new Vector3(sun.x, sun.y, sun.z);
  const sunColor = parseColor(options.sunColor);
  const ambientColor: RGB = parseColor(options.ambientColor);
  const ambientScale = clamp01(options.ambientIntensity);
  const sunScale = options.sunIntensity;
  const normalMap = options.normalMap;
  const normalStrength = clamp01(options.normalStrength ?? 1);
  const normalFlipY = options.normalFlipY ?? false;

  const { vertices, triangles, tangentBases, bvh, epsilon } = bakeSceneOverride ?? collectBakeScene(scene);

  // Shadow is sampled per vertex (binary occluder test) and interpolated per
  // pixel so shadow edges stay soft rather than snapping to face boundaries.
  const visibility = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 1) {
    const vertex = vertices[i];
    const lit = lambertFactor(vertex.normal, towardSun) > 0;
    let sunVisibility = lit && sunScale > 0 ? 1 : 0;
    if (sunVisibility && bvh && castBakeRay(bvh, vertex.position, vertex.normal, towardSun, epsilon, epsilon)) sunVisibility = 0;
    visibility[i] = sunVisibility;
  }

  const mapped = new Vector3();
  const pixels = rasterizeBakedPixels(width, height, triangles, 4, (pixels, _px, _py, w0, w1, w2, triangle, triangleIndex, offset) => {
    // Interpolate the smooth vertex normal at this texel, then light that
    // shading normal per pixel so smoothed normals stay continuous across faces.
    const na = vertices[triangle.verts[0]].normal;
    const nb = vertices[triangle.verts[1]].normal;
    const nc = vertices[triangle.verts[2]].normal;
    const nx = w0 * na.x + w1 * nb.x + w2 * nc.x;
    const ny = w0 * na.y + w1 * nb.y + w2 * nc.y;
    const nz = w0 * na.z + w1 * nb.z + w2 * nc.z;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    mapped.set(nx / length, ny / length, nz / length);

    // The per-triangle tangent bases were computed once at scene collection,
    // so the map only perturbs the shading normal through the cached basis.
    if (normalMap && tangentBases) {
      const [uva, uvb, uvc] = triangle.uv;
      const u = w0 * uva[0] + w1 * uvb[0] + w2 * uvc[0];
      const v = w0 * uva[1] + w1 * uvb[1] + w2 * uvc[1];
      const [sx, sy, sz] = sampleNormalMap(normalMap, u, v, normalStrength, normalFlipY);
      const basisOffset = triangleIndex * 6;
      mapped.set(
        tangentBases[basisOffset] * sx + tangentBases[basisOffset + 3] * sy + (nx / length) * sz,
        tangentBases[basisOffset + 1] * sx + tangentBases[basisOffset + 4] * sy + (ny / length) * sz,
        tangentBases[basisOffset + 2] * sx + tangentBases[basisOffset + 5] * sy + (nz / length) * sz,
      ).normalize();
    }

    const lambert = lambertFactor(mapped, towardSun);
    const sunVisibility = w0 * visibility[triangle.verts[0]]
      + w1 * visibility[triangle.verts[1]]
      + w2 * visibility[triangle.verts[2]];
    const light = combineLight(ambientColor, sunColor, ambientScale, sunScale, lambert, sunVisibility);
    pixels[offset] = Math.round(light[0] * 255);
    pixels[offset + 1] = Math.round(light[1] * 255);
    pixels[offset + 2] = Math.round(light[2] * 255);
  });
  return pixels;
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
  const sun = directionToSun(options.sunDirection);
  const serializedOptions: SerializedLightmapOptions = {
    sunDirection: [sun.x, sun.y, sun.z],
    sunColor: parseColor(options.sunColor),
    sunIntensity: options.sunIntensity,
    ambientColor: parseColor(options.ambientColor),
    ambientIntensity: options.ambientIntensity,
    normalMap: options.normalMap ?? null,
    normalStrength: options.normalStrength ?? 1,
    normalFlipY: options.normalFlipY ?? false,
  };

  // GPU visibility runs on the main thread (the ray cast is the expensive part;
  // the raster pass is cheap). The navigator.gpu check is synchronous so the
  // device request never fires in tests; any throw falls through to the
  // worker/CPU path.
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const serialized = serializeBakeScene(bakeScene, 2);
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
    const serialized = serializeBakeScene(bakeScene, 2);
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
