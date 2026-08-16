import { beforeEach, describe, expect, it } from 'vitest';
import { palettes } from '../src/lib/palettes';
import {
  CUSTOM_PALETTE_STORAGE_KEY,
  createCustomPalette,
  deleteCustomPalette,
  duplicatePalette,
  isCustomPalette,
  loadCustomPalettes,
  matchingPaletteKey,
  parseCustomPalette,
  selectOrCreatePalette,
  serializeCustomPalette,
  updateCustomPalette,
  upsertCustomPalette,
  type StorageLike,
} from '../src/lib/customPalettes';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  shouldThrow = false;
  getItem(key: string): string | null { if (this.shouldThrow) throw new Error('blocked'); return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.shouldThrow) throw new Error('quota'); this.data.set(key, value); }
}

let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

describe('custom palettes', () => {
  it('creates and round-trips complete portable palettes', () => {
    const palette = createCustomPalette('My Colors', 'For stone', ['#000000', '#ffffff'], new Date('2026-01-02T03:04:05Z'));
    expect(parseCustomPalette(serializeCustomPalette(palette))).toEqual(palette);
    expect(palette.key).toBe('custom-1767323045000-my-colors');
    expect(isCustomPalette(palette)).toBe(true);
  });

  it('duplicates built-ins independently and updates while preserving identity', () => {
    const duplicate = duplicatePalette(palettes.pico8, new Date('2026-01-01'));
    duplicate.colors[0] = '#123456';
    expect(palettes.pico8.colors[0]).not.toBe('#123456');
    const updated = updateCustomPalette(duplicate, 'Edited', 'Changed', ['#111111', '#eeeeee'], new Date('2026-01-02'));
    expect(updated.key).toBe(duplicate.key);
    expect(updated.createdAt).toBe(duplicate.createdAt);
    expect(updated.name).toBe('Edited');
  });

  it('rejects invalid names, color counts, malformed JSON, and invalid exports', () => {
    expect(() => createCustomPalette('', '', ['#000000', '#ffffff'])).toThrow('2–256');
    expect(() => createCustomPalette('Bad', '', ['#000000'])).toThrow('2–256');
    expect(() => createCustomPalette('Bad', '', Array(257).fill('#000000'))).toThrow('2–256');
    expect(() => parseCustomPalette('{bad')).toThrow('not valid JSON');
    expect(() => parseCustomPalette('{}')).toThrow('invalid or unsupported');
    expect(() => createCustomPalette('x'.repeat(61), '', ['#000000', '#ffffff'])).toThrow('2–256');
    expect(() => serializeCustomPalette({} as never)).toThrow('invalid');
  });

  it('finds equivalent palettes by ordered colors and prefers the requested key', () => {
    const catalog = {
      first: { ...palettes.pico8, colors: ['#AA0000', '#00bb00'] },
      second: { ...palettes.pico8, colors: ['#aa0000', '#00BB00'] },
      reordered: { ...palettes.pico8, colors: ['#00bb00', '#aa0000'] },
    };
    expect(matchingPaletteKey(catalog, ['#aa0000', '#00bb00'])).toBe('first');
    expect(matchingPaletteKey(catalog, ['#aa0000', '#00bb00'], 'second')).toBe('second');
    expect(matchingPaletteKey(catalog, ['#00bb00', '#aa0000'])).toBe('reordered');
    expect(matchingPaletteKey(catalog, ['#aa0000', '#00bb01'])).toBeNull();
  });

  it('selects a matching preset or persists an unmatched embedded palette', () => {
    const existing = createCustomPalette('Existing', '', ['#112233', '#445566'], new Date('2026-01-01'));
    upsertCustomPalette(storage, existing);
    const catalog = { pico8: palettes.pico8, [existing.key]: existing };
    const selected = selectOrCreatePalette(storage, catalog, { ...palettes.pico8, colors: ['#112233', '#445566'] });
    expect(selected).toEqual({ key: existing.key, customPalettes: [existing], created: false });

    const created = selectOrCreatePalette(storage, catalog, {
      ...palettes.pico8,
      name: 'N'.repeat(80),
      description: 'D'.repeat(200),
      colors: ['#abcdef', '#123456'],
    });
    expect(created.created).toBe(true);
    expect(created.customPalettes).toHaveLength(2);
    expect(created.customPalettes[0].key).toBe(created.key);
    expect(created.customPalettes[0].name).toHaveLength(60);
    expect(created.customPalettes[0].description).toHaveLength(160);
  });

  it('persists, updates, and deletes by stable key', () => {
    const first = createCustomPalette('One', '', ['#000000', '#ffffff']);
    expect(upsertCustomPalette(storage, first)).toHaveLength(1);
    const updated = updateCustomPalette(first, 'One Updated', '', ['#111111', '#eeeeee']);
    expect(upsertCustomPalette(storage, updated)[0].name).toBe('One Updated');
    expect(deleteCustomPalette(storage, first.key)).toEqual([]);
    expect(storage.data.has(CUSTOM_PALETTE_STORAGE_KEY)).toBe(true);
  });

  it('returns nothing for absent storage and throws for blocked, corrupt, or non-array data', () => {
    expect(loadCustomPalettes(storage)).toEqual([]);
    storage.shouldThrow = true;
    expect(() => loadCustomPalettes(storage)).toThrow('Reading stored data');
    storage.shouldThrow = false;
    storage.data.set(CUSTOM_PALETTE_STORAGE_KEY, '{bad');
    expect(() => loadCustomPalettes(storage)).toThrow('corrupt JSON');
    storage.data.set(CUSTOM_PALETTE_STORAGE_KEY, '{}');
    expect(() => loadCustomPalettes(storage)).toThrow('not an array');
  });

  it('drops invalid entries and keeps valid ones', () => {
    const valid = createCustomPalette('Valid', '', ['#000000', '#ffffff']);
    storage.data.set(CUSTOM_PALETTE_STORAGE_KEY, JSON.stringify([{}, valid]));
    expect(loadCustomPalettes(storage)).toEqual([valid]);
  });

});
