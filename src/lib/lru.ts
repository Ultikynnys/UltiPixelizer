/**
 * A Map with a bounded entry count: inserting past `maxEntries` evicts the
 * oldest entry (Map iteration order). `get` does NOT bump recency — callers
 * that want LRU bumping re-insert via delete + set, which is what the two
 * consumers (fallback-quad scenes, dither results) do today. Sharing the
 * factory keeps the eviction idiom in one place instead of a delete-oldest
 * loop at every cache site.
 */
export type BoundedLru<K, V> = {
  get(key: K): V | undefined;
  /** Inserts or replaces, then evicts the oldest entry if over capacity. */
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
};

export function createBoundedLru<K, V>(maxEntries: number): BoundedLru<K, V> {
  const map = new Map<K, V>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) {
        map.delete(map.keys().next().value as K);
      }
    },
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}
