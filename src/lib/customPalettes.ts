import { isPalette, type Palette } from './palettes';

export const CUSTOM_PALETTE_VERSION = 1;
export const CUSTOM_PALETTE_STORAGE_KEY = 'ultipixelizer:custom-palettes:v1';

export type CustomPalette = Palette & {
  category: 'custom';
  version: typeof CUSTOM_PALETTE_VERSION;
  key: string;
  createdAt: string;
  updatedAt: string;
};

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function isCustomPalette(value: unknown): value is CustomPalette {
  if (!isPalette(value) || value.category !== 'custom') return false;
  const candidate = value as Partial<CustomPalette>;
  return candidate.version === CUSTOM_PALETTE_VERSION
    && value.name.length <= 60 && value.description.length <= 160
    && typeof candidate.key === 'string' && /^custom-[a-z0-9][a-z0-9-]{0,55}$/i.test(candidate.key)
    && typeof candidate.createdAt === 'string' && !Number.isNaN(Date.parse(candidate.createdAt))
    && typeof candidate.updatedAt === 'string' && !Number.isNaN(Date.parse(candidate.updatedAt));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'palette';
}

export function createCustomPalette(name: string, description: string, colors: string[], now = new Date(), key?: string): CustomPalette {
  const normalizedName = name.trim();
  const palette: CustomPalette = {
    version: CUSTOM_PALETTE_VERSION,
    key: key ?? `custom-${now.getTime()}-${slug(normalizedName)}`,
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

export function loadCustomPalettes(storage: StorageLike): CustomPalette[] {
  try {
    const raw = storage.getItem(CUSTOM_PALETTE_STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isCustomPalette).map((palette) => ({ ...palette, colors: [...palette.colors] })) : [];
  } catch {
    return [];
  }
}

export function saveCustomPalettes(storage: StorageLike, palettes: CustomPalette[]): void {
  if (!palettes.every(isCustomPalette)) throw new Error('Custom palette library contains invalid data.');
  try {
    storage.setItem(CUSTOM_PALETTE_STORAGE_KEY, JSON.stringify(palettes));
  } catch {
    throw new Error('Could not save custom palettes. Browser storage may be full or blocked.');
  }
}

export function upsertCustomPalette(storage: StorageLike, palette: CustomPalette): CustomPalette[] {
  const library = loadCustomPalettes(storage);
  const index = library.findIndex((entry) => entry.key === palette.key);
  if (index >= 0) library[index] = palette;
  else library.unshift(palette);
  saveCustomPalettes(storage, library);
  return library;
}

export function deleteCustomPalette(storage: StorageLike, key: string): CustomPalette[] {
  const library = loadCustomPalettes(storage).filter((palette) => palette.key !== key);
  saveCustomPalettes(storage, library);
  return library;
}
