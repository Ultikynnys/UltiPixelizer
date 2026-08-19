// Builds the Rust f64 SIMD palette scan (src-wasm/) to a raw .wasm and copies
// it where Vite can import it. The crate uses plain `#[no_mangle]` exports (no
// wasm-bindgen), so a plain cargo build is enough — no wasm-pack needed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = resolve(root, 'src-wasm');
const manifest = resolve(crateDir, 'Cargo.toml');
const wasmSrc = resolve(crateDir, 'target', 'wasm32-unknown-unknown', 'release', 'ultipixelizer_dither.wasm');
const wasmDest = resolve(root, 'src', 'wasm', 'dither.wasm');

// The wasm32-unknown-unknown target is not part of the default rustup
// toolchain, so `cargo build` on a fresh machine or CI runner fails with
// E0463 ("can't find crate for `std`"). Install it on demand — `rustup target
// add` is idempotent, and a machine without rustup still reaches the cargo
// step below, which reports the concrete error.
try {
  execFileSync('rustup', ['target', 'add', 'wasm32-unknown-unknown'], { stdio: 'inherit' });
} catch (error) {
  if (error && error.code === 'ENOENT') {
    console.warn(
      '\n[rustup] not found — assuming the wasm32-unknown-unknown target is already installed.\n',
    );
  } else {
    console.warn(
      `\n[rustup] could not add the wasm32-unknown-unknown target (exit ${error.status ?? '?'}); ` +
        'the cargo build below will fail if it is not already installed.\n',
    );
  }
}

try {
  execFileSync(
    'cargo',
    ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { stdio: 'inherit' },
  );
} catch (error) {
  if (error && error.code === 'ENOENT') {
    console.error(
      '\n[cargo] not found. Install the Rust toolchain (rustup) and add the wasm target:\n' +
        '  rustup target add wasm32-unknown-unknown\n',
    );
  }
  process.exit(1);
}

mkdirSync(dirname(wasmDest), { recursive: true });
copyFileSync(wasmSrc, wasmDest);
console.log(`built ${wasmDest}`);
