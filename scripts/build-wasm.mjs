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
