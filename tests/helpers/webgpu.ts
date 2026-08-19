import { vi } from 'vitest';

/** Stubs `navigator` with no WebGPU at all, so every GPU path must reject and
 * the caller falls back to the CPU/worker path. Shared by the AO and lightmap
 * GPU tests, which otherwise repeat the same `stubGlobal('navigator', {})`. */
export function stubNoWebGpu(): void {
  vi.stubGlobal('navigator', {});
}

/** Stubs `navigator.gpu` with a `requestAdapter` mock that yields no device —
 * the GPU path proceeds far enough to prove it fires the device request, then
 * fails loudly ("adapter unavailable"). */
export function stubWebGpuAdapter(requestAdapter: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('navigator', { gpu: { requestAdapter } });
}
