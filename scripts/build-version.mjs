// Generates the desktop installer version and the frontend badge number from
// the same git build count (`git rev-list --count HEAD`).
//
// A static OFFSET of 200 is added to the raw count ("a static 2.0.0 offset" 
// the number 200, anchoring versions in the 2.0.x range now that the history
// was squashed to one commit, where the raw count would map to 0.0.1). The
// installer version splits the offset count into semver digits (hundreds →
// major, tens → minor, ones → patch), and the badge shows the same offset
// count, so the topbar `v209` always matches installer `2.0.9`:
//
//   commit 1  -> count 201 -> v201 -> 2.0.1
//   commit 9  -> count 209 -> v209 -> 2.0.9
//   commit 99 -> count 299 -> v299 -> 2.9.9
//   commit 100 -> count 300 -> v300 -> 3.0.0
//
// Usage: node scripts/build-version.mjs [--count] [count]
//   with no argument the count is read from git (the same command the badge
//   uses); pass a count to override (tests, local previews). With --count,
//   prints the offset build number (for VITE_BUILD_NUMBER); without it, prints
//   the semver version derived from it.
import { execFileSync } from 'node:child_process';

const OFFSET = 200;

function buildCount() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--count');
  const explicit = Number(args[args.length - 1]);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const counted = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
  return Number(counted);
}

function versionFromCount(count) {
  const offset = count + OFFSET;
  const major = Math.floor(offset / 100);
  const minor = Math.floor((offset % 100) / 10);
  const patch = offset % 10;
  return `${major}.${minor}.${patch}`;
}

const countOnly = process.argv.includes('--count');
process.stdout.write(countOnly ? String(buildCount() + OFFSET) : versionFromCount(buildCount()));
