import { processImageData, type ProcessOptions } from './dither';
import { assertAsciiWgsl, getGpuDevice } from './gpuCommon';
import { LUMA } from './math';
import { hexToRgb } from './palettes';

/**
 * WebGPU dither pass for the seamless error-diffusion modes (floyd/atkinson).
 *
 * Error diffusion is a serial chain: each pixel needs the pixel to its left
 * (7/16) and the rows above, and the O(palette) nearest-color match sits
 * inside that chain. WebGPU workgroups have no execution-order guarantees, so
 * the exact algorithm cannot be naively parallelized across pixels. Instead
 * this module runs a software pipeline:
 *
 *   - Prepass (parallel): tone-adjust the source into the 3w x 2h virtual
 *     grid work buffer (one thread per grid cell).
 *   - Diffusion: dispatched in waves of ROWS_PER_WAVE grid rows, ONE workgroup
 *     per wave (co-resident threads, so the spin-wait can always progress).
 *     Each thread owns one grid row and scans it left-to-right in the CPU's
 *     exact order. A row waits, via atomic spin-flags in global storage, for
 *     the row(s) above to be a few columns ahead, so every work cell is fully
 *     accumulated (adjusted value, then error arrivals in scan order) before
 *     it is read - the same accumulation order as the CPU Float32Array loop.
 *
 * The output is algorithmically identical to `streamDitherSeamless`; the only
 * divergence is f32 (shader) vs f64 (JS) rounding in the palette distance and
 * the spread accumulation, so the bytes differ in the last ulp and the image
 * is visually identical. The CPU linear scan remains the byte-identical
 * fallback truth.
 *
 * Every failure mode (no navigator.gpu, adapter/device rejection, shader
 * compile, validation) throws, so callers fall back to the CPU path unchanged
 * - the same contract as the AO/lightmap GPU bakes.
 */

/** Grid rows processed per diffusion wave. One workgroup per wave; threads are
 * co-resident, which is what makes the spin-wait safe (a waiting thread is
 * never parked while its producer is in the same workgroup). */
const ROWS_PER_WAVE = 128;
const PREPASS_WORKGROUP = 256;
/** Flag granularity for the pipeline: columns per flag block. Finer blocks
 * shorten the inter-row lag; coarser blocks shrink the flags buffer. */
const BLOCK_LOG2 = 5;

/* v8 ignore start */
const DITHER_WGSL = /* wgsl */ `
struct Uniforms {
  gridWidth: u32,
  gridHeight: u32,
  width: u32,
  height: u32,
  paletteCount: u32,
  atkinson: u32,
  blockLog2: u32,
  blocksPerRow: u32,
  strength: f32,
  brightnessOffset: f32,
  contrastFactor: f32,
  saturationFactor: f32,
  wr: f32,
  wg: f32,
  wb: f32,
  pad0: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> source: array<u32>;
@group(0) @binding(2) var<storage, read> palette: array<f32>;
@group(0) @binding(3) var<storage, read_write> work: array<f32>;
@group(0) @binding(4) var<storage, read_write> flags: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> output: array<u32>;

fn addSpread(row: u32, col: u32, er: f32, eg: f32, eb: f32, factor: f32) {
  let w = (row * u.gridWidth + col) * 3u;
  work[w] = work[w] + er * factor * u.strength;
  work[w + 1u] = work[w + 1u] + eg * factor * u.strength;
  work[w + 2u] = work[w + 2u] + eb * factor * u.strength;
}

fn setFlag(row: u32, col: u32) {
  var block = col >> u.blockLog2;
  if (block >= u.blocksPerRow) {
    block = u.blocksPerRow - 1u;
  }
  atomicStore(&flags[row * u.blocksPerRow + block], 1u);
}

// Spins until the given row has processed the given column (clamped to its
// last flag block). The producer thread is in the same workgroup a few
// columns ahead, so the spin always progresses; the atomic flag also orders
// the producer's work-buffer writes before this thread reads them.
fn waitFor(row: u32, col: u32) {
  var block = (col + 1u) >> u.blockLog2;
  if (block >= u.blocksPerRow) {
    block = u.blocksPerRow - 1u;
  }
  let fi = row * u.blocksPerRow + block;
  loop {
    if (atomicLoad(&flags[fi]) != 0u) {
      break;
    }
  }
}

// Pass 1: tone-adjust the source into every grid cell (parallel, no deps).
// Mirrors streamDitherSeamless's initRow: brightness/contrast/saturation
// applied per channel, then the LUMA-weighted saturation blend, clamped.
@compute @workgroup_size(${PREPASS_WORKGROUP})
fn prepass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let cellCount = arrayLength(&work) / 3u;
  if (idx >= cellCount) {
    return;
  }
  let py = idx / u.gridWidth;
  let px = idx % u.gridWidth;
  let sy = py % u.height;
  let sx = px % u.width;
  let p = source[sy * u.width + sx];
  let r0 = f32(p & 255u);
  let g0 = f32((p >> 8u) & 255u);
  let b0 = f32((p >> 16u) & 255u);
  var ar = u.contrastFactor * (r0 - 128.0) + 128.0 + u.brightnessOffset;
  var ag = u.contrastFactor * (g0 - 128.0) + 128.0 + u.brightnessOffset;
  var ab = u.contrastFactor * (b0 - 128.0) + 128.0 + u.brightnessOffset;
  let gray = ar * u.wr + ag * u.wg + ab * u.wb;
  ar = clamp(gray + (ar - gray) * u.saturationFactor, 0.0, 255.0);
  ag = clamp(gray + (ag - gray) * u.saturationFactor, 0.0, 255.0);
  ab = clamp(gray + (ab - gray) * u.saturationFactor, 0.0, 255.0);
  let w = idx * 3u;
  work[w] = ar;
  work[w + 1u] = ag;
  work[w + 2u] = ab;
}

// Pass 2: software-pipelined error diffusion. One thread per grid row; the
// row scan reproduces streamDitherSeamless exactly (same match tie rule,
// same spread weights, edges dropped), with rows lagging the row above by one
// flag block.
@compute @workgroup_size(1, ${ROWS_PER_WAVE})
fn diffuse(@builtin(global_invocation_id) gid: vec3<u32>) {
  let py = gid.x * ${ROWS_PER_WAVE}u + gid.y;
  if (py >= u.gridHeight) {
    return;
  }
  let rowBase = py * u.gridWidth * 3u;
  let blockMask = (1u << u.blockLog2) - 1u;
  for (var px = 0u; px < u.gridWidth; px = px + 1u) {
    if (py >= 1u) {
      waitFor(py - 1u, px);
    }
    if (u.atkinson == 1u) {
      if (py >= 2u) {
        waitFor(py - 2u, px);
      }
    }
    let w = rowBase + px * 3u;
    let r = work[w];
    let g = work[w + 1u];
    let b = work[w + 2u];
    var best = 0u;
    var bestD = 1e30;
    for (var i = 0u; i < u.paletteCount; i = i + 1u) {
      let pb = i * 3u;
      let dr = r - palette[pb];
      let dg = g - palette[pb + 1u];
      let db = b - palette[pb + 2u];
      let d = dr * dr * u.wr + dg * dg * u.wg + db * db * u.wb;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let mr = palette[best * 3u];
    let mg = palette[best * 3u + 1u];
    let mb = palette[best * 3u + 2u];
    if (py >= u.height) {
      let cy = py - u.height;
      if (px >= u.width) {
        let cx = px - u.width;
        if (cx < u.width) {
          let sy = py % u.height;
          let sx = px % u.width;
          let alpha = (source[sy * u.width + sx] >> 24u) & 255u;
          output[cy * u.width + cx] = u32(mr) | (u32(mg) << 8u) | (u32(mb) << 16u) | (alpha << 24u);
        }
      }
    }
    let er = r - mr;
    let eg = g - mg;
    let eb = b - mb;
    if (u.atkinson == 0u) {
      if (px + 1u < u.gridWidth) {
        addSpread(py, px + 1u, er, eg, eb, 7.0 / 16.0);
      }
      if (py + 1u < u.gridHeight) {
        if (px >= 1u) {
          addSpread(py + 1u, px - 1u, er, eg, eb, 3.0 / 16.0);
        }
        addSpread(py + 1u, px, er, eg, eb, 5.0 / 16.0);
        if (px + 1u < u.gridWidth) {
          addSpread(py + 1u, px + 1u, er, eg, eb, 1.0 / 16.0);
        }
      }
    } else {
      if (px + 1u < u.gridWidth) {
        addSpread(py, px + 1u, er, eg, eb, 0.125);
      }
      if (px + 2u < u.gridWidth) {
        addSpread(py, px + 2u, er, eg, eb, 0.125);
      }
      if (py + 1u < u.gridHeight) {
        if (px >= 1u) {
          addSpread(py + 1u, px - 1u, er, eg, eb, 0.125);
        }
        addSpread(py + 1u, px, er, eg, eb, 0.125);
        if (px + 1u < u.gridWidth) {
          addSpread(py + 1u, px + 1u, er, eg, eb, 0.125);
        }
      }
      if (py + 2u < u.gridHeight) {
        addSpread(py + 2u, px, er, eg, eb, 0.125);
      }
    }
    if ((px & blockMask) == blockMask) {
      setFlag(py, px);
    }
  }
  setFlag(py, u.gridWidth - 1u);
}
`;
assertAsciiWgsl(DITHER_WGSL, 'dither');
/* v8 ignore stop */

/** True when this mode can take the GPU path (the seamless error-diffusion
 * modes that carry the O(palette) scan). Pattern/halftone modes already use
 * the k-d matcher and stay on the CPU path. */
export function gpuDitherCovers(mode: string): boolean {
  return mode === 'floyd' || mode === 'atkinson';
}

/**
 * Dithered with the GPU when WebGPU is available; falls back to the exact CPU
 * path otherwise. Never rejects: the fallback swallows every GPU failure
 * (missing WebGPU, device reject, shader compile/validation error) and
 * returns the same bytes the synchronous pipeline produces today.
 */
export async function processImageDataAsync(source: ImageData, options: ProcessOptions): Promise<ImageData> {
  if (!gpuDitherCovers(options.mode)) {
    return processImageData(source, options);
  }
  try {
    return await ditherImageDataGpu(source, options);
  } catch (error) {
    console.warn('WebGPU dither failed; falling back to the CPU path.', error);
    return processImageData(source, options);
  }
}

/** Compiled dither pipelines, cached per device. The shader + pipeline compile
 * is the expensive part (~100ms) and the dither runs on every render, so the
 * compile is paid once per session instead of per render. A lost device
 * produces a fresh device from getGpuDevice, which misses the cache and
 * recompiles. */
type DitherPipelines = {
  layout: GPUBindGroupLayout;
  prepass: GPUComputePipeline;
  diffuse: GPUComputePipeline;
};
let cachedPipelines: DitherPipelines | null = null;
let cachedPipelinesDevice: GPUDevice | null = null;

async function getDitherPipelines(device: GPUDevice): Promise<DitherPipelines> {
  if (cachedPipelines && cachedPipelinesDevice === device) return cachedPipelines;
  const layout = device.createBindGroupLayout({
    entries: [0, 1, 2, 3, 4, 5].map((binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      // Bindings 3 (work), 4 (flags), 5 (output) are read_write in the shader;
      // 1 (source) and 2 (palette) are read-only. A read_write shader
      // declaration on a read-only-storage layout entry is a validation error.
      buffer: { type: binding === 0 ? 'uniform' : binding === 3 || binding === 4 || binding === 5 ? 'storage' : 'read-only-storage' },
    })),
  });
  const module = device.createShaderModule({ code: DITHER_WGSL });
  const compilationInfo = await module.getCompilationInfo();
  const compileErrors = compilationInfo.messages.filter((message) => message.type === 'error');
  if (compileErrors.length > 0) {
    const first = compileErrors[0];
    throw new Error(`dither WGSL compile error: ${first.message} (line ${first.lineNum}, column ${first.linePos})`);
  }
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  cachedPipelines = {
    layout,
    prepass: device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: 'prepass' } }),
    diffuse: device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: 'diffuse' } }),
  };
  cachedPipelinesDevice = device;
  return cachedPipelines;
}

/** Runs the software-pipelined error diffusion on the GPU. Throws on any
 * failure (including "no WebGPU here") so callers control the fallback. */
/* v8 ignore start */
export async function ditherImageDataGpu(source: ImageData, options: ProcessOptions): Promise<ImageData> {
  const device = await getGpuDevice();
  const { width, height } = source;
  const atkinson = options.mode === 'atkinson';
  const paletteCount = options.palette.length;
  if (paletteCount === 0) throw new Error('GPU dither requires a non-empty palette.');
  const gridWidth = width * 3;
  const gridHeight = height * 2;
  const blocksPerRow = Math.ceil(gridWidth / (1 << BLOCK_LOG2));
  const cellCount = gridHeight * gridWidth;
  const waves = Math.ceil(gridHeight / ROWS_PER_WAVE);

  // Source packed as one u32 per pixel: r | g<<8 | b<<16 | a<<24.
  const src = source.data;
  const packed = new Uint32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    packed[i] = src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) | (src[o + 3] << 24);
  }

  const flat = new Float32Array(paletteCount * 3);
  for (let i = 0; i < paletteCount; i += 1) {
    const c = hexToRgb(options.palette[i]);
    flat[i * 3] = c[0];
    flat[i * 3 + 1] = c[1];
    flat[i * 3 + 2] = c[2];
  }

  // Tone parameters mirror dither.ts toneAdjustParams exactly; the shader
  // consumes them as f32 (the f64-vs-f32 rounding is the documented
  // divergence from the CPU bytes).
  const brightnessOffset = options.brightness * 2.55;
  const contrastFactor = (259 * (options.contrast + 255)) / (255 * (259 - options.contrast));
  const saturationFactor = 1 + options.saturation / 100;
  const uniforms = new Float32Array([
    gridWidth, gridHeight, width, height, paletteCount, atkinson ? 1 : 0, BLOCK_LOG2, blocksPerRow,
    options.strength, brightnessOffset, contrastFactor, saturationFactor,
    LUMA.red, LUMA.green, LUMA.blue, 0,
  ]);

  const sourceBuffer = device.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(sourceBuffer, 0, packed);
  const paletteBuffer = device.createBuffer({ size: flat.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paletteBuffer, 0, flat);
  const uniformBuffer = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniformBuffer, 0, uniforms);
  // Work cells are fully written by the prepass before diffusion reads them,
  // so no zero-init needed; flags must start cleared.
  const workBuffer = device.createBuffer({ size: cellCount * 3 * 4, usage: GPUBufferUsage.STORAGE });
  const flagsBuffer = device.createBuffer({ size: gridHeight * blocksPerRow * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(flagsBuffer, 0, new Uint32Array(gridHeight * blocksPerRow));
  const outputBuffer = device.createBuffer({ size: width * height * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

  const { layout, prepass: prepassPipeline, diffuse: diffusePipeline } = await getDitherPipelines(device);
  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: sourceBuffer } },
      { binding: 2, resource: { buffer: paletteBuffer } },
      { binding: 3, resource: { buffer: workBuffer } },
      { binding: 4, resource: { buffer: flagsBuffer } },
      { binding: 5, resource: { buffer: outputBuffer } },
    ],
  });

  device.pushErrorScope('validation');

  const encoder = device.createCommandEncoder();
  const prepass = encoder.beginComputePass();
  prepass.setPipeline(prepassPipeline);
  prepass.setBindGroup(0, bindGroup);
  prepass.dispatchWorkgroups(Math.ceil(cellCount / PREPASS_WORKGROUP));
  prepass.end();
  for (let wave = 0; wave < waves; wave += 1) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(diffusePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(wave, 1);
    pass.end();
  }
  const readback = device.createBuffer({ size: width * height * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, width * height * 4);
  device.queue.submit([encoder.finish()]);
  const validationError = await device.popErrorScope();
  if (validationError) {
    throw new Error(`dither WebGPU validation error: ${validationError.message}`);
  }

  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8ClampedArray(readback.getMappedRange());
  const result = new Uint8ClampedArray(bytes);
  readback.unmap();
  return new ImageData(result, width, height);
}
/* v8 ignore stop */
