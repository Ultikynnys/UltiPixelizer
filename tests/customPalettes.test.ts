import { beforeEach, describe, expect, it, vi } from 'vitest';
import { palettes } from '../src/lib/palettes';
import {
  CUSTOM_PALETTE_STORAGE_KEY,
  createCustomPalette,
  deleteCustomPalette,
  deleteCustomPaletteFile,
  duplicatePalette,
  extractHexColors,
  filePaletteFor,
  isCustomPalette,
  loadCustomPalettes,
  loadCustomPalettesFromFiles,
  matchingPaletteKey,
  paletteFileName,
  paletteFromHexFile,
  paletteFromImport,
  paletteKeyFromFileName,
  saveCustomPaletteFile,
  selectOrCreatePalette,
  serializePaletteHex,
  updateCustomPalette,
  upsertCustomPalette,
  type StorageLike,
} from '../src/lib/customPalettes';
import type { TauriFileStore, TauriStorageLocation } from '../src/lib/tauri';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  shouldThrow = false;
  getItem(key: string): string | null { if (this.shouldThrow) throw new Error('blocked'); return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.shouldThrow) throw new Error('quota'); this.data.set(key, value); }
}

let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

describe('custom palettes', () => {
  it('creates complete portable palettes and round-trips them as .hex text', () => {
    const palette = createCustomPalette('My Colors', ['#000000', '#ffffff'], new Date('2026-01-02T03:04:05Z'));
    expect(palette.key).toBe('custom-1767323045000-my-colors');
    expect(isCustomPalette(palette)).toBe(true);
    // The .hex file is a plain hex list, one color per line (Lospec-style).
    expect(serializePaletteHex(palette)).toBe('000000\nffffff\n');
    expect(extractHexColors(serializePaletteHex(palette))).toEqual(['#000000', '#FFFFFF']);
  });

  it('duplicates built-ins independently and updates while preserving identity', () => {
    const duplicate = duplicatePalette(palettes.pico8, new Date('2026-01-01'));
    duplicate.colors[0] = '#123456';
    expect(palettes.pico8.colors[0]).not.toBe('#123456');
    const updated = updateCustomPalette(duplicate, 'Edited', ['#111111', '#eeeeee'], new Date('2026-01-02'));
    expect(updated.key).toBe(duplicate.key);
    expect(updated.createdAt).toBe(duplicate.createdAt);
    expect(updated.name).toBe('Edited');
  });

  it('rejects invalid names and color counts', () => {
    expect(() => createCustomPalette('', ['#000000', '#ffffff'])).toThrow('2–256');
    expect(() => createCustomPalette('Bad', ['#000000'])).toThrow('2–256');
    expect(() => createCustomPalette('Bad', Array(257).fill('#000000'))).toThrow('2–256');
    expect(() => createCustomPalette('x'.repeat(61), ['#000000', '#ffffff'])).toThrow('2–256');
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
    const existing = createCustomPalette('Existing', ['#112233', '#445566'], new Date('2026-01-01'));
    upsertCustomPalette(storage, existing);
    const catalog = { pico8: palettes.pico8, [existing.key]: existing };
    const selected = selectOrCreatePalette(storage, catalog, { ...palettes.pico8, colors: ['#112233', '#445566'] });
    expect(selected).toEqual({ key: existing.key, customPalettes: [existing], created: false });

    const created = selectOrCreatePalette(storage, catalog, {
      ...palettes.pico8,
      name: 'N'.repeat(80),
      colors: ['#abcdef', '#123456'],
    });
    expect(created.created).toBe(true);
    expect(created.customPalettes).toHaveLength(2);
    expect(created.customPalettes[1].key).toBe(created.key);
    expect(created.customPalettes[1].name).toHaveLength(60);
  });

  it('persists, updates, and deletes by stable key', () => {
    const first = createCustomPalette('One', ['#000000', '#ffffff']);
    expect(upsertCustomPalette(storage, first)).toHaveLength(1);
    const updated = updateCustomPalette(first, 'One Updated', ['#111111', '#eeeeee']);
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
    const valid = createCustomPalette('Valid', ['#000000', '#ffffff']);
    storage.data.set(CUSTOM_PALETTE_STORAGE_KEY, JSON.stringify([{}, valid]));
    expect(loadCustomPalettes(storage)).toEqual([valid]);
  });
});

describe('palette import', () => {
  it('extracts bare, #-prefixed, and shorthand hex from text, de-duplicating in order', () => {
    expect(extractHexColors('1a1c2c\n1A1C2C\n5d275d')).toEqual(['#1A1C2C', '#5D275D']);
    expect(extractHexColors('#fff #123456 ffcc00')).toEqual(['#FFFFFF', '#123456', '#FFCC00']);
    expect(extractHexColors('deadbeef')).toEqual([]);
    expect(extractHexColors('no colors here')).toEqual([]);
  });

  it('imports a plain-text Lospec .hex list, naming the palette from the file', () => {
    const palette = paletteFromImport('1a1c2c\n5d275d\nb13e53\n', 'sweetie-16.hex');
    expect(palette.name).toBe('sweetie-16');
    expect(palette.colors).toEqual(['#1A1C2C', '#5D275D', '#B13E53']);
    expect(isCustomPalette(palette)).toBe(true);
  });

  it('imports a bare 6-digit hex list with one color per line', () => {
    // Real-world payload: 41 colors, no "#" prefix, no separators beyond newlines.
    const hex = `1c1c1f
232636
4d6378
72939e
a2bdba
c1d6cc
a8b3ad
7c8e8f
637178
4e5e69
2f3c4d
37585c
458575
6eb88f
aad9a5
dce3cc
c3ccdb
99a3c2
72709e
5c5078
50395c
2b2336
6d4f73
9c7090
c299a4
d6c2bf
f0e4e1
dba9a2
c78189
9e555e
70384c
2e1e29
452a34
573539
8c6253
b58d79
d9c5a5
f0ecc7
c4bd93
a18a64
7a5d45`;
    const palette = paletteFromImport(hex, 'custom.hex');
    expect(palette.name).toBe('custom');
    expect(palette.colors).toHaveLength(41);
    expect(palette.colors[0]).toBe('#1C1C1F');
    expect(palette.colors[40]).toBe('#7A5D45');
    expect(new Set(palette.colors).size).toBe(41);
    expect(isCustomPalette(palette)).toBe(true);
  });

  it('rejects invalid, empty, and unsupported imports', () => {
    expect(() => paletteFromImport('', 'empty.hex')).toThrow('no valid colors');
    expect(() => paletteFromImport('#ffffff', 'one.hex')).toThrow('no valid colors');
    // JSON payloads are not a palette format anymore — they yield no hex colors.
    expect(() => paletteFromImport('{bad', 'bad.json')).toThrow('no valid colors');
    expect(() => paletteFromImport('{}', 'empty.json')).toThrow('no valid colors');
    expect(() => paletteFromImport('{"colors":["nothex"]}', 'bad.json')).toThrow('no valid colors');
  });
});

// ---------------------------------------------------------------------------
// Desktop .hex file store: one file per palette, named after the palette
// ---------------------------------------------------------------------------

class FakeFileStore implements TauriFileStore {
  location: TauriStorageLocation = 'install';
  dir = 'C:/Program Files/UltiPixelizer';
  files = new Map<string, string>();

  async preload(file: string): Promise<string | null> {
    return this.files.get(file) ?? null;
  }

  async write(file: string, contents: string): Promise<void> {
    this.files.set(file, contents);
  }

  async remove(file: string): Promise<void> {
    this.files.delete(file);
  }

  async list(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    return [...this.files.keys()]
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length))
      .sort();
  }
}

describe('desktop .hex file store', () => {
  it('names palette files after the palette, Windows-safe', () => {
    expect(paletteFileName('My Colors')).toBe('My Colors.hex');
    expect(paletteFileName('A:B*C?')).toBe('A-B-C-.hex');
    expect(paletteFileName('Name. ')).toBe('Name.hex');
    expect(paletteFileName('.hidden')).toBe('hidden.hex'); // Rust rejects leading dots
    expect(paletteFileName('')).toBe('custom-palette.hex');
    expect(paletteFileName('   ')).toBe('custom-palette.hex');
  });

  it('derives the palette key from the file name', () => {
    expect(paletteKeyFromFileName('My Colors.hex')).toBe('custom-my-colors');
    expect(paletteKeyFromFileName('sweetie-16.HEX')).toBe('custom-sweetie-16');
    expect(paletteKeyFromFileName('123.hex')).toBe('custom-123');
  });

  it('builds a palette from a .hex file, naming it from the file name', () => {
    const palette = paletteFromHexFile('sweetie-16.hex', '1a1c2c\n5d275d\nb13e53\n', new Date('2026-01-02T03:04:05Z'));
    expect(palette.name).toBe('sweetie-16');
    expect(palette.key).toBe('custom-sweetie-16');
    expect(palette.colors).toEqual(['#1A1C2C', '#5D275D', '#B13E53']);
    expect(isCustomPalette(palette)).toBe(true);
  });

  it('round-trips a palette through its .hex file', async () => {
    const store = new FakeFileStore();
    const filePalette = filePaletteFor(createCustomPalette('My Colors', ['#000000', '#ffffff'], new Date('2026-01-02T03:04:05Z')));
    await saveCustomPaletteFile(store, filePalette);
    expect(store.files.get('palettes/My Colors.hex')).toBe('000000\nffffff\n');

    const [loaded] = await loadCustomPalettesFromFiles(store);
    expect(loaded.name).toBe('My Colors');
    expect(loaded.key).toBe('custom-my-colors');
    expect(loaded.colors).toEqual(['#000000', '#FFFFFF']);
    expect(isCustomPalette(loaded)).toBe(true);
  });

  it('loads every .hex file in the palettes folder, skipping non-palette files', async () => {
    const store = new FakeFileStore();
    store.files.set('palettes/One.hex', '000000\nffffff\n');
    store.files.set('palettes/Two.hex', '112233\n445566\n');
    store.files.set('palettes/README.txt', 'not a palette');
    store.files.set('config/settings.json', '{}');
    const palettes = await loadCustomPalettesFromFiles(store);
    expect(palettes.map((palette) => palette.name)).toEqual(['One', 'Two']);
  });

  it('drops invalid .hex files with a warning instead of failing the load', async () => {
    const store = new FakeFileStore();
    store.files.set('palettes/Bad.hex', 'no colors here');
    store.files.set('palettes/Good.hex', '000000\nffffff\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const palettes = await loadCustomPalettesFromFiles(store);
    expect(palettes).toHaveLength(1);
    expect(palettes[0].name).toBe('Good');
    warn.mockRestore();
  });

  it('keeps the first palette when two file names sanitize to the same key', async () => {
    const store = new FakeFileStore();
    store.files.set('palettes/My Palette.hex', '000000\nffffff\n');
    store.files.set('palettes/my-palette.hex', '111111\neeeeee\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const palettes = await loadCustomPalettesFromFiles(store);
    expect(palettes).toHaveLength(1);
    expect(palettes[0].name).toBe('My Palette');
    warn.mockRestore();
  });

  it('deletes a palette file by name', async () => {
    const store = new FakeFileStore();
    store.files.set('palettes/My Colors.hex', '000000\nffffff\n');
    await deleteCustomPaletteFile(store, 'My Colors');
    expect(store.files.has('palettes/My Colors.hex')).toBe(false);
  });
});
