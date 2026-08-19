/**
 * Shared bake fallback ladder: try the GPU path when WebGPU is present, else
 * the worker path, else the synchronous CPU path. Every failure of a faster
 * path logs why and falls through to the next one, so the AO and lightmap
 * bakes expose the same availability contract: `gpu()` when `navigator.gpu`
 * exists, `worker()` when `Worker` exists, `sync()` as the last resort.
 */
export async function runBakeWithFallbacks<T>(
  label: string,
  gpu: () => Promise<T>,
  worker: () => Promise<T>,
  sync: () => T,
  /** Invoked instead of `sync` when the worker path failed (defaults to `sync`). */
  syncFallback: () => T = sync,
): Promise<T> {
  // Only await the GPU path when WebGPU is actually present: the synchronous
  // check keeps the worker dispatch below synchronous for non-WebGPU callers.
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      return await gpu();
    } catch (error) {
      // The GPU bake failed: log why, then continue to the worker /
      // single-threaded path below. The CPU rasterizer is unaffected.
      console.error(`${label} GPU bake failed, falling back to the CPU path.`, error);
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
