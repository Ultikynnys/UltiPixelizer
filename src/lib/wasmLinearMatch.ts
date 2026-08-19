/**
 * Loader for the f64 SIMD palette scan (src-wasm/). Exposes a synchronous
 * matcher factory so the seamless dither path in `streamDitherSeamless` stays
 * synchronous: the wasm module is instantiated once (initDitherWasm) and then
 * called directly via its linear memory.
 *
 * Byte-identical contract: `createWasmMatcher` promotes the f32 palette and
 * weights to f64 (f32 -> f64 is exact) into a structure-of-arrays layout and
 * hands the wasm a pointer; the wasm evaluates the same expression as the JS
 * `linearMatch` in the same order. See src-wasm/src/lib.rs.
 *
 * Until the instance is ready (or if loading fails) `createWasmMatcher`
 * returns null and the caller uses the JS scan — a load-order fallback, not a
 * silent error swallow: the load failure is logged once and latched.
 */

interface DitherWasmExports {
  memory: WebAssembly.Memory;
  dither_alloc: (size: number) => number;
  dither_dealloc: (ptr: number, size: number) => void;
  linear_match: (
    rPtr: number,
    gPtr: number,
    bPtr: number,
    wPtr: number,
    count: number,
    r: number,
    g: number,
    b: number,
  ) => number;
}

let instance: DitherWasmExports | null = null;
let loadPromise: Promise<void> | null = null;
let loadFailed = false;

/** Instantiates the wasm module once. Safe to call repeatedly; the dynamic
 * import means the .wasm is only fetched when this actually runs (the app
 * entry point), so tests that never call it never touch the file. Pass `bytes`
 * to instantiate from memory instead of fetching (used by the node test suite,
 * where `fetch` of the `?url` asset is not available). */
export function initDitherWasm(bytes?: ArrayBuffer): Promise<void> {
  if (loadFailed || instance) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = (async () => {
      let buffer: ArrayBuffer;
      if (bytes) {
        buffer = bytes;
      } else {
        const mod = await import('../wasm/dither.wasm?url');
        const res = await fetch(mod.default);
        buffer = await res.arrayBuffer();
      }
      const { instance: inst } = await WebAssembly.instantiate(buffer, {});
      instance = inst.exports as unknown as DitherWasmExports;
    })().catch((error: unknown) => {
      loadFailed = true;
      loadPromise = null;
      console.warn('WASM palette scan unavailable; using the JS linear scan.', error);
    });
  }
  return loadPromise;
}

/** A per-dither palette matcher backed by the wasm linear scan. */
export interface WasmPaletteMatcher {
  match(r: number, g: number, b: number): number;
  dispose(): void;
}

/** Builds the f64 SoA palette in wasm linear memory and returns a matcher, or
 * null when the wasm is not ready / unavailable. `flat` is the interleaved f32
 * palette, `weights` the f32 [wr, wg, wb], `count` the palette size. */
export function createWasmMatcher(flat: Float32Array, weights: Float32Array, count: number): WasmPaletteMatcher | null {
  if (!instance || count <= 0) return null;
  const { memory, dither_alloc, dither_dealloc, linear_match } = instance;

  // Pad the SoA stride to an even element count so every channel base and every
  // pair-load is 16-byte aligned (the wasm uses v128_load).
  const stride = (count + 1) & ~1;
  const channelBytes = stride * 8;
  const paletteBytes = channelBytes * 3;
  const weightsBytes = 24;
  const totalBytes = paletteBytes + weightsBytes;

  const base = dither_alloc(totalBytes);
  if (base === 0) return null;

  // Read memory.buffer after dither_alloc: a growing alloc detaches the old
  // buffer, and we need the current one.
  const view = new Float64Array(memory.buffer, base, totalBytes / 8);
  for (let i = 0; i < count; i += 1) {
    view[i] = flat[i * 3];
    view[stride + i] = flat[i * 3 + 1];
    view[2 * stride + i] = flat[i * 3 + 2];
  }
  const wBase = 3 * stride;
  view[wBase] = weights[0];
  view[wBase + 1] = weights[1];
  view[wBase + 2] = weights[2];

  const rPtr = base;
  const gPtr = base + channelBytes;
  const bPtr = base + channelBytes * 2;
  const wPtr = base + paletteBytes;

  return {
    match: (r, g, b) => linear_match(rPtr, gPtr, bPtr, wPtr, count, r, g, b),
    dispose: () => dither_dealloc(base, totalBytes),
  };
}
