import type { MeshBVH } from 'three-mesh-bvh';
import { Vector3 } from 'three';
import { castBakeRay, type BakeScene } from './bakeGeometry';

/**
 * Symmetric cosine-weighted hemisphere kernel for AO sampling, flattened to
 * three floats per sample. Odd counts round up for paired symmetry — each pair
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
  /** Occlusion reach — rays longer than this are treated as unoccluded. */
  maxDistance: number;
  /** Flat hemisphere kernel, 3 floats per sample. */
  kernel: Float64Array;
  samples: number;
};

/**
 * Copies a collected bake scene into the transferable flat layout the band
 * rasterizer (and the workers) consume. The kernel is built here so every band
 * and every worker shares byte-identical sample directions.
 */
export function serializeBakeScene(scene: BakeScene, samples: number): SerializedBakeScene {
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
    occluderPositions,
    epsilon,
    maxDistance,
    kernel: symmetricHemisphereKernel(samples),
    samples,
  };
}

/** Row-band description for a rasterization slice. */
export type AOBandContext = {
  width: number;
  height: number;
  yStart: number;
  yEnd: number;
  /** Invoked with the cumulative rows completed inside this band, for progress reporting. */
  onRowsComplete?: (rows: number) => void;
};

const _origin = new Vector3();
const _normal = new Vector3();
const _direction = new Vector3();

/**
 * Rasterizes the UV islands into the `[yStart, yEnd)` row band, writing the AO
 * factor (255 = bright/unoccluded, 0 = dark/occluded) and the written mask for
 * every covered texel. `factors` and `written` hold exactly
 * `(yEnd - yStart) × width` texels — the caller owns the full-map assembly and
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
  const { width, height, yStart, yEnd, onRowsComplete } = context;
  const { vertices, triangleUVs, triangleVerts, kernel, samples, epsilon, maxDistance } = input;
  const triangleCount = triangleVerts.length / 3;
  const bandHeight = yEnd - yStart;
  const reportEvery = Math.max(1, Math.floor(bandHeight / 128));
  let rowsDone = 0;

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const uvOffset = triangleIndex * 6;
    const ax = triangleUVs[uvOffset] * width;
    const ay = (1 - triangleUVs[uvOffset + 1]) * height;
    const bx = triangleUVs[uvOffset + 2] * width;
    const by = (1 - triangleUVs[uvOffset + 3]) * height;
    const cx = triangleUVs[uvOffset + 4] * width;
    const cy = (1 - triangleUVs[uvOffset + 5]) * height;

    // Clip the triangle's UV bbox to both the canvas and this row band.
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(yStart, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(yEnd - 1, Math.ceil(Math.max(ay, by, cy)));
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (denominator === 0) continue;

    const vertOffset = triangleIndex * 3;
    const v0 = triangleVerts[vertOffset] * 6;
    const v1 = triangleVerts[vertOffset + 1] * 6;
    const v2 = triangleVerts[vertOffset + 2] * 6;

    for (let py = minY; py <= maxY; py += 1) {
      const rowOffset = (py - yStart) * width;
      for (let px = minX; px <= maxX; px += 1) {
        const x = px + 0.5;
        const y = py + 0.5;
        const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const index = rowOffset + px;
        written[index] = 1;
        factors[index] = shadeAOTexel(vertices, v0, v1, v2, w0, w1, w2, kernel, samples, bvh, epsilon, maxDistance);
      }
      rowsDone += 1;
      if (onRowsComplete && rowsDone % reportEvery === 0) onRowsComplete(rowsDone);
    }
  }
  if (onRowsComplete) onRowsComplete(rowsDone);
}

/**
 * One texel of hemisphere occlusion. Interpolates the world-space sample origin
 * and the smooth shading normal from the triangle's vertices, builds an
 * orthonormal tangent basis around that normal, and counts kernel directions
 * that hit the occluder BVH. Returns the 0–255 visibility factor.
 */
function shadeAOTexel(
  vertices: Float32Array,
  v0: number,
  v1: number,
  v2: number,
  w0: number,
  w1: number,
  w2: number,
  kernel: Float32Array,
  samples: number,
  bvh: MeshBVH,
  epsilon: number,
  maxDistance: number,
): number {
  const ox = w0 * vertices[v0] + w1 * vertices[v1] + w2 * vertices[v2];
  const oy = w0 * vertices[v0 + 1] + w1 * vertices[v1 + 1] + w2 * vertices[v2 + 1];
  const oz = w0 * vertices[v0 + 2] + w1 * vertices[v1 + 2] + w2 * vertices[v2 + 2];
  const nx = w0 * vertices[v0 + 3] + w1 * vertices[v1 + 3] + w2 * vertices[v2 + 3];
  const ny = w0 * vertices[v0 + 4] + w1 * vertices[v1 + 4] + w2 * vertices[v2 + 4];
  const nz = w0 * vertices[v0 + 5] + w1 * vertices[v1 + 5] + w2 * vertices[v2 + 5];
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  const nxn = nx / length;
  const nyn = ny / length;
  const nzn = nz / length;

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

  _origin.set(ox, oy, oz);
  _normal.set(nxn, nyn, nzn);
  let occluded = 0;
  for (let s = 0; s < samples; s += 1) {
    const kx = kernel[s * 3];
    const ky = kernel[s * 3 + 1];
    const kz = kernel[s * 3 + 2];
    const dx = tx * kx + bx * ky + nxn * kz;
    const dy = ty * kx + by * ky + nyn * kz;
    const dz = tz * kx + bz * ky + nzn * kz;
    const directionLength = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    _direction.set(dx / directionLength, dy / directionLength, dz / directionLength);
    if (castBakeRay(bvh, _origin, _normal, _direction, epsilon, 0, maxDistance)) occluded += 1;
  }
  return Math.round(((samples - occluded) / samples) * 255);
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

/** Worker message: finished band — band-local factor + written slices. */
export type AOBandResult = {
  type: 'result';
  jobId: number;
  factors: Uint8ClampedArray;
  written: Uint8Array;
};

/** Worker message: the band failed to rasterize. */
export type AOBandError = {
  type: 'error';
  jobId: number;
  message: string;
};
