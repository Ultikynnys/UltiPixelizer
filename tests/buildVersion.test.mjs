import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Plain .mjs on purpose: the browser app has no @types/node, and this test
// spawns the real CLI (as CI runs it) — an .mjs file is skipped by tsc
// (no allowJs) but picked up by vitest.
function run(...args) {
  return execFileSync('node', ['scripts/build-version.mjs', ...args], { encoding: 'utf8' }).trim();
}

describe('build-version.mjs', () => {
  it('maps the base commit count to 2.0.0 (static 2.0 base, count as patch offset)', () => {
    expect(run('1')).toBe('2.0.0');
  });

  it('increments the patch per commit', () => {
    expect(run('2')).toBe('2.0.1');
    expect(run('9')).toBe('2.0.8');
    expect(run('10')).toBe('2.0.9');
  });

  it('keeps the patch offset growing past nine commits', () => {
    expect(run('11')).toBe('2.0.10');
    expect(run('101')).toBe('2.0.100');
  });

  it('--count prints the raw build count the badge uses', () => {
    expect(run('--count', '1')).toBe('1');
    expect(run('--count', '101')).toBe('101');
  });
});
