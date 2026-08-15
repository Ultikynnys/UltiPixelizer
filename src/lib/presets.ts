import { isHexColor, isPalette, type Palette } from './palettes';
import type { DitherMode } from './dither';
import { createStoredCollection, type StorageLike } from './storage';
import { slugify } from './strings';
import { DEFAULT_AMBIENT_INTENSITY, DEFAULT_SUN_INTENSITY } from './defaults';
import type { NormalFormat } from './normal';
export type { StorageLike } from './storage';

export const PRESET_VERSION = 4;
export const PRESET_STORAGE_KEY = 'ultipixelizer:conversion-presets:v1';

export const ditherModes: DitherMode[] = ['floyd', 'atkinson', 'ordered', 'cross', 'stripes', 'noise', 'checker', 'none'];

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
  seed: number;
  aoBias: number;
  aoScale: number;
  aoDistance: number;
  sunColor: string;
  sunIntensity: number;
  ambientColor: string;
  ambientIntensity: number;
  lightmapContribution: number;
  normalStrength: number;
  normalFormat: NormalFormat;
};

export type ConversionPreset = ConversionConfig & {
  version: typeof PRESET_VERSION;
  id: string;
  name: string;
  description: string;
  createdAt: string;
};


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
    && finiteInRange(preset.seed, 0, 9999)
    && finiteInRange(preset.aoBias, -1, 1)
    && finiteInRange(preset.aoScale, 0, 2)
    && finiteInRange(preset.aoDistance, 0.05, 3)
    && typeof preset.sunColor === 'string' && isHexColor(preset.sunColor)
    && finiteInRange(preset.sunIntensity, 0, 10)
    && typeof preset.ambientColor === 'string' && isHexColor(preset.ambientColor)
    && finiteInRange(preset.ambientIntensity, 0, 5)
    && finiteInRange(preset.lightmapContribution, 0, 1)
    && finiteInRange(preset.normalStrength, 0, 1)
    && (preset.normalFormat === 'opengl' || preset.normalFormat === 'directx')
    && isPalette(preset.palette);
}

export function createPreset(name: string, description: string, config: ConversionConfig, now = new Date()): ConversionPreset {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('Preset name is required.');
  return {
    version: PRESET_VERSION,
    id: `${now.getTime()}-${slugify(normalizedName, 'preset')}`,
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
  let preset = value as Record<string, unknown>;
  if (preset.version === 1) {
    const { aoIntensity, ...rest } = preset;
    preset = { ...rest, version: 2, aoBias: 0, aoScale: typeof aoIntensity === 'number' ? aoIntensity : 1 };
  }
  if (preset.version === 2) preset = { ...preset, version: 3 };
  if (preset.version === 3) preset = { ...preset, version: PRESET_VERSION };
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
  if (migrated.seed === undefined) migrated.seed = 1;
  if (migrated.uvMap === undefined) migrated.uvMap = 'uv';
  if (migrated.aoBias === undefined) migrated.aoBias = 0;
  if (migrated.aoScale === undefined) migrated.aoScale = 1;
  if (migrated.aoDistance === undefined) migrated.aoDistance = 2;
  if (migrated.sunColor === undefined) migrated.sunColor = '#ffffff';
  if (migrated.sunIntensity === undefined) migrated.sunIntensity = DEFAULT_SUN_INTENSITY;
  if (migrated.ambientColor === undefined) migrated.ambientColor = '#ffffff';
  if (migrated.ambientIntensity === undefined) migrated.ambientIntensity = DEFAULT_AMBIENT_INTENSITY;
  if (migrated.lightmapContribution === undefined) migrated.lightmapContribution = 1;
  if (migrated.normalStrength === undefined) migrated.normalStrength = 1;
  if (migrated.normalFormat === undefined) migrated.normalFormat = 'opengl';
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

const presetLibrary = createStoredCollection<ConversionPreset>({
  storageKey: PRESET_STORAGE_KEY,
  validate: isConversionPreset,
  migrate: migratePreset,
  invalidSaveMessage: 'Preset library contains invalid data.',
});

export function loadPresetLibrary(storage: StorageLike): ConversionPreset[] {
  return presetLibrary.load(storage);
}

export function savePresetLibrary(storage: StorageLike, presets: ConversionPreset[]): void {
  presetLibrary.save(storage, presets);
}

export function upsertPreset(storage: StorageLike, preset: ConversionPreset): ConversionPreset[] {
  return presetLibrary.upsert(storage, preset, (entry) => entry.name.toLowerCase());
}

export function deletePreset(storage: StorageLike, id: string): ConversionPreset[] {
  return presetLibrary.remove(storage, id, (entry) => entry.id);
}
