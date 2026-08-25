import { buildLinearBVH } from './aoBvh';
import { assertAsciiWgsl, COMPUTE_WORKGROUP_SIZE, getGpuDevice, runComputePass, uniformBinding, WGSL_BVH_TRAVERSAL } from './gpuCommon';
import type { SerializedBakeScene } from './aoRaster';

/**
 * WebGPU sun-visibility pass for the lightmap bake.
 *
 * The lightmap's only ray casting is a per-vertex binary occluder test toward
 * the sun (see `castBakeRay` in `bakeGeometry.ts`): each baked vertex casts one
 * ray from `position + epsilon * normal` toward the sun with `near = epsilon`
 * and `far = Infinity`, and the result (lit/shadowed) is interpolated per texel
 * by the CPU raster pass. This module runs that per-vertex test in a compute
 * shader over the same flat BVH the AO bake traverses, then hands the CPU the
 * 0/1 visibility array to feed its (cheap) per-texel lighting pass.
 *
 * Every failure mode (no `navigator.gpu`, adapter/device rejection, shader
 * error) throws so the caller falls back to the CPU/worker visibility test.
 */

// The workgroup size is shared with the AO shader (COMPUTE_WORKGROUP_SIZE in
// gpuCommon.ts) so the dispatch and both shaders stay in lockstep.
/** The CPU uses `far = Infinity`; a finite f32 far beyond any real scene scale
 * is equivalent for the slab + triangle bounds checks. */
const SUN_FAR = 1e30;

/* v8 ignore start */
const LIGHTMAP_WGSL = WGSL_BVH_TRAVERSAL + /* wgsl */ `
struct LightmapUniforms {
  near: f32,
  far: f32,
  sunScale: f32,
  _pad0: f32,
  sunDirX: f32,
  sunDirY: f32,
  sunDirZ: f32,
  _pad1: f32,
};

@group(0) @binding(3) var<storage, read> vertices: array<f32>;
@group(0) @binding(4) var<storage, read_write> output: array<f32>;
@group(0) @binding(5) var<uniform> u: LightmapUniforms;

@compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let vi = gid.x;
  if (vi >= arrayLength(&output)) { return; }
  let base = vi * 6u;
  let p = vec3<f32>(vertices[base], vertices[base + 1u], vertices[base + 2u]);
  let n = vec3<f32>(vertices[base + 3u], vertices[base + 4u], vertices[base + 5u]);
  let sunDir = vec3<f32>(u.sunDirX, u.sunDirY, u.sunDirZ);
  // Lambert gate: only surface points facing the sun receive sun light, and a
  // non-positive sun intensity disables the sun term entirely.
  if (u.sunScale <= 0.0 || dot(n, sunDir) <= 0.0) {
    output[vi] = 0.0;
    return;
  }
  // Offset the origin off the surface (epsilon) and reject hits closer than
  // epsilon: mirrors castBakeRay(bvh, pos, normal, towardSun, epsilon, epsilon).
  let o = p + u.near * n;
  // select(f, t, cond) returns t when cond is true. The ?: ternary is rejected
  // by some WGSL grammars ("invalid character found"); select() works everywhere.
  output[vi] = select(1.0, 0.0, anyHit(o, sunDir, u.near, u.far));
}
`;
assertAsciiWgsl(LIGHTMAP_WGSL, 'Lightmap');
/* v8 ignore stop */

/**
 * Computes the per-vertex sun visibility on the GPU and returns a
 * `Float32Array` of 0 (shadowed / unlit) or 1 (lit) per baked vertex, indexed
 * by vertex id  the same shape `rasterizeLightmap` interpolates. Throws when
 * WebGPU is unavailable, the scene has no vertices, or any GPU step fails.
 */
export async function computeSunVisibilityGpu(
  input: SerializedBakeScene,
  sunDirection: [number, number, number],
  sunScale: number,
): Promise<Float32Array> {
  const vertexCount = Math.floor(input.vertices.length / 6);
  if (vertexCount === 0) {
    throw new Error('Lightmap bake has no vertices to test.');
  }

  /* v8 ignore start */
  const bvh = buildLinearBVH(input.occluderPositions);

  // One device per session, shared with the AO bake (see getGpuDevice in
  // gpuCommon.ts)  the ~100ms device request is paid once, so the GPU runs
  // unconditionally with no vertex-count threshold. The device is never
  // destroyed here: it stays cached for every subsequent bake.
  return runComputePass({
    device: await getGpuDevice(),
    shader: LIGHTMAP_WGSL,
    label: 'Lightmap',
    bindings: [
      { data: bvh.bounds },
      { data: bvh.links },
      { data: bvh.triangles },
      { data: input.vertices },
      { output: true },
      uniformBinding(
        input.epsilon, SUN_FAR, sunScale, 0,
        sunDirection[0], sunDirection[1], sunDirection[2], 0,
      ),
    ],
    count: vertexCount,
    workgroupSize: COMPUTE_WORKGROUP_SIZE,
  });
  /* v8 ignore stop */
}
