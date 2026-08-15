import { isPalette, type Palette } from './palettes';
import type { DitherMode } from './dither';

export const PRESET_VERSION = 1;
export const PRESET_STORAGE_KEY = 'ditherlab:conversion-presets:v1';

export const ditherModes: DitherMode[] = ['floyd', 'atkinson', 'ordered', 'cross', 'stripes', 'noise', 'checker', 'none'];

export type AoMode = 'none' | 'import' | 'generate';
export const aoModes: AoMode[] = ['none', 'import', 'generate'];

export type ConversionConfig = {
  resolution: number;
  mode: DitherMode;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  paletteKey: string;
  palette: Palette;
  uvMap: string;
  stripeAngle: number;
  noiseScale: number;
  aoMode: AoMode;
  aoIntensity: number;
  aoInvert: boolean;
};

export type ConversionPreset = ConversionConfig & {
  version: typeof PRESET_VERSION;
  id: string;
  name: string;
  description: string;
  createdAt: string;
};

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const finiteInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

export function isConversionPreset(value: unknown): value is ConversionPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<ConversionPreset>;
  return preset.version === PRESET_VERSION
    && typeof preset.id === 'string' && /^[a-z0-9][a-z0-9-]{0,119}$/i.test(preset.id)
    && typeof preset.name === 'string' && preset.name.trim().length > 0 && preset.name.length <= 60
    && typeof preset.description === 'string' && preset.description.length <= 160
    && typeof preset.createdAt === 'string' && !Number.isNaN(Date.parse(preset.createdAt))
    && finiteInRange(preset.resolution, 1, 4096)
    && ditherModes.includes(preset.mode as DitherMode)
    && finiteInRange(preset.strength, 0, 1)
    && finiteInRange(preset.brightness, -100, 100)
    && finiteInRange(preset.contrast, -100, 100)
    && finiteInRange(preset.saturation, -100, 100)
    && typeof preset.paletteKey === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(preset.paletteKey)
    && typeof preset.uvMap === 'string' && /^uv\d*$/.test(preset.uvMap)
    && finiteInRange(preset.stripeAngle, 0, 135)
    && finiteInRange(preset.noiseScale, 1, 32)
    && aoModes.includes(preset.aoMode as AoMode)
    && finiteInRange(preset.aoIntensity, 0, 1)
    && typeof preset.aoInvert === 'boolean'
    && isPalette(preset.palette);
}

export function createPreset(name: string, description: string, config: ConversionConfig, now = new Date()): ConversionPreset {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('Preset name is required.');
  return {
    version: PRESET_VERSION,
    id: `${now.getTime()}-${normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset'}`,
    name: normalizedName,
    description: description.trim(),
    createdAt: now.toISOString(),
    ...config,
    palette: { ...config.palette, colors: [...config.palette.colors] },
  };
}

export function serializePreset(preset: ConversionPreset): string {
  if (!isConversionPreset(preset)) throw new Error('Cannot export an invalid preset.');
  return JSON.stringify(preset, null, 2);
}

function migratePreset(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const preset = value as Record<string, unknown>;
  if (preset.version !== PRESET_VERSION) return value;
  const migrated: Record<string, unknown> = { ...preset };
  if (migrated.mode === 'diagonal') {
    migrated.mode = 'stripes';
    migrated.stripeAngle = 45;
  } else if (migrated.mode === 'vertical') {
    migrated.mode = 'stripes';
    migrated.stripeAngle = 0;
  }
  if (migrated.stripeAngle === undefined) migrated.stripeAngle = 45;
  if (migrated.noiseScale === undefined) migrated.noiseScale = 1;
  if (migrated.uvMap === undefined) migrated.uvMap = 'uv';
  if (migrated.aoMode === undefined) migrated.aoMode = 'none';
  if (migrated.aoIntensity === undefined) migrated.aoIntensity = 1;
  if (migrated.aoInvert === undefined) migrated.aoInvert = false;
  return migrated;
}

export function parsePreset(json: string): ConversionPreset {
  let value: unknown;
  try {
    value = migratePreset(JSON.parse(json));
  } catch {
    throw new Error('Preset file is not valid JSON.');
  }
  if (!isConversionPreset(value)) throw new Error('Preset file has invalid or unsupported settings.');
  return value;
}

export function loadPresetLibrary(storage: StorageLike): ConversionPreset[] {
  const raw = storage.getItem(PRESET_STORAGE_KEY);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.map(migratePreset).filter(isConversionPreset) : [];
  } catch {
    return [];
  }
}

export function savePresetLibrary(storage: StorageLike, presets: ConversionPreset[]): void {
  if (!presets.every(isConversionPreset)) throw new Error('Preset library contains invalid data.');
  storage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

export function upsertPreset(storage: StorageLike, preset: ConversionPreset): ConversionPreset[] {
  const library = loadPresetLibrary(storage);
  const matchingIndex = library.findIndex((entry) => entry.name.toLowerCase() === preset.name.toLowerCase());
  if (matchingIndex >= 0) library[matchingIndex] = preset;
  else library.unshift(preset);
  savePresetLibrary(storage, library);
  return library;
}

export function deletePreset(storage: StorageLike, id: string): ConversionPreset[] {
  const library = loadPresetLibrary(storage).filter((preset) => preset.id !== id);
  savePresetLibrary(storage, library);
  return library;
}
