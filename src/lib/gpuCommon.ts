/**
 * Shared WebGPU helpers for the AO and lightmap bake shaders.
 *
 * The AO hemisphere cast and the lightmap sun-visibility cast traverse the same
 * flat median-split BVH (`src/lib/aoBvh.ts`) with the same slab test and
 * Moller-Trumbore triangle test; only the ray bounds differ (AO: [0, maxDistance],
 * lightmap sun: [epsilon, ~Infinity]). This module holds the traversal WGSL plus
 * the buffer-upload helper so neither shader duplicates them.
 */

/** Shared WGSL: flat-BVH slab test + double-sided Moller-Trumbore + stack
 * traversal. Bindings 0-2 are reserved for the BVH (bounds / links / triangles);
 * callers declare their own storage bindings (3+) and uniform. The near/far ray
 * bounds are passed per call so each caller controls its own interval. */
export const WGSL_BVH_TRAVERSAL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> bvhBounds: array<f32>;
@group(0) @binding(1) var<storage, read> bvhLinks: array<u32>;
@group(0) @binding(2) var<storage, read> triangles: array<f32>;

// Slab test over the ray's [near, far] interval. Near-parallel axes are
// handled explicitly to avoid 0 * Infinity => NaN.
fn intersectsBox(o: vec3<f32>, d: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>, near: f32, far: f32) -> bool {
  var tNear = near;
  var tFar = far;

  if (abs(d.x) < 1e-12) {
    if (o.x < bmin.x || o.x > bmax.x) { return false; }
  } else {
    let inv = 1.0 / d.x;
    let t1 = min((bmin.x - o.x) * inv, (bmax.x - o.x) * inv);
    let t2 = max((bmin.x - o.x) * inv, (bmax.x - o.x) * inv);
    if (t1 > tNear) { tNear = t1; }
    if (t2 < tFar) { tFar = t2; }
    if (tNear > tFar) { return false; }
  }

  if (abs(d.y) < 1e-12) {
    if (o.y < bmin.y || o.y > bmax.y) { return false; }
  } else {
    let inv = 1.0 / d.y;
    let t1 = min((bmin.y - o.y) * inv, (bmax.y - o.y) * inv);
    let t2 = max((bmin.y - o.y) * inv, (bmax.y - o.y) * inv);
    if (t1 > tNear) { tNear = t1; }
    if (t2 < tFar) { tFar = t2; }
    if (tNear > tFar) { return false; }
  }

  if (abs(d.z) < 1e-12) {
    if (o.z < bmin.z || o.z > bmax.z) { return false; }
  } else {
    let inv = 1.0 / d.z;
    let t1 = min((bmin.z - o.z) * inv, (bmax.z - o.z) * inv);
    let t2 = max((bmin.z - o.z) * inv, (bmax.z - o.z) * inv);
    if (t1 > tNear) { tNear = t1; }
    if (t2 < tFar) { tFar = t2; }
    if (tNear > tFar) { return false; }
  }

  return true;
}

// Moller-Trumbore, double-sided. Returns true for a forward hit within
// [near, far].
fn intersectTriangle(o: vec3<f32>, d: vec3<f32>, v0: vec3<f32>, v1: vec3<f32>, v2: vec3<f32>, near: f32, far: f32) -> bool {
  let edge1 = v1 - v0;
  let edge2 = v2 - v0;
  let h = cross(d, edge2);
  let a = dot(edge1, h);
  if (abs(a) < 1e-9) { return false; }
  let f = 1.0 / a;
  let s = o - v0;
  let b1 = f * dot(s, h);
  if (b1 < 0.0 || b1 > 1.0) { return false; }
  let q = cross(s, edge1);
  let b2 = f * dot(d, q);
  if (b2 < 0.0 || b1 + b2 > 1.0) { return false; }
  let t = f * dot(edge2, q);
  return t >= near && t <= far;
}

// Stack-based depth-first traversal of the flat BVH. The tree is balanced
// (median split), so a 64-entry stack is far more than the depth needs; the
// overflow guard just bails (miss) rather than corrupt the stack.
fn anyHit(o: vec3<f32>, d: vec3<f32>, near: f32, far: f32) -> bool {
  var stack: array<u32, 64>;
  var sp: u32 = 0u;
  stack[sp] = 0u;
  sp = sp + 1u;
  while (sp > 0u) {
    sp = sp - 1u;
    let node = stack[sp];
    let base = node * 6u;
    let bmin = vec3<f32>(bvhBounds[base], bvhBounds[base + 1u], bvhBounds[base + 2u]);
    let bmax = vec3<f32>(bvhBounds[base + 3u], bvhBounds[base + 4u], bvhBounds[base + 5u]);
    if (!intersectsBox(o, d, bmin, bmax, near, far)) { continue; }
    let linkBase = node * 2u;
    let leftFirst = bvhLinks[linkBase];
    let count = bvhLinks[linkBase + 1u];
    if (count == 0u) {
      if (sp + 2u > 64u) { continue; }
      stack[sp] = leftFirst;
      sp = sp + 1u;
      stack[sp] = node + 1u;
      sp = sp + 1u;
    } else {
      for (var i = 0u; i < count; i = i + 1u) {
        let t = leftFirst + i;
        let tb = t * 9u;
        let v0 = vec3<f32>(triangles[tb], triangles[tb + 1u], triangles[tb + 2u]);
        let v1 = vec3<f32>(triangles[tb + 3u], triangles[tb + 4u], triangles[tb + 5u]);
        let v2 = vec3<f32>(triangles[tb + 6u], triangles[tb + 7u], triangles[tb + 8u]);
        if (intersectTriangle(o, d, v0, v1, v2, near, far)) { return true; }
      }
    }
  }
  return false;
}
`;

/* v8 ignore start */
/** WGSL shader sources must be pure ASCII: some WebGPU compilers (Tint) reject
 * non-ASCII bytes even inside comments, surfacing as a cryptic "invalid
 * character found" driver error. This guard runs at module load so a bad edit
 * fails loudly with the exact character and line instead of a silent GPU->CPU
 * fallback. */
export function assertAsciiWgsl(code: string, label: string): void {
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) > 127) {
      const line = code.slice(0, i).split('\n').length;
      throw new Error(
        `${label} WGSL contains non-ASCII character U+${code.charCodeAt(i).toString(16).toUpperCase()} ` +
        `at line ${line}; WGSL shader sources must be pure ASCII.`,
      );
    }
  }
}

assertAsciiWgsl(WGSL_BVH_TRAVERSAL, 'BVH traversal');
/** Uploads `data` into a fresh buffer with `usage | COPY_DST` (writeBuffer needs
 * COPY_DST) and returns it. */
function uploadGpuBuffer(device: GPUDevice, data: ArrayBufferView | ArrayBuffer, usage: number): GPUBuffer {
  const buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/** One WebGPU device per session, shared by the AO and lightmap GPU bakes.
 * requestAdapter/requestDevice is the expensive part (~100ms), so reuse the
 * device instead of re-requesting per bake. That makes the GPU path cheap even
 * for tiny scenes, which is what lets the bakes run on the GPU unconditionally
 * (no mesh/map-size threshold). A lost device (driver reset / GPU hang) drops
 * the cache so the next bake re-requests; a failed request also resets it so a
 * transient failure can recover. */
let sharedDevicePromise: Promise<GPUDevice> | null = null;
export function getGpuDevice(): Promise<GPUDevice> {
  const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined;
  if (!gpu) throw new Error('WebGPU is unavailable in this context.');
  if (!sharedDevicePromise) {
    sharedDevicePromise = (async () => {
      try {
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('WebGPU adapter unavailable.');
        const device = await adapter.requestDevice();
        device.lost.then((info) => {
          if (info.reason !== 'destroyed') sharedDevicePromise = null;
        });
        return device;
      } catch (error) {
        sharedDevicePromise = null;
        throw error;
      }
    })();
  }
  return sharedDevicePromise;
}

/** One binding slot for `runComputePass`, listed in WGSL binding order
 * (0, 1, 2, ...). `data` uploads a fresh buffer (read-only-storage by
 * default); `buffer` binds an existing buffer; exactly one `{ output: true }`
 * entry creates the read-write storage buffer the shader writes. */
export type ComputePassBinding =
  | { data: ArrayBufferView | ArrayBuffer; usage?: number; type?: 'read-only-storage' | 'uniform' }
  | { buffer: GPUBuffer; type?: 'read-only-storage' | 'storage' | 'uniform' }
  | { output: true };

/** Spec for `runComputePass`. */
export type ComputePassSpec = {
  device: GPUDevice;
  shader: string;
  /** Prefix for the error messages thrown on shader compile / validation
   * failure: `${label} WGSL compile error` / `${label} WebGPU validation error`. */
  label: string;
  /** Bindings in WGSL slot order. `data` entries are uploaded into fresh
   * buffers; `buffer` entries bind an existing buffer; exactly one
   * `{ output: true }` entry creates the read-write storage output. */
  bindings: ComputePassBinding[];
  /** Number of invocations: workgroups = ceil(count / workgroupSize) and the
   * output buffer holds `count` f32s. */
  count: number;
  /** Workgroup size — MUST match the shader's `@workgroup_size` (a mismatch
   * silently under-dispatches and leaves trailing elements unwritten). */
  workgroupSize?: number;
};

/** Runs one full WebGPU compute pass and returns the output as a fresh
 * `Float32Array` of `count` f32s: uploads the data bindings, creates the
 * bind-group layout + group, compiles the shader (throwing `${label} WGSL
 * compile error` on failure), dispatches under a validation error scope
 * (throwing `${label} WebGPU validation error` on failure), and maps the
 * output back. Every failure throws so callers fall back to their CPU/worker
 * path unchanged. */
export async function runComputePass(spec: ComputePassSpec): Promise<Float32Array> {
  const { device, shader, label, bindings, count, workgroupSize = 256 } = spec;

  const layoutEntries: GPUBindGroupLayoutEntry[] = [];
  const groupEntries: GPUBindGroupEntry[] = [];
  let outputBuffer: GPUBuffer | null = null;

  bindings.forEach((binding, slot) => {
    let buffer: GPUBuffer;
    let type: 'read-only-storage' | 'storage' | 'uniform';
    if ('output' in binding) {
      buffer = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      type = 'storage';
      outputBuffer = buffer;
    } else if ('buffer' in binding) {
      buffer = binding.buffer;
      type = binding.type ?? 'read-only-storage';
    } else {
      buffer = uploadGpuBuffer(device, binding.data, binding.usage ?? GPUBufferUsage.STORAGE);
      type = binding.type ?? 'read-only-storage';
    }
    layoutEntries.push({ binding: slot, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    groupEntries.push({ binding: slot, resource: { buffer } });
  });
  if (!outputBuffer) throw new Error(`${label} compute pass has no output binding.`);

  const readbackBuffer = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries });
  const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries: groupEntries });

  const shaderModule = device.createShaderModule({ code: shader });
  const compilationInfo = await shaderModule.getCompilationInfo();
  const compileErrors = compilationInfo.messages.filter((message) => message.type === 'error');
  if (compileErrors.length > 0) {
    const first = compileErrors[0];
    const at = first.lineNum !== 0 ? ` (line ${first.lineNum}, column ${first.linePos})` : '';
    throw new Error(`${label} WGSL compile error: ${first.message}${at}`);
  }

  device.pushErrorScope('validation');
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module: shaderModule, entryPoint: 'main' } });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(count / workgroupSize));
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, count * 4);
  device.queue.submit([encoder.finish()]);
  const validationError = await device.popErrorScope();
  if (validationError) {
    throw new Error(`${label} WebGPU validation error: ${validationError.message}`);
  }

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  // Copy out before unmapping: the mapped view detaches on unmap.
  const result = new Float32Array(new Float32Array(readbackBuffer.getMappedRange()));
  readbackBuffer.unmap();
  return result;
}
/* v8 ignore stop */
