import { buildLinearBVH } from './aoBvh';
import { dilateUVBake } from './bakeGeometry';
import { rasterizeAOShading, type SerializedBakeScene } from './aoRaster';
import { assertAsciiWgsl, getGpuDevice, uploadGpuBuffer, WGSL_BVH_TRAVERSAL } from './gpuCommon';

/**
 * WebGPU ambient-occlusion occlusion pass.
 *
 * The CPU rasterizer already computes per-texel barycentrics, interpolated
 * position, and the final shading normal. `rasterizeAOShading` records those
 * (with the epsilon offset applied) into a compact per-texel buffer instead of
 * ray-casting. This module uploads that buffer plus the occluder triangles and
 * a flat median-split BVH to a compute shader that runs the hemisphere
 * ray casting for every texel in parallel, then reads back the factor map and
 * dilates it exactly like the CPU path.
 *
 * Every failure mode (no `navigator.gpu`, adapter/device rejection, shader
 * error) throws so the caller falls back to the worker/CPU bake unchanged.
 */

/** Workgroup size; one invocation per texel. */
const WORKGROUP_SIZE = 256;

/* v8 ignore start */
const AO_WGSL = WGSL_BVH_TRAVERSAL + /* wgsl */ `
struct Uniforms {
  near: f32,
  far: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(3) var<storage, read> texelData: array<f32>;
@group(0) @binding(4) var<storage, read> kernel: array<f32>;
@group(0) @binding(5) var<storage, read_write> output: array<f32>;
@group(0) @binding(6) var<uniform> u: Uniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let texel = gid.x;
  if (texel >= arrayLength(&output)) { return; }

  let db = texel * 6u;
  let n = vec3<f32>(texelData[db + 3u], texelData[db + 4u], texelData[db + 5u]);
  let nlen = dot(n, n);
  if (nlen < 1e-6) {
    // Unwritten texel: keep the bright background fill.
    output[texel] = 255.0;
    return;
  }
  let o = vec3<f32>(texelData[db], texelData[db + 1u], texelData[db + 2u]);
  let normal = n / sqrt(nlen);

  // Orthonormal basis around the shading normal (mirrors shadeAOTexel).
  var refAxis = vec3<f32>(0.0, 0.0, 1.0);
  if (abs(normal.z) >= 0.999) {
    refAxis = vec3<f32>(1.0, 0.0, 0.0);
  }
  let tangent = normalize(cross(normal, refAxis));
  let bitangent = normalize(cross(normal, tangent));

  let sampleCount = arrayLength(&kernel) / 3u;
  var occluded = 0u;
  for (var s = 0u; s < sampleCount; s = s + 1u) {
    let kb = s * 3u;
    let dir = tangent * kernel[kb] + bitangent * kernel[kb + 1u] + normal * kernel[kb + 2u];
    if (anyHit(o, dir, u.near, u.far)) {
      occluded = occluded + 1u;
    }
  }
  output[texel] = f32(sampleCount - occluded) * 255.0 / f32(sampleCount);
}
`;
assertAsciiWgsl(AO_WGSL, 'AO');
/* v8 ignore stop */



/**
 * Bakes the AO factor map on the GPU. Returns the same `Uint8ClampedArray`
 * shape as the CPU/worker path (255 = unoccluded). Throws when WebGPU is
 * unavailable, the scene has no occluders, or any GPU step fails — the caller
 * treats any throw as "fall back to the CPU/worker path".
 */
export async function bakeAOWithGpu(
  input: SerializedBakeScene,
  width: number,
  height: number,
  onProgress?: (percent: number) => void,
): Promise<Uint8ClampedArray> {
  const triangleCount = Math.floor(input.occluderPositions.length / 9);
  const texelCount = width * height;
  if (triangleCount === 0) {
    throw new Error('AO bake has no occluders to test.');
  }

  /* v8 ignore start */
  // Rasterize the UV islands and record per-texel shading on the main thread
  // (fast); the GPU only runs the expensive hemisphere ray casting.
  const factors = new Uint8ClampedArray(texelCount).fill(255);
  const written = new Uint8Array(texelCount);
  const texelData = new Float32Array(texelCount * 6);
  rasterizeAOShading(written, texelData, input, {
    width,
    height,
    yStart: 0,
    yEnd: height,
    onRowsComplete: (rows) => onProgress?.(Math.round((rows / height) * 100)),
  });

  const bvh = buildLinearBVH(input.occluderPositions);
  const kernel = Float32Array.from(input.kernel); // f64 -> f32 for the shader.

  // One device per session, shared with the lightmap bake (see getGpuDevice in
  // gpuCommon.ts) — the ~100ms device request is paid once, so the GPU runs
  // unconditionally with no map-size threshold.
  const device = await getGpuDevice();

  try {
    const bvhBoundsBuffer = uploadGpuBuffer(device, bvh.bounds, GPUBufferUsage.STORAGE);
    const bvhLinksBuffer = uploadGpuBuffer(device, bvh.links, GPUBufferUsage.STORAGE);
    const trianglesBuffer = uploadGpuBuffer(device, bvh.triangles, GPUBufferUsage.STORAGE);
    const texelDataBuffer = uploadGpuBuffer(device, texelData, GPUBufferUsage.STORAGE);
    const kernelBuffer = uploadGpuBuffer(device, kernel, GPUBufferUsage.STORAGE);
    const uniformBuffer = uploadGpuBuffer(device, new Float32Array([0, input.maxDistance, 0, 0]), GPUBufferUsage.UNIFORM);
    const outputBuffer = device.createBuffer({ size: texelCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readbackBuffer = device.createBuffer({ size: texelCount * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: bvhBoundsBuffer } },
        { binding: 1, resource: { buffer: bvhLinksBuffer } },
        { binding: 2, resource: { buffer: trianglesBuffer } },
        { binding: 3, resource: { buffer: texelDataBuffer } },
        { binding: 4, resource: { buffer: kernelBuffer } },
        { binding: 5, resource: { buffer: outputBuffer } },
        { binding: 6, resource: { buffer: uniformBuffer } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: AO_WGSL });
    const compilationInfo = await shaderModule.getCompilationInfo();
    const compileErrors = compilationInfo.messages.filter((message) => message.type === 'error');
    if (compileErrors.length > 0) {
      const first = compileErrors[0];
      const at = first.lineNum !== 0 ? ` (line ${first.lineNum}, column ${first.linePos})` : '';
      throw new Error(`AO WGSL compile error: ${first.message}${at}`);
    }

    device.pushErrorScope('validation');
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const pipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module: shaderModule, entryPoint: 'main' } });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(texelCount / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, texelCount * 4);
    device.queue.submit([encoder.finish()]);
    const validationError = await device.popErrorScope();
    if (validationError) {
      throw new Error(`AO WebGPU validation error: ${validationError.message}`);
    }

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const mapped = new Float32Array(readbackBuffer.getMappedRange());
    for (let i = 0; i < texelCount; i += 1) {
      factors[i] = Math.round(mapped[i]);
    }
    readbackBuffer.unmap();

    onProgress?.(100);
    dilateUVBake(factors, written, width, height, 1);
    return factors;
  } finally {
    // The device is cached and shared across bakes (getGpuDevice) — destroying
    // it here would force every subsequent bake to re-request one.
  }
  /* v8 ignore stop */
}
