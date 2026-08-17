// Generates the desktop installer version from the same git build count the
// frontend badge uses. The badge shows `v{buildNumber} · {commitSha}` where
// buildNumber = VERSION_OFFSET + `git rev-list --count HEAD` (set as
// VITE_BUILD_NUMBER in the CI workflows and rendered in src/main.ts). Semver
// can't hold a bare counter, so the count is split into three digits —
// hundreds become the major, tens the minor, ones the patch: 200 → 2.0.0,
// 211 → 2.1.1.
//
// The offset keeps the version ≥ 2.0.0: the git history was squashed to a
// single commit, so the raw count (1) would map to 0.0.1 and read as a
// downgrade against existing installers — 1 + 199 = 200 → 2.0.0 from the
// base commit on. The badge count is offset the same way so the badge number
// always matches the version's digits (v200 · sha ↔ 2.0.0).
//
// Usage: node scripts/build-version.mjs [--count] [count]
//   with no argument the count is read from git (the same command the badge
//   uses); pass a count to override (tests, local previews). With --count,
//   prints the offset-adjusted build count (for VITE_BUILD_NUMBER); without
//   it, prints the semver version derived from it.
import { execFileSync } from 'node:child_process';

const VERSION_OFFSET = 199;

function buildCount() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--count');
  const explicit = Number(args[args.length - 1]);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit + VERSION_OFFSET;
  const counted = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
  return Number(counted) + VERSION_OFFSET;
}

function versionFromCount(count) {
  const major = Math.floor(count / 100);
  const minor = Math.floor((count % 100) / 10);
  const patch = count % 10;
  return `${major}.${minor}.${patch}`;
}

const countOnly = process.argv.includes('--count');
process.stdout.write(countOnly ? String(buildCount()) : versionFromCount(buildCount()));
