import { describe, expect, it } from 'vitest';
import { createBoundedLru } from '../src/lib/lru';

describe('createBoundedLru', () => {
  it('starts empty and returns undefined for a miss', () => {
    const cache = createBoundedLru<string, number>(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('inserts and retrieves entries up to capacity', () => {
    const cache = createBoundedLru<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('evicts the oldest entry when inserting past capacity', () => {
    const cache = createBoundedLru<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('bumping recency via delete + re-set shields the entry from eviction', () => {
    const cache = createBoundedLru<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    // Bump 'a' to the tail, then insert 'c' — 'b' becomes the oldest.
    cache.delete('a');
    cache.set('a', 1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('replaces an existing key without growing the map', () => {
    const cache = createBoundedLru<string, number>(1);
    cache.set('a', 1);
    cache.set('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
  });

  it('delete removes an entry and clear empties the map', () => {
    const cache = createBoundedLru<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.delete('a')).toBe(true);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.delete('a')).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('b')).toBeUndefined();
  });
});
