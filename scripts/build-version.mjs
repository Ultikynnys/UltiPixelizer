// Generates the desktop installer version from the same git build count the
// frontend badge uses. The badge shows `v{buildNumber} · {commitSha}` where
// buildNumber = `git rev-list --count HEAD` (set as VITE_BUILD_NUMBER in the
// CI workflows and rendered in src/main.ts).
//
// The version is a STATIC 2.0.0 base with the commit count as a patch offset:
// commit 1 → 2.0.0, commit 2 → 2.0.1, commit 11 → 2.0.10. The history was
// squashed to a single commit, so this anchors releases at 2.0.0 instead of
// 0.0.1 (which would read as a downgrade against existing installers).
//
// Usage: node scripts/build-version.mjs [--count] [count]
//   with no argument the count is read from git (the same command the badge
//   uses); pass a count to override (tests, local previews). With --count,
//   prints the raw build count (for VITE_BUILD_NUMBER); without it, prints
//   the semver version derived from it.
import { execFileSync } from 'node:child_process';

const BASE_VERSION = '2.0';

function buildCount() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--count');
  const explicit = Number(args[args.length - 1]);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const counted = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
  return Number(counted);
}

function versionFromCount(count) {
  return `${BASE_VERSION}.${Math.max(0, count - 1)}`;
}

const countOnly = process.argv.includes('--count');
process.stdout.write(countOnly ? String(buildCount()) : versionFromCount(buildCount()));
