import { buildLinearBVH } from './aoBvh';
import { assertAsciiWgsl, getGpuDevice, uploadGpuBuffer, WGSL_BVH_TRAVERSAL } from './gpuCommon';
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

/** Workgroup size; one invocation per vertex. */
const WORKGROUP_SIZE = 256;
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

@compute @workgroup_size(256)
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
 * by vertex id — the same shape `rasterizeLightmap` interpolates. Throws when
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
  // gpuCommon.ts) — the ~100ms device request is paid once, so the GPU runs
  // unconditionally with no vertex-count threshold.
  const device = await getGpuDevice();

  try {
    const bvhBoundsBuffer = uploadGpuBuffer(device, bvh.bounds, GPUBufferUsage.STORAGE);
    const bvhLinksBuffer = uploadGpuBuffer(device, bvh.links, GPUBufferUsage.STORAGE);
    const trianglesBuffer = uploadGpuBuffer(device, bvh.triangles, GPUBufferUsage.STORAGE);
    const verticesBuffer = uploadGpuBuffer(device, input.vertices, GPUBufferUsage.STORAGE);
    const uniformBuffer = uploadGpuBuffer(device, new Float32Array([
      input.epsilon, SUN_FAR, sunScale, 0,
      sunDirection[0], sunDirection[1], sunDirection[2], 0,
    ]), GPUBufferUsage.UNIFORM);
    const outputBuffer = device.createBuffer({ size: vertexCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readbackBuffer = device.createBuffer({ size: vertexCount * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: bvhBoundsBuffer } },
        { binding: 1, resource: { buffer: bvhLinksBuffer } },
        { binding: 2, resource: { buffer: trianglesBuffer } },
        { binding: 3, resource: { buffer: verticesBuffer } },
        { binding: 4, resource: { buffer: outputBuffer } },
        { binding: 5, resource: { buffer: uniformBuffer } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: LIGHTMAP_WGSL });
    const compilationInfo = await shaderModule.getCompilationInfo();
    const compileErrors = compilationInfo.messages.filter((message) => message.type === 'error');
    if (compileErrors.length > 0) {
      const first = compileErrors[0];
      const at = first.lineNum !== 0 ? ` (line ${first.lineNum}, column ${first.linePos})` : '';
      throw new Error(`Lightmap WGSL compile error: ${first.message}${at}`);
    }

    device.pushErrorScope('validation');
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const pipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module: shaderModule, entryPoint: 'main' } });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(vertexCount / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, vertexCount * 4);
    device.queue.submit([encoder.finish()]);
    const validationError = await device.popErrorScope();
    if (validationError) {
      throw new Error(`Lightmap WebGPU validation error: ${validationError.message}`);
    }

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const visibility = new Float32Array(vertexCount);
    visibility.set(new Float32Array(readbackBuffer.getMappedRange()));
    readbackBuffer.unmap();
    return visibility;
  } finally {
    // The device is cached and shared across bakes (getGpuDevice) — destroying
    // it here would force every subsequent bake to re-request one.
  }
  /* v8 ignore stop */
}
