import { describe, expect, it } from 'vitest';
import { errorMessage, safeFileName, slugify } from '../src/lib/strings';

describe('slugify', () => {
  it('lowercases and collapses runs of non-alphanumerics into dashes', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  Multiple   Spaces  ')).toBe('multiple-spaces');
    expect(slugify('Pixel-Art_3D')).toBe('pixel-art-3d');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('!dashy!')).toBe('dashy');
    expect(slugify('-leading-trailing-')).toBe('leading-trailing');
  });

  it('falls back when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('item');
    // ASCII-only class: accented letters are treated as separators, not kept.
    expect(slugify('Ünïcödé')).toBe('n-c-d');
    expect(slugify('', 'custom-fallback')).toBe('custom-fallback');
  });

  it('honors maxLength, truncating after trimming', () => {
    expect(slugify('Hello World', 'item', 5)).toBe('hello');
    expect(slugify('ab-cd-ef', 'item', 3)).toBe('ab-');
  });
});

describe('safeFileName', () => {
  it('replaces runs of filesystem-hostile characters with a single dash', () => {
    expect(safeFileName('My File (1).png')).toBe('My-File-1-png');
    expect(safeFileName('a/b\\c:d')).toBe('a-b-c-d');
    expect(safeFileName('a..b')).toBe('a-b');
  });

  it('keeps letters, digits, dashes, and underscores; replaces dots', () => {
    expect(safeFileName('Model_LOD2-final.glb')).toBe('Model_LOD2-final-glb');
  });

  it('falls back for empty or all-hostile names', () => {
    expect(safeFileName('///')).toBe('file');
    expect(safeFileName('', 'untitled')).toBe('untitled');
  });
});

describe('errorMessage', () => {
  it('extracts the message from Error instances', () => {
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('surfaces non-empty thrown strings', () => {
    expect(errorMessage('plain string', 'fallback')).toBe('plain string');
  });

  it('falls back for throws without a usable message', () => {
    expect(errorMessage(null, 'fallback')).toBe('fallback');
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
    expect(errorMessage(42, 'fallback')).toBe('fallback');
    expect(errorMessage('', 'fallback')).toBe('fallback');
    expect(errorMessage('   ', 'fallback')).toBe('fallback');
  });
});
