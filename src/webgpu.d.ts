/**
 * Minimal ambient declarations for the WebGPU surface the AO bake uses.
 *
 * TypeScript 5.9's `lib.dom.d.ts` does not yet ship the WebGPU API, and the
 * project avoids a `@webgpu/types` dependency. This file declares only the
 * subset of the API `src/lib/aoGpu.ts` touches, so the GPU bake is fully typed
 * without pulling in a package. Browsers expose these globals at runtime;
 * non-WebGPU environments (Node tests, older WebViews) simply have
 * `navigator.gpu === undefined`, which the bake's feature detection handles.
 */

interface GPURequestAdapterOptions {
  powerPreference?: 'low-power' | 'high-performance';
}

interface GPUDeviceDescriptor {
  label?: string;
}

interface GPUBufferDescriptor {
  size: number;
  usage: number;
  mappedAtCreation?: boolean;
  label?: string;
}

interface GPUBuffer {
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GPUShaderModuleDescriptor {
  code: string;
  label?: string;
}

interface GPUShaderModule {
  getCompilationInfo(): Promise<GPUCompilationInfo>;
}

interface GPUCompilationMessage {
  message: string;
  type: 'error' | 'warning' | 'info';
  /** 1-based line; 0 when the message is not tied to a specific line. */
  lineNum: number;
  /** 1-based column; 0 when unknown. */
  linePos: number;
  /** Byte offset of the message span in the shader source; 0 when unknown. */
  offset: number;
  /** Byte length of the message span; 0 when unknown. */
  length: number;
}

interface GPUCompilationInfo {
  messages: readonly GPUCompilationMessage[];
}

interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: number;
  buffer?: { type: 'uniform' | 'storage' | 'read-only-storage'; hasDynamicOffset?: boolean };
}

interface GPUBindGroupLayoutDescriptor {
  entries: GPUBindGroupLayoutEntry[];
  label?: string;
}

interface GPUBindGroupLayout {}

interface GPUBindGroupEntry {
  binding: number;
  resource: { buffer: GPUBuffer } | GPUBuffer;
}

interface GPUBindGroupDescriptor {
  layout: GPUBindGroupLayout;
  entries: GPUBindGroupEntry[];
  label?: string;
}

interface GPUBindGroup {}

interface GPUComputePipelineDescriptor {
  layout: 'auto' | GPUPipelineLayout;
  compute: { module: GPUShaderModule; entryPoint?: string };
  label?: string;
}

interface GPUComputePipeline {}

interface GPUPipelineLayoutDescriptor {
  bindGroupLayouts: GPUBindGroupLayout[];
  label?: string;
}

interface GPUPipelineLayout {}

interface GPUError {
  readonly message: string;
}

interface GPUCommandEncoderDescriptor {
  label?: string;
}

interface GPUCommandBuffer {}

interface GPUComputePassDescriptor {
  label?: string;
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

interface GPUCommandEncoder {
  beginComputePass(descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder;
  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: number,
    destination: GPUBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  finish(): GPUCommandBuffer;
}

interface GPUQueue {
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): void;
  submit(commandBuffers: GPUCommandBuffer[]): void;
}

interface GPUDeviceLostInfo {
  /** 'destroyed' when the app destroyed the device; 'lost' on driver reset /
   * GPU hang; 'unknown' otherwise. */
  reason: 'destroyed' | 'lost' | 'unknown' | null;
  message: string;
}

interface GPUDevice {
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<GPUError | null>;
  readonly queue: GPUQueue;
  /** Resolves when the device is lost or destroyed; the cache in gpuCommon's
   * getGpuDevice watches it to re-request on loss. */
  readonly lost: Promise<GPUDeviceLostInfo>;
  destroy(): void;
}

interface GPUAdapter {
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
}

interface GPU {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
}

interface Navigator {
  readonly gpu?: GPU;
}

declare const GPUBufferUsage: {
  readonly MAP_READ: number;
  readonly MAP_WRITE: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly STORAGE: number;
  readonly UNIFORM: number;
};

declare const GPUShaderStage: {
  readonly VERTEX: number;
  readonly FRAGMENT: number;
  readonly COMPUTE: number;
};

declare const GPUMapMode: {
  readonly READ: number;
  readonly WRITE: number;
};
