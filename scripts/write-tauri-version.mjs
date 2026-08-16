// Writes the Tauri installer version to src-tauri/tauri.version.json.
//
// The version is derived from the SAME git build count the frontend badge
// uses: `git rev-list --count HEAD` -> scripts/build-version.mjs (no
// argument reads git directly). Nothing is hardcoded — .env, tauri.conf.json
// and the CI workflows only ever reference this derivation. `tauri build`
// merges this file into the bundle config via `--config`, locally
// (`npm run tauri:build`) and in CI (desktop.yml) alike.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const version = execFileSync('node', ['scripts/build-version.mjs'], {
  encoding: 'utf8',
}).trim();
writeFileSync('src-tauri/tauri.version.json', `${JSON.stringify({ version }, null, 2)}\n`);
console.log(`Wrote src-tauri/tauri.version.json (version ${version})`);
