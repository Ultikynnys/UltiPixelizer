import { isPalette, type Palette } from './palettes';
import { createStoredCollection, type StorageLike } from './storage';
import { slugify } from './strings';
import { CUSTOM_PALETTES_FOLDER, type TauriFileStore } from './tauri';
export type { StorageLike } from './storage';

export const CUSTOM_PALETTE_VERSION = 1;
export const CUSTOM_PALETTE_STORAGE_KEY = 'ultipixelizer:custom-palettes:v1';

export type CustomPalette = Palette & {
  category: 'custom';
  version: typeof CUSTOM_PALETTE_VERSION;
  key: string;
  createdAt: string;
  updatedAt: string;
};


export function isCustomPalette(value: unknown): value is CustomPalette {
  if (!isPalette(value) || value.category !== 'custom') return false;
  const candidate = value as Partial<CustomPalette>;
  return candidate.version === CUSTOM_PALETTE_VERSION
    && value.name.length <= 60
    && typeof candidate.key === 'string' && /^custom-[a-z0-9][a-z0-9-]{0,55}$/i.test(candidate.key)
    && typeof candidate.createdAt === 'string' && !Number.isNaN(Date.parse(candidate.createdAt))
    && typeof candidate.updatedAt === 'string' && !Number.isNaN(Date.parse(candidate.updatedAt));
}

export function createCustomPalette(name: string, colors: string[], now = new Date(), key?: string): CustomPalette {
  const normalizedName = name.trim();
  const palette: CustomPalette = {
    version: CUSTOM_PALETTE_VERSION,
    key: key ?? `custom-${now.getTime()}-${slugify(normalizedName, 'palette', 40)}`,
    name: normalizedName,
    category: 'custom',
    colors: [...colors],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (!isCustomPalette(palette)) throw new Error('Custom palette must have a name and 2–256 valid colors.');
  return palette;
}

export function duplicatePalette(source: Palette, now = new Date()): CustomPalette {
  return createCustomPalette(`${source.name} Copy`, source.colors, now);
}

export function updateCustomPalette(source: CustomPalette, name: string, colors: string[], now = new Date()): CustomPalette {
  const updated = createCustomPalette(name, colors, now, source.key);
  updated.createdAt = source.createdAt;
  if (!isCustomPalette(updated)) throw new Error('Custom palette update is invalid.');
  return updated;
}

const hexColorToken = /#([0-9a-f]{6}|[0-9a-f]{3})\b|\b([0-9a-f]{6})\b/gi;

/** Normalizes a hex token (bare or "#"-prefixed, 3 or 6 digits) to an uppercase
 * "#RRGGBB" string, expanding shorthand. Returns null for anything else. */
function normalizeHex(raw: string): string | null {
  const digits = raw.replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(digits)) {
    return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`.toUpperCase();
  }
  if (/^[0-9a-f]{6}$/.test(digits)) return `#${digits.toUpperCase()}`;
  return null;
}

/** Extracts every hex color from arbitrary text (e.g. a Lospec `.hex` list) as
 * an ordered, de-duplicated array of "#RRGGBB" strings. Accepts bare and
 * "#"-prefixed values, plus "#RGB" shorthand. */
export function extractHexColors(text: string): string[] {
  const colors: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(hexColorToken)) {
    const color = normalizeHex(match[0]);
    if (!color || seen.has(color)) continue;
    seen.add(color);
    colors.push(color);
  }
  return colors;
}

/** Derives a palette name from a file name, falling back when absent. */
function paletteNameFromFile(fileName: string | undefined): string {
  const base = (fileName ?? '').replace(/\.[^.]+$/, '').trim();
  return base || 'Imported palette';
}

/**
 * Parses a palette import: plain-text hex lists (Lospec `.hex`, `.txt`).
 * The palette name derives from the file name, minus the extension.
 */
export function paletteFromImport(text: string, fileName?: string): CustomPalette {
  const colors = extractHexColors(text.trim());
  if (colors.length < 2 || colors.length > 256) throw new Error('Palette file has no valid colors.');
  return createCustomPalette(paletteNameFromFile(fileName).slice(0, 60), colors);
}

// ---------------------------------------------------------------------------
// Desktop .hex file store: one file per palette, named after the palette
// ---------------------------------------------------------------------------

/** Windows-safe file name for a palette: the palette name IS the file name
 * (minus the ".hex" extension), so spaces and case are preserved. Leading and
 * trailing dots/whitespace are stripped — the Rust validator rejects names
 * starting with a dot, so the two sides must agree. */
export function paletteFileName(name: string): string {
  const sanitized = name.replace(/[<>:"/\\|?*]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '');
  return `${sanitized || 'custom-palette'}.hex`;
}

/** Key derived from a palette file name — identity follows the file name, so
 * renaming a palette (its file) re-keys it. */
export function paletteKeyFromFileName(fileName: string): string {
  return `custom-${slugify(fileName.replace(/\.hex$/i, ''), 'palette', 40)}`;
}

/** Desktop palette identity: the key derives from the name (the file name). */
export function filePaletteFor(palette: CustomPalette): CustomPalette {
  return { ...palette, key: paletteKeyFromFileName(palette.name) };
}

/** Serializes a palette as a Lospec-style `.hex` list: one bare lowercase hex
 * color per line. Round-trips through `extractHexColors`. */
export function serializePaletteHex(palette: Palette): string {
  return `${palette.colors.map((color) => color.slice(1).toLowerCase()).join('\n')}\n`;
}

/** Builds a custom palette from a `.hex` file's contents; the palette name is
 * the file name with the ".hex" extension dropped. */
export function paletteFromHexFile(fileName: string, text: string, now = new Date()): CustomPalette {
  const colors = extractHexColors(text);
  if (colors.length < 2 || colors.length > 256) throw new Error('Palette file has no valid colors.');
  return {
    version: CUSTOM_PALETTE_VERSION,
    key: paletteKeyFromFileName(fileName),
    name: (fileName.replace(/\.hex$/i, '').trim() || 'Imported palette').slice(0, 60),
    category: 'custom',
    colors,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** Loads every palette from the desktop palettes folder: one `.hex` file per
 * palette, name derived from the file name. Unparseable files are skipped
 * with a warning, like invalid entries in the web storage library, and names
 * that sanitize to the same key (e.g. "My Palette" vs "my-palette") keep the
 * first one. */
export async function loadCustomPalettesFromFiles(store: TauriFileStore): Promise<CustomPalette[]> {
  const palettes: CustomPalette[] = [];
  const seen = new Set<string>();
  const names = await store.list(CUSTOM_PALETTES_FOLDER);
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.hex')) continue;
    const text = await store.preload(`${CUSTOM_PALETTES_FOLDER}/${name}`);
    if (text === null) continue;
    try {
      const palette = paletteFromHexFile(name, text);
      if (seen.has(palette.key)) {
        console.warn(`Dropping a palette file "${name}" that duplicates "${palette.name}".`);
        continue;
      }
      seen.add(palette.key);
      palettes.push(palette);
    } catch (error) {
      console.warn(`Dropping an invalid palette file "${name}".`, error);
    }
  }
  return palettes;
}

/** Persists one palette as `palettes/<name>.hex` (overwriting any file with
 * the same name). */
export async function saveCustomPaletteFile(store: TauriFileStore, palette: CustomPalette): Promise<void> {
  await store.write(`${CUSTOM_PALETTES_FOLDER}/${paletteFileName(palette.name)}`, serializePaletteHex(palette));
}

/** Deletes one palette's file; absent files are a no-op. */
export async function deleteCustomPaletteFile(store: TauriFileStore, name: string): Promise<void> {
  await store.remove(`${CUSTOM_PALETTES_FOLDER}/${paletteFileName(name)}`);
}

export function matchingPaletteKey(catalog: Record<string, Palette>, colors: string[], preferredKey?: string): string | null {
  const matches = (palette: Palette | undefined): boolean => palette?.colors.length === colors.length
    && palette.colors.every((color, index) => color.toLowerCase() === colors[index].toLowerCase());
  if (preferredKey && matches(catalog[preferredKey])) return preferredKey;
  return Object.entries(catalog).find(([, palette]) => matches(palette))?.[0] ?? null;
}

export function selectOrCreatePalette(
  storage: StorageLike,
  catalog: Record<string, Palette>,
  embedded: Palette,
  preferredKey?: string,
): { key: string; customPalettes: CustomPalette[]; created: boolean } {
  const match = matchingPaletteKey(catalog, embedded.colors, preferredKey);
  if (match) return { key: match, customPalettes: loadCustomPalettes(storage), created: false };
  const imported = createCustomPalette(embedded.name.slice(0, 60), embedded.colors);
  return { key: imported.key, customPalettes: upsertCustomPalette(storage, imported), created: true };
}

const customPaletteLibrary = createStoredCollection<CustomPalette>({
  storageKey: CUSTOM_PALETTE_STORAGE_KEY,
  validate: isCustomPalette,
  clone: (palette) => ({ ...palette, colors: [...palette.colors] }),
  invalidSaveMessage: 'Custom palette library contains invalid data.',
  saveErrorMessage: 'Could not save custom palettes. Browser storage may be full or blocked.',
});

export function loadCustomPalettes(storage: StorageLike): CustomPalette[] {
  return customPaletteLibrary.load(storage);
}

export function upsertCustomPalette(storage: StorageLike, palette: CustomPalette): CustomPalette[] {
  return customPaletteLibrary.upsert(storage, palette, (entry) => entry.key);
}

export function deleteCustomPalette(storage: StorageLike, key: string): CustomPalette[] {
  return customPaletteLibrary.remove(storage, key, (entry) => entry.key);
}
