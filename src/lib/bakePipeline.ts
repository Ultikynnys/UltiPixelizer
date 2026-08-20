import { webgpuUsable } from './gpuCommon';

/** Latched once the GPU bake has failed this session. The GPU path is retried
 * each bake while `webgpuUsable()` stays true (a non-adapter failure like a
 * shader compile error does not latch `adapterUnavailable`), but the fallback
 * message is logged once so a deterministic failure doesn't spam the console
 * on every re-bake. Mirrors the dither path's `warnedFallback` latch. */
let warnedGpuBakeFallback = false;

/**
 * Shared bake fallback ladder: try the GPU path when WebGPU is present, else
 * the worker path, else the synchronous CPU path. Every failure of a faster
 * path logs why and falls through to the next one, so the AO and lightmap
 * bakes expose the same availability contract: `gpu()` when `navigator.gpu`
 * exists, `worker()` when `Worker` exists, `sync()` as the last resort.
 */
export async function runBakeWithFallbacks<T>(
  label: string,
  gpu: (() => Promise<T>) | null,
  worker: () => Promise<T>,
  sync: () => T,
  /** Invoked instead of `sync` when the worker path failed (defaults to `sync`). */
  syncFallback: () => T = sync,
): Promise<T> {
  // Only await the GPU path when WebGPU is actually usable: the synchronous
  // probe keeps the worker dispatch below synchronous for non-WebGPU callers,
  // and skips the doomed request once the environment has proven adapterless.
  if (gpu && webgpuUsable()) {
    try {
      return await gpu();
    } catch (error) {
      // The GPU bake failed: log why once, then continue to the worker /
      // single-threaded path below. The CPU rasterizer is unaffected.
      if (!warnedGpuBakeFallback) {
        warnedGpuBakeFallback = true;
        console.error(`${label} GPU bake failed, falling back to the CPU path.`, error);
      }
    }
  }
  if (typeof Worker === 'undefined') {
    return sync();
  }
  try {
    return await worker();
  } catch (error) {
    console.error(`${label} worker bake failed, falling back to the main thread.`, error);
    return syncFallback();
  }
}
