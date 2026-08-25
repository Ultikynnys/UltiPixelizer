import { MeshBVH } from 'three-mesh-bvh';
import { Vector3 } from 'three';
import { castBakeRay, rasterizeBakeBand, type BakeScene } from './bakeGeometry';
import { sampleNormalMap, type SerializedNormalMap } from './normal';
import type { BakeWorkerError } from './workerCommon';

/**
 * Symmetric cosine-weighted hemisphere kernel for AO sampling, flattened to
 * three floats per sample. Odd counts round up for paired symmetry  each pair
 * carries opposite azimuths so the finite kernel has no directional bias and
 * mirrored geometry bakes identically without jitter.
 */
export function symmetricHemisphereKernel(samples: number): Float64Array {
  const pairCount = Math.ceil(samples / 2);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const kernel = new Float64Array(samples * 3);
  let pushed = 0;
  for (let pair = 0; pair < pairCount && pushed < samples; pair += 1) {
    // One cosine-weighted radial stratum per opposite-azimuth pair.
    const radius = Math.sqrt((pair + 0.5) / pairCount);
    const height = Math.sqrt(1 - radius * radius);
    const phi = pair * goldenAngle;
    const x = radius * Math.cos(phi);
    const y = radius * Math.sin(phi);
    const baseOffset = pushed * 3;
    kernel[baseOffset] = x;
    kernel[baseOffset + 1] = y;
    kernel[baseOffset + 2] = height;
    pushed += 1;
    if (pushed < samples) {
      const mirrorOffset = pushed * 3;
      kernel[mirrorOffset] = -x;
      kernel[mirrorOffset + 1] = -y;
      kernel[mirrorOffset + 2] = height;
      pushed += 1;
    }
  }
  return kernel;
}

/** Snapshot of a `MeshBVH` produced by `MeshBVH.serialize` (node buffers + index),
 * safe to structured-clone to workers and reconstruct via `MeshBVH.deserialize`. */
export type SerializedBVH = ReturnType<typeof MeshBVH.serialize>;

/** Plain-typed-array snapshot of a bake scene, safe to post to a worker. */
export type SerializedBakeScene = {
  /** Interleaved [x, y, z, nx, ny, nz] per vertex. */
  vertices: Float32Array;
  /** [u0, v0, u1, v1, u2, v2] per bake triangle. */
  triangleUVs: Float32Array;
  /** [i0, i1, i2] vertex indices per bake triangle. */
  triangleVerts: Uint32Array;
  /** Flat world-space occluder positions, 9 floats per triangle. */
  occluderPositions: Float32Array;
  /** Ray-origin offset applied along the shading normal to avoid self-intersection. */
  epsilon: number;
  /** Occlusion reach  rays longer than this are treated as unoccluded. */
  maxDistance: number;
  /** Flat hemisphere kernel, 3 floats per sample. */
  kernel: Float64Array;
  samples: number;
  /** Tangent-space normal map sampled by the AO hemisphere when present 
   * pixels at the bake's output resolution, transferred with the scene. */
  normalMap: Uint8ClampedArray | null;
  normalWidth: number;
  normalHeight: number;
  normalStrength: number;
  normalFlipY: boolean;
  /** Per-triangle [tangent.xyz, bitangent.xyz], computed once at scene
   * collection; null only for hand-built scenes that skipped collection. */
  tangentBases: Float32Array | null;
  /** Serialized occluder BVH so workers deserialize instead of rebuilding the
   * same tree. Null when the scene has no occluders (empty scene). */
  bvh: SerializedBVH | null;
};

/** Re-exported from normal.ts so existing AO/lightmap consumers keep their
 * import path while the payload type lives next to its bundler. */
export type { SerializedNormalMap } from './normal';

/**
 * Copies a collected bake scene into the transferable flat layout the band
 * rasterizer (and the workers) consume. The kernel is built here so every band
 * and every worker shares byte-identical sample directions.
 */
export function serializeBakeScene(scene: BakeScene, samples: number, normal?: SerializedNormalMap): SerializedBakeScene {
  const { vertices, triangles, occluderPositions, epsilon, maxDistance } = scene;
  const vertexData = new Float32Array(vertices.length * 6);
  for (let i = 0; i < vertices.length; i += 1) {
    const { position, normal } = vertices[i];
    const offset = i * 6;
    vertexData[offset] = position.x;
    vertexData[offset + 1] = position.y;
    vertexData[offset + 2] = position.z;
    vertexData[offset + 3] = normal.x;
    vertexData[offset + 4] = normal.y;
    vertexData[offset + 5] = normal.z;
  }
  const triangleUVs = new Float32Array(triangles.length * 6);
  const triangleVerts = new Uint32Array(triangles.length * 3);
  for (let i = 0; i < triangles.length; i += 1) {
    const triangle = triangles[i];
    const uvOffset = i * 6;
    triangleUVs[uvOffset] = triangle.uv[0][0];
    triangleUVs[uvOffset + 1] = triangle.uv[0][1];
    triangleUVs[uvOffset + 2] = triangle.uv[1][0];
    triangleUVs[uvOffset + 3] = triangle.uv[1][1];
    triangleUVs[uvOffset + 4] = triangle.uv[2][0];
    triangleUVs[uvOffset + 5] = triangle.uv[2][1];
    const vertOffset = i * 3;
    triangleVerts[vertOffset] = triangle.verts[0];
    triangleVerts[vertOffset + 1] = triangle.verts[1];
    triangleVerts[vertOffset + 2] = triangle.verts[2];
  }
  return {
    vertices: vertexData,
    triangleUVs,
    triangleVerts,
    // Copy the occluder positions: `bakeLightmapAsync` transfers this buffer
    // (zero-copy) to its worker, and transferring the cached scene's own buffer
    // would detach it and break every later bake that reuses the cache.
    occluderPositions: occluderPositions.slice(),
    epsilon,
    maxDistance,
    kernel: symmetricHemisphereKernel(samples),
    samples,
    normalMap: normal ? normal.map.data : null,
    normalWidth: normal ? normal.map.width : 0,
    normalHeight: normal ? normal.map.height : 0,
    normalStrength: normal ? normal.strength : 1,
    normalFlipY: normal ? normal.flipY : false,
    tangentBases: scene.tangentBases,
    bvh: scene.bvh ? MeshBVH.serialize(scene.bvh) : null,
  };
}

/** Per-band CPU timings accumulated by `rasterizeAOBand` so the caller can
 * split the rasterization cost into its parts. All fields are milliseconds,
 * summed within one band. */
export type AOBandTimings = {
  /** BVH deserialize (set by the worker before rasterizing). */
  deserializeMs: number;
  /** Occlusion-sampling kernel loop  direction transform + castBakeRay. */
  rayMs: number;
  /** `shadeAOTexel` total  interpolation, normal-map decode, basis, plus rayMs. */
  shadeMs: number;
  /** Whole `rasterizeAOBand`  triangle loop plus per-texel shading. */
  rasterMs: number;
};

/** Row-band description for a rasterization slice. */
export type AOBandContext = {
  width: number;
  height: number;
  yStart: number;
  yEnd: number;
  /** Invoked with the cumulative rows completed inside this band, for progress reporting. */
  onRowsComplete?: (rows: number) => void;
  /** Optional accumulator the caller reads back for per-stage CPU timing. */
  timings?: AOBandTimings;
};

const _origin = new Vector3();
const _normal = new Vector3();
const _direction = new Vector3();

/**
 * Rasterizes the UV islands into the `[yStart, yEnd)` row band, writing the AO
 * factor (255 = bright/unoccluded, 0 = dark/occluded) and the written mask for
 * every covered texel. `factors` and `written` hold exactly
 * `(yEnd - yStart) × width` texels  the caller owns the full-map assembly and
 * dilation. The sample origin and smooth shading normal are interpolated per
 * texel so occlusion follows smoothed normals continuously across faces; the
 * orthonormal kernel basis is rebuilt per texel from that shading normal.
 */
export function rasterizeAOBand(
  factors: Uint8ClampedArray,
  written: Uint8Array,
  bvh: MeshBVH,
  input: SerializedBakeScene,
  context: AOBandContext,
): void {
  const { width, height, yStart, yEnd, onRowsComplete, timings } = context;
  const { vertices, kernel, samples, epsilon, maxDistance } = input;
  const rasterStart = timings ? performance.now() : 0;
  rasterizeBakeBand(width, height, yStart, yEnd, input.triangleUVs, input.triangleVerts, written,
    (_px, _py, w0, w1, w2, index, _triangleIndex, uvOffset, _vertOffset, v0, v1, v2) => {
      const shadeStart = timings ? performance.now() : 0;
      factors[index] = shadeAOTexel(
        vertices, v0, v1, v2, w0, w1, w2,
        kernel, samples, bvh, epsilon, maxDistance,
        input, uvOffset,
        timings,
      );
      if (timings) timings.shadeMs += performance.now() - shadeStart;
    },
    onRowsComplete,
  );
  if (timings) timings.rasterMs = performance.now() - rasterStart;
}

/** Interpolated per-texel shading inputs shared by the CPU ray cast and the
 * WebGPU occlusion pass: the world-space sample origin, the geometric shading
 * normal (used to offset the ray origin for self-intersection clearance), and
 * the final shading normal the hemisphere follows (perturbed by a tangent-space
 * normal map when present). */
type AOTexelShading = {
  originX: number;
  originY: number;
  originZ: number;
  gNormalX: number;
  gNormalY: number;
  gNormalZ: number;
  sNormalX: number;
  sNormalY: number;
  sNormalZ: number;
};

/** Scratch for `texelShadingNormal`  the bake loops run per texel, so the
 * shared result is written here and read immediately (no per-texel
 * allocation), the same pattern as the module-level Vector3s above. */
const _shadingNormal = { gx: 0, gy: 0, gz: 0, sx: 0, sy: 0, sz: 0 };

/**
 * Interpolates the smooth shading normal from a triangle's vertices at the
 * given barycentric weights and applies the normal-map perturbation when the
 * scene carries a tangent-space normal map. The geometric normal is kept
 * separate from the (possibly perturbed) shading normal: the former offsets
 * ray origins off the surface, the latter orients the AO hemisphere and the
 * lightmap Lambert term. The result is written into the module scratch  read
 * it before the next call. Shared by `computeAOTexelShading` (AO CPU/GPU) and
 * `rasterizeLightmap` (lightmap CPU/worker) so both pipelines perturb shading
 * normals through byte-identical math.
 */
export function texelShadingNormal(
  vertices: Float32Array,
  v0: number,
  v1: number,
  v2: number,
  w0: number,
  w1: number,
  w2: number,
  input: SerializedBakeScene,
  /** triangleIndex * 6  the triangle's UVs and tangent basis both start here. */
  uvOffset: number,
): { gx: number; gy: number; gz: number; sx: number; sy: number; sz: number } {
  const nx = w0 * vertices[v0 + 3] + w1 * vertices[v1 + 3] + w2 * vertices[v2 + 3];
  const ny = w0 * vertices[v0 + 4] + w1 * vertices[v1 + 4] + w2 * vertices[v2 + 4];
  const nz = w0 * vertices[v0 + 5] + w1 * vertices[v1 + 5] + w2 * vertices[v2 + 5];
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  const gxn = nx / length;
  const gyn = ny / length;
  const gzn = nz / length;
  let nxn = gxn;
  let nyn = gyn;
  let nzn = gzn;

  if (input.normalMap && input.tangentBases) {
    const u = w0 * input.triangleUVs[uvOffset] + w1 * input.triangleUVs[uvOffset + 2] + w2 * input.triangleUVs[uvOffset + 4];
    const v = w0 * input.triangleUVs[uvOffset + 1] + w1 * input.triangleUVs[uvOffset + 3] + w2 * input.triangleUVs[uvOffset + 5];
    const [sx, sy, sz] = sampleNormalMap(
      { data: input.normalMap, width: input.normalWidth, height: input.normalHeight },
      u, v, input.normalStrength, input.normalFlipY,
    );
    const basis = input.tangentBases;
    const mx = basis[uvOffset] * sx + basis[uvOffset + 3] * sy + nxn * sz;
    const my = basis[uvOffset + 1] * sx + basis[uvOffset + 4] * sy + nyn * sz;
    const mz = basis[uvOffset + 2] * sx + basis[uvOffset + 5] * sy + nzn * sz;
    const mappedLength = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
    nxn = mx / mappedLength;
    nyn = my / mappedLength;
    nzn = mz / mappedLength;
  }

  _shadingNormal.gx = gxn;
  _shadingNormal.gy = gyn;
  _shadingNormal.gz = gzn;
  _shadingNormal.sx = nxn;
  _shadingNormal.sy = nyn;
  _shadingNormal.sz = nzn;
  return _shadingNormal;
}

/**
 * Interpolates the world-space sample origin and the smooth shading normal
 * from a triangle's vertices at the given barycentric weights  the per-texel
 * inputs the AO ray cast needs (see `texelShadingNormal` for the normal
 * interpolation itself). Internal to this module: `shadeAOTexel` (CPU) and
 * `rasterizeAOShading` (GPU data) are its only callers.
 */
function computeAOTexelShading(
  vertices: Float32Array,
  v0: number,
  v1: number,
  v2: number,
  w0: number,
  w1: number,
  w2: number,
  input: SerializedBakeScene,
  uvOffset: number,
): AOTexelShading {
  const ox = w0 * vertices[v0] + w1 * vertices[v1] + w2 * vertices[v2];
  const oy = w0 * vertices[v0 + 1] + w1 * vertices[v1 + 1] + w2 * vertices[v2 + 1];
  const oz = w0 * vertices[v0 + 2] + w1 * vertices[v1 + 2] + w2 * vertices[v2 + 2];
  const normal = texelShadingNormal(vertices, v0, v1, v2, w0, w1, w2, input, uvOffset);
  return {
    originX: ox,
    originY: oy,
    originZ: oz,
    gNormalX: normal.gx,
    gNormalY: normal.gy,
    gNormalZ: normal.gz,
    sNormalX: normal.sx,
    sNormalY: normal.sy,
    sNormalZ: normal.sz,
  };
}

/**
 * One texel of hemisphere occlusion. Interpolates the world-space sample origin
 * and the smooth shading normal from the triangle's vertices, builds an
 * orthonormal tangent basis around that normal, and counts kernel directions
 * that hit the occluder BVH. With a tangent-space normal map the shading normal
 * is perturbed first (sampled at the texel's UV, mapped through the triangle's
 * precomputed tangent basis) and the hemisphere follows the mapped normal, so
 * normal-map crevices and ridges influence occlusion. Returns the 0–255
 * visibility factor.
 */
function shadeAOTexel(
  vertices: Float32Array,
  v0: number,
  v1: number,
  v2: number,
  w0: number,
  w1: number,
  w2: number,
  kernel: Float64Array,
  samples: number,
  bvh: MeshBVH,
  epsilon: number,
  maxDistance: number,
  input: SerializedBakeScene,
  uvOffset: number,
  timings?: AOBandTimings,
): number {
  const shading = computeAOTexelShading(vertices, v0, v1, v2, w0, w1, w2, input, uvOffset);
  const nxn = shading.sNormalX;
  const nyn = shading.sNormalY;
  const nzn = shading.sNormalZ;

  // Orthonormal basis around the shading normal for the hemisphere kernel.
  // Reference axis flips away from the normal to keep the tangent well-defined.
  let rx = 0;
  let ry = 0;
  let rz = 1;
  if (Math.abs(nzn) >= 0.999) {
    rx = 1;
    rz = 0;
  }
  let tx = nyn * rz - nzn * ry;
  let ty = nzn * rx - nxn * rz;
  let tz = nxn * ry - nyn * rx;
  const tangentLength = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= tangentLength;
  ty /= tangentLength;
  tz /= tangentLength;
  let bx = nyn * tz - nzn * ty;
  let by = nzn * tx - nxn * tz;
  let bz = nxn * ty - nyn * tx;
  const bitangentLength = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
  bx /= bitangentLength;
  by /= bitangentLength;
  bz /= bitangentLength;

  _origin.set(shading.originX, shading.originY, shading.originZ);
  _normal.set(shading.gNormalX, shading.gNormalY, shading.gNormalZ);
  let occluded = 0;
  const rayStart = timings ? performance.now() : 0;
  for (let s = 0; s < samples; s += 1) {
    const kx = kernel[s * 3];
    const ky = kernel[s * 3 + 1];
    const kz = kernel[s * 3 + 2];
    // The kernel is unit length and (tangent, bitangent, normal) is an
    // orthonormal basis, so the transformed direction is already normalized 
    // the per-sample sqrt/divide is a no-op that costs a sqrt per sample.
    _direction.set(
      tx * kx + bx * ky + nxn * kz,
      ty * kx + by * ky + nyn * kz,
      tz * kx + bz * ky + nzn * kz,
    );
    if (castBakeRay(bvh, _origin, _normal, _direction, epsilon, 0, maxDistance)) occluded += 1;
  }
  if (timings) timings.rayMs += performance.now() - rayStart;
  return Math.round(((samples - occluded) / samples) * 255);
}

/**
 * Rasterizes the UV islands and records each covered texel's shading inputs for
 * the WebGPU occlusion pass instead of casting rays: `texelData` receives
 * `[rayOrigin.xyz, shadingNormal.xyz]` per texel (6 floats), where the ray
 * origin is the interpolated position offset along the geometric normal by
 * `epsilon` (self-intersection clearance, applied here so the shader only needs
 * the origin and the shading normal). `written` marks covered texels exactly as
 * `rasterizeAOBand` does; unwritten texels keep `texelData` at zero, which the
 * shader reads as "emit 255". The caller owns full-map arrays and should call
 * this over the whole map (`yStart: 0, yEnd: height`).
 */
export function rasterizeAOShading(
  written: Uint8Array,
  texelData: Float32Array,
  input: SerializedBakeScene,
  context: AOBandContext,
): void {
  const { width, height, yStart, yEnd, onRowsComplete } = context;
  const { vertices, triangleUVs, triangleVerts, epsilon } = input;
  rasterizeBakeBand(width, height, yStart, yEnd, triangleUVs, triangleVerts, written,
    (_px, _py, w0, w1, w2, index, _triangleIndex, uvOffset, _vertOffset, v0, v1, v2) => {
      const shading = computeAOTexelShading(vertices, v0, v1, v2, w0, w1, w2, input, uvOffset);
      const dataOffset = index * 6;
      texelData[dataOffset] = shading.originX + epsilon * shading.gNormalX;
      texelData[dataOffset + 1] = shading.originY + epsilon * shading.gNormalY;
      texelData[dataOffset + 2] = shading.originZ + epsilon * shading.gNormalZ;
      texelData[dataOffset + 3] = shading.sNormalX;
      texelData[dataOffset + 4] = shading.sNormalY;
      texelData[dataOffset + 5] = shading.sNormalZ;
    },
    onRowsComplete,
  );
}

/** Worker message: rasterize one row band. */
export type AOBandRequest = SerializedBakeScene & {
  type: 'band';
  jobId: number;
  width: number;
  height: number;
  yStart: number;
  yEnd: number;
};

/** Worker message: rows completed inside the band (cumulative). */
export type AOBandProgress = {
  type: 'progress';
  jobId: number;
  rowsDone: number;
};

/** Worker message: finished band  band-local factor + written slices. */
export type AOBandResult = {
  type: 'result';
  jobId: number;
  factors: Uint8ClampedArray;
  written: Uint8Array;
  /** Per-band CPU timings (ray / shading / rasterization), summed by the caller. */
  timings: AOBandTimings;
};

/** Worker message: the band failed to rasterize  the shared bake-worker
 * error wire shape (see `BakeWorkerError` in workerCommon). */
export type AOBandError = BakeWorkerError;
