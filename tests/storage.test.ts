import { beforeEach, describe, expect, it } from 'vitest';
import { createStoredCollection, parseJsonFile, serializeJsonFile, type StorageLike } from '../src/lib/storage';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  shouldThrow = false;
  getItem(key: string): string | null {
    if (this.shouldThrow) throw new Error('blocked');
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.shouldThrow) throw new Error('quota');
    this.data.set(key, value);
  }
}

type Entry = { id: string; label?: string };
const isEntry = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && typeof (value as Entry).id === 'string';

describe('parseJsonFile', () => {
  it('parses and validates a payload', () => {
    expect(parseJsonFile('{"id":"a"}', isEntry, { invalidJson: 'bad json', invalidData: 'bad data' })).toEqual({ id: 'a' });
  });

  it('throws a friendly error for unparseable JSON', () => {
    expect(() => parseJsonFile('{bad', isEntry, { invalidJson: 'not JSON', invalidData: 'nope' })).toThrow('not JSON');
  });

  it('throws for valid JSON that fails validation', () => {
    expect(() => parseJsonFile('{"label":"x"}', isEntry, { invalidJson: 'not JSON', invalidData: 'wrong shape' })).toThrow('wrong shape');
  });

  it('runs the before transform ahead of validation (migration) and after behind it', () => {
    const migrated = parseJsonFile(
      '{"oldField":"y"}',
      isEntry,
      { invalidJson: 'not JSON', invalidData: 'wrong shape' },
      { before: (raw) => (typeof raw === 'object' && raw !== null ? { ...(raw as object), id: String((raw as { oldField: string }).oldField) } : raw) },
    );
    expect(migrated).toEqual({ oldField: 'y', id: 'y' });

    const cloned = parseJsonFile(
      '{"id":"a"}',
      isEntry,
      { invalidJson: 'not JSON', invalidData: 'wrong shape' },
      { after: (entry) => ({ ...entry, label: 'deep-copied' }) },
    );
    expect(cloned).toEqual({ id: 'a', label: 'deep-copied' });
  });
});

describe('serializeJsonFile', () => {
  it('pretty-prints validated payloads', () => {
    expect(serializeJsonFile({ id: 'a' }, isEntry, 'invalid entry')).toBe('{\n  "id": "a"\n}');
  });

  it('refuses invalid payloads with the given message', () => {
    expect(() => serializeJsonFile({ label: 'x' } as unknown as Entry, isEntry, 'Cannot export an invalid entry.')).toThrow('Cannot export an invalid entry.');
  });
});

describe('createStoredCollection', () => {
  const key = (entry: Entry) => entry.id;
  function collection(_storage: MemoryStorage, options: Partial<Parameters<typeof createStoredCollection<Entry>>[0]> = {}) {
    return createStoredCollection<Entry>({
      storageKey: 'entries',
      validate: isEntry,
      ...options,
    });
  }

  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('loads nothing from absent storage', () => {
    const entries = collection(storage);
    expect(entries.load(storage)).toEqual([]);
  });

  it('throws for corrupt, non-array, or unreadable storage', () => {
    const entries = collection(storage);
    storage.data.set('entries', '{bad');
    expect(() => entries.load(storage)).toThrow('corrupt JSON');
    storage.data.set('entries', '{}');
    expect(() => entries.load(storage)).toThrow('not an array');
    storage.shouldThrow = true;
    expect(() => entries.load(storage)).toThrow('Reading stored data');
  });

  it('drops invalid entries and keeps valid ones', () => {
    storage.data.set('entries', JSON.stringify([{ label: 'broken' }, { id: 'ok' }]));
    expect(collection(storage).load(storage)).toEqual([{ id: 'ok' }]);
  });

  it('applies migrate and clone transforms on load', () => {
    storage.data.set('entries', JSON.stringify([{ version: 1 }]));
    const migrated = collection(storage, {
      migrate: (raw) => (typeof raw === 'object' && raw !== null ? { id: 'migrated', ...(raw as object) } : raw),
    });
    expect(migrated.load(storage)).toEqual([{ version: 1, id: 'migrated' }]);

    storage.data.set('entries', JSON.stringify([{ id: 'shared' }]));
    const cloned = collection(storage, { clone: (entry) => ({ ...entry, label: 'copy' }) });
    const loaded = cloned.load(storage);
    expect(loaded).toEqual([{ id: 'shared', label: 'copy' }]);
    loaded[0].label = 'mutated';
    expect(cloned.load(storage)[0].label).toBe('copy');
  });

  it('saves only when every entry validates, using the configured message', () => {
    const entries = collection(storage, { invalidSaveMessage: 'Contains invalid entries.' });
    expect(() => entries.save(storage, [{ label: 'x' } as unknown as Entry])).toThrow('Contains invalid entries.');
    entries.save(storage, [{ id: 'a' }]);
    expect(JSON.parse(storage.data.get('entries')!)).toEqual([{ id: 'a' }]);
  });

  it('throws the save error message on quota, falling back to a default', () => {
    const withMessage = collection(storage, { saveErrorMessage: 'Quota exceeded.' });
    storage.shouldThrow = true;
    expect(() => withMessage.save(storage, [{ id: 'a' }])).toThrow('Quota exceeded.');

    const withoutMessage = collection(storage);
    expect(() => withoutMessage.save(storage, [{ id: 'a' }])).toThrow('Could not save data.');
  });

  it('upserts by key, replacing existing entries in place', () => {
    const entries = collection(storage);
    entries.save(storage, [{ id: 'a', label: 'old' }]);
    const replaced = entries.upsert(storage, { id: 'a', label: 'new' }, key);
    expect(replaced).toEqual([{ id: 'a', label: 'new' }]);
    const added = entries.upsert(storage, { id: 'b', label: 'fresh' }, key);
    expect(added).toHaveLength(2);
    expect(added[1]).toEqual({ id: 'b', label: 'fresh' });
    expect(JSON.parse(storage.data.get('entries')!)).toEqual([
      { id: 'a', label: 'new' },
      { id: 'b', label: 'fresh' },
    ]);
  });

  it('removes by key and persists the trimmed list', () => {
    const entries = collection(storage);
    entries.save(storage, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(entries.remove(storage, 'b', key)).toEqual([{ id: 'a' }, { id: 'c' }]);
    expect(JSON.parse(storage.data.get('entries')!)).toEqual([{ id: 'a' }, { id: 'c' }]);
    expect(entries.remove(storage, 'missing', key)).toEqual([{ id: 'a' }, { id: 'c' }]);
  });
});
