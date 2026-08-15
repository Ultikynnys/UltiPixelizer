import { isPalette, type Palette } from './palettes';
import { createStoredCollection, type StorageLike } from './storage';
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
    && value.name.length <= 60 && value.description.length <= 160
    && typeof candidate.key === 'string' && /^custom-[a-z0-9][a-z0-9-]{0,55}$/i.test(candidate.key)
    && typeof candidate.createdAt === 'string' && !Number.isNaN(Date.parse(candidate.createdAt))
    && typeof candidate.updatedAt === 'string' && !Number.isNaN(Date.parse(candidate.updatedAt));
}

export function createCustomPalette(name: string, description: string, colors: string[], now = new Date(), key?: string): CustomPalette {
  const normalizedName = name.trim();
  const palette: CustomPalette = {
    version: CUSTOM_PALETTE_VERSION,
    key: key ?? `custom-${now.getTime()}-${slugify(normalizedName, 'palette', 40)}`,
    name: normalizedName,
    description: description.trim() || 'Custom color palette',
    category: 'custom',
    colors: [...colors],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (!isCustomPalette(palette)) throw new Error('Custom palette must have a name and 2–256 valid colors.');
  return palette;
}

export function duplicatePalette(source: Palette, now = new Date()): CustomPalette {
  return createCustomPalette(`${source.name} Copy`, `Custom copy of ${source.name}`, source.colors, now);
}

export function updateCustomPalette(source: CustomPalette, name: string, description: string, colors: string[], now = new Date()): CustomPalette {
  const updated = createCustomPalette(name, description, colors, now, source.key);
  updated.createdAt = source.createdAt;
  if (!isCustomPalette(updated)) throw new Error('Custom palette update is invalid.');
  return updated;
}

export function parseCustomPalette(json: string): CustomPalette {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Palette file is not valid JSON.');
  }
  if (!isCustomPalette(value)) throw new Error('Palette file has invalid or unsupported data.');
  return { ...value, colors: [...value.colors] };
}

export function serializeCustomPalette(palette: CustomPalette): string {
  if (!isCustomPalette(palette)) throw new Error('Cannot export an invalid custom palette.');
  return JSON.stringify(palette, null, 2);
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
  const imported = createCustomPalette(embedded.name.slice(0, 60), embedded.description.slice(0, 160), embedded.colors);
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

export function saveCustomPalettes(storage: StorageLike, palettes: CustomPalette[]): void {
  customPaletteLibrary.save(storage, palettes);
}

export function upsertCustomPalette(storage: StorageLike, palette: CustomPalette): CustomPalette[] {
  return customPaletteLibrary.upsert(storage, palette, (entry) => entry.key);
}

export function deleteCustomPalette(storage: StorageLike, key: string): CustomPalette[] {
  return customPaletteLibrary.remove(storage, key, (entry) => entry.key);
}
