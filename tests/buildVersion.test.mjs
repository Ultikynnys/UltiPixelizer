import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Plain .mjs on purpose: the browser app has no @types/node, and this test
// spawns the real CLI (as CI runs it)  an .mjs file is skipped by tsc
// (no allowJs) but picked up by vitest.
function run(...args) {
  return execFileSync('node', ['scripts/build-version.mjs', ...args], { encoding: 'utf8' }).trim();
}

describe('build-version.mjs', () => {
  it('adds the static 2.0.0 offset (200) to the commit count', () => {
    expect(run('1')).toBe('2.0.1');
    expect(run('2')).toBe('2.0.2');
    expect(run('9')).toBe('2.0.9');
  });

  it('carries into the minor and major digits', () => {
    expect(run('10')).toBe('2.1.0');
    expect(run('99')).toBe('2.9.9');
    expect(run('100')).toBe('3.0.0');
    expect(run('101')).toBe('3.0.1');
  });

  it('--count prints the offset build number the badge uses (v209 matches 2.0.9)', () => {
    expect(run('--count', '1')).toBe('201');
    expect(run('--count', '9')).toBe('209');
    expect(run('--count', '101')).toBe('301');
  });
});
