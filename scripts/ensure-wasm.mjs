// Ensures the dither wasm artifact (src/wasm/dither.wasm) exists before
// `npm run dev` / `npm run tauri ...`. Rebuilds when the artifact is missing
// or any source under src-wasm/ is newer than it, so a stale artifact (Rust
// edited but never rebuilt) cannot silently ship into the dev loop.
//
// When the Rust toolchain is unavailable the build fails: print a loud
// warning and keep the command bootable (exit 0), because the app's own
// boot-time banner already tells the user the JS scan is in use and how to
// fix it. Exiting non-zero would block `npm run dev` entirely for web-only
// contributors; the failure must be visible either way, never silent.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = join(root, 'src', 'wasm', 'dither.wasm');

/** Newest mtime (ms) under `dir`, recursively; 0 when the dir has no files. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

if (existsSync(artifact) && newestMtime(join(root, 'src-wasm')) <= statSync(artifact).mtimeMs) {
  process.exit(0);
}

const result = spawnSync('npm', ['run', 'build:wasm'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.status === 0) {
  process.exit(0);
}

console.warn(
  '\n[ensure-wasm] Could not build the dither wasm (is the Rust toolchain installed?).\n' +
    'The app will run the slower JS palette scan; the in-app banner explains the fix.\n',
);
process.exit(0);
