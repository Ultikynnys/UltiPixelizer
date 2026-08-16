// Generates the desktop installer version from the same git build count the
// frontend badge uses. The badge shows `v{buildNumber} · {commitSha}` where
// buildNumber = `git rev-list --count HEAD` (set as VITE_BUILD_NUMBER in the
// CI workflows and rendered in src/main.ts). Semver can't hold a bare counter,
// so the count is split into three digits — hundreds become the major, tens
// the minor, ones the patch: 124 → 1.2.4, 137 → 1.3.7.
//
// Usage: node scripts/build-version.mjs [count]
//   with no argument the count is read from git (the same command the badge
//   uses); pass a count to override (tests, local previews).
import { execFileSync } from 'node:child_process';

function buildCount() {
  const explicit = Number(process.argv[2]);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const counted = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
  return Number(counted);
}

function versionFromCount(count) {
  const major = Math.floor(count / 100);
  const minor = Math.floor((count % 100) / 10);
  const patch = count % 10;
  return `${major}.${minor}.${patch}`;
}

process.stdout.write(versionFromCount(buildCount()));
