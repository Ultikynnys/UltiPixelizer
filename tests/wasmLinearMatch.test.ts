import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWasmMatcher, initDitherWasm } from '../src/lib/wasmLinearMatch';

/**
 * Byte-identical parity between the compiled wasm `linear_match` and the JS
 * `linearMatch`. The wasm is a build artifact (src-wasm/ -> src/wasm/dither.wasm);
 * when it has not been built, `initDitherWasm` has no module to instantiate and
 * `createWasmMatcher` returns null, so the parity test skips rather than
 * failing. On a machine with the wasm built (`npm run build:wasm`), it loads
 * the module from disk (node can't `fetch` the `?url` asset) and pins the
 * compiled module byte-for-byte to the JS scan.
 */

/** Replicates the private `linearMatch` in src/lib/dither.ts exactly: f32
 * weights + palette promoted to f64, the same left-to-right distance
 * expression, strict less-than with first-wins. */
function linearMatchJs(flat: Float32Array, weights: Float32Array, count: number, r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    const dr = r - flat[i * 3];
    const dg = g - flat[i * 3 + 1];
    const db = b - flat[i * 3 + 2];
    const d = (dr * dr * weights[0] + dg * dg * weights[1]) + db * db * weights[2];
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

describe('wasm palette scan', () => {
  let available = false;

  beforeAll(async () => {
    // Load the built module from disk so the parity test can run in node (the
    // loader's browser path uses `fetch`, which node cannot do for a `?url`).
    let bytes: ArrayBuffer | undefined;
    try {
      const buf = readFileSync(fileURLToPath(new URL('../src/wasm/dither.wasm', import.meta.url)));
      bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      // wasm not built — `available` stays false and the test skips below.
    }
    if (bytes) {
      await initDitherWasm(bytes);
      const probe = createWasmMatcher(
        new Float32Array([0, 0, 0, 255, 255, 255]),
        new Float32Array([0.299, 0.587, 0.114]),
        2,
      );
      if (probe) {
        probe.dispose();
        available = true;
      }
    }
  });

  it('matches the JS linear scan byte-for-byte', (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }

    // Deterministic PRNG so the sweep is reproducible.
    let seed = 0x9e3779b9;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    const weights = new Float32Array([0.299, 0.587, 0.114]);
    for (let trial = 0; trial < 500; trial += 1) {
      const count = 1 + Math.floor(rand() * 256);
      const flat = new Float32Array(count * 3);
      for (let i = 0; i < count * 3; i += 1) flat[i] = Math.floor(rand() * 256);

      const matcher = createWasmMatcher(flat, weights, count);
      if (!matcher) throw new Error('wasm matcher unavailable mid-test');
      for (let q = 0; q < 8; q += 1) {
        const r = rand() * 700 - 100;
        const g = rand() * 700 - 100;
        const b = rand() * 700 - 100;
        expect(matcher.match(r, g, b)).toBe(linearMatchJs(flat, weights, count, r, g, b));
      }
      matcher.dispose();
    }
  });
});
