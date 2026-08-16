export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Parses a JSON file string and validates the result, throwing a friendly
 * error for unparseable or invalid payloads. Shared by the preset and custom
 * palette importers so the JSON-error convention stays in one place.
 *
 * - `before` runs before validation (e.g. version migration of old files).
 * - `after` runs after validation (e.g. defensive deep-cloning).
 */
export function parseJsonFile<T>(
  json: string,
  validate: (value: unknown) => value is T,
  messages: { invalidJson: string; invalidData: string },
  transforms: { before?: (value: unknown) => unknown; after?: (value: T) => T } = {},
): T {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(messages.invalidJson);
  }
  value = transforms.before ? transforms.before(value) : value;
  if (!validate(value)) throw new Error(messages.invalidData);
  return transforms.after ? transforms.after(value) : value;
}

/** Serializes a validated value to pretty JSON, refusing invalid payloads. */
export function serializeJsonFile<T>(value: T, validate: (value: unknown) => value is T, message: string): string {
  if (!validate(value)) throw new Error(message);
  return JSON.stringify(value, null, 2);
}

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
    let raw: string | null;
    try {
      raw = storage.getItem(storageKey);
    } catch (error) {
      throw new Error(`Reading stored data for "${storageKey}" failed.`, { cause: error });
    }
    if (!raw) return [];

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Stored data for "${storageKey}" is corrupt JSON.`, { cause: error });
    }
    if (!Array.isArray(value)) {
      throw new Error(`Stored data for "${storageKey}" is not an array.`);
    }

    const entries = value
      .map((entry) => (migrate ? migrate(entry) : entry))
      .filter((entry) => {
        if (validate(entry)) return true;
        console.warn(`Dropping an invalid entry from "${storageKey}".`, entry);
        return false;
      });
    return clone ? entries.map(clone) : entries;
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
