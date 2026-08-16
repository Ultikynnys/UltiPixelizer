import { isPalette, type Palette } from './palettes';
import { createStoredCollection, parseJsonFile, serializeJsonFile, type StorageLike } from './storage';
import { slugify } from './strings';
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

export function parseCustomPalette(json: string): CustomPalette {
  return parseJsonFile(json, isCustomPalette, {
    invalidJson: 'Palette file is not valid JSON.',
    invalidData: 'Palette file has invalid or unsupported data.',
  }, { after: (palette) => ({ ...palette, colors: [...palette.colors] }) });
}

export function serializeCustomPalette(palette: CustomPalette): string {
  return serializeJsonFile(palette, isCustomPalette, 'Cannot export an invalid custom palette.');
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
 * Parses a palette import in any supported format:
 * - the app's own `.palette.json` (CustomPalette round-trip),
 * - Lospec `.json` (`{ name, author, colors }`),
 * - plain-text hex lists (Lospec `.hex`, `.txt`).
 */
export function paletteFromImport(text: string, fileName?: string): CustomPalette {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new Error('Palette file is not valid JSON.', { cause: error });
    }
    if (isCustomPalette(value)) return { ...value, colors: [...value.colors] };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.colors)) {
        const colors: string[] = [];
        for (const entry of record.colors) {
          const normalized = typeof entry === 'string' ? normalizeHex(entry) : null;
          if (!normalized) throw new Error('Palette file has no valid colors.');
          colors.push(normalized);
        }
        if (colors.length < 2 || colors.length > 256) throw new Error('Palette file has no valid colors.');
        const name = (typeof record.name === 'string' && record.name.trim() ? record.name : paletteNameFromFile(fileName)).slice(0, 60);
        return createCustomPalette(name, colors);
      }
    }
    throw new Error('Palette file has invalid or unsupported data.');
  }

  const colors = extractHexColors(trimmed);
  if (colors.length < 2 || colors.length > 256) throw new Error('Palette file has no valid colors.');
  return createCustomPalette(paletteNameFromFile(fileName).slice(0, 60), colors);
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
