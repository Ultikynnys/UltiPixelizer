export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export type StoredCollection<T> = {
  load(storage: StorageLike): T[];
  save(storage: StorageLike, entries: T[]): void;
  upsert(storage: StorageLike, entry: T, keyOf: (entry: T) => string): T[];
  remove(storage: StorageLike, key: string, keyOf: (entry: T) => string): T[];
};

export type StoredCollectionOptions<T> = {
  storageKey: string;
  validate: (value: unknown) => value is T;
  /** Transform each raw entry after JSON.parse, before validation (e.g. version migration). */
  migrate?: (value: unknown) => unknown;
  /** Deep-copy each validated entry on read (guards against shared references). */
  clone?: (entry: T) => T;
  /** Thrown by `save` when an entry fails validation. */
  invalidSaveMessage?: string;
  /** Thrown by `save` when setItem throws (e.g. storage quota). */
  saveErrorMessage?: string;
};

export function createStoredCollection<T>(options: StoredCollectionOptions<T>): StoredCollection<T> {
  const {
    storageKey,
    validate,
    migrate,
    clone,
    invalidSaveMessage = 'Stored data is invalid.',
    saveErrorMessage,
  } = options;

  function load(storage: StorageLike): T[] {
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return [];
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      const entries = value.map((entry) => (migrate ? migrate(entry) : entry)).filter(validate);
      return clone ? entries.map(clone) : entries;
    } catch {
      return [];
    }
  }

  function save(storage: StorageLike, entries: T[]): void {
    if (!entries.every(validate)) throw new Error(invalidSaveMessage);
    try {
      storage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      throw new Error(saveErrorMessage ?? 'Could not save data.');
    }
  }

  function upsert(storage: StorageLike, entry: T, keyOf: (entry: T) => string): T[] {
    const entries = load(storage);
    const index = entries.findIndex((existing) => keyOf(existing) === keyOf(entry));
    if (index >= 0) entries[index] = entry;
    else entries.unshift(entry);
    save(storage, entries);
    return entries;
  }

  function remove(storage: StorageLike, key: string, keyOf: (entry: T) => string): T[] {
    const entries = load(storage).filter((entry) => keyOf(entry) !== key);
    save(storage, entries);
    return entries;
  }

  return { load, save, upsert, remove };
}
