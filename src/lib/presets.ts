import { isHexColor, isPalette, type Palette } from './palettes';
import type { DitherMode } from './dither';
import { clamp01 } from './math';
import { parseJsonFile, serializeJsonFile } from './storage';
import { slugify } from './strings';
import { DEFAULT_AMBIENT_INTENSITY, DEFAULT_SUN_INTENSITY } from './defaults';
import type { NormalFormat } from './normal';
import type { State } from './state';

export const PRESET_VERSION = 5;

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

type ConfigField = {
  /** Flat serialized key in `ConversionConfig` — part of the storage format, must stay stable. */
  key: keyof ConversionConfig;
  /** Path into `State` used to map state <-> config (sun/ambient are nested). */
  path: readonly string[];
  /** Value used by `defaultState()` when no preset is loaded. */
  default: unknown;
  /** Value backfilled when an older preset is missing the key; absent = never backfilled. */
  migrateDefault?: unknown;
  /** Accepts the value during `isConversionPreset` validation. */
  validate: (value: unknown) => boolean;
};

const inRange = (min: number, max: number) => (value: unknown): value is number => finiteInRange(value, min, max);
const isEnum = (options: readonly string[]) => (value: unknown): value is string =>
  typeof value === 'string' && options.includes(value);
const isHex = (value: unknown): value is string => typeof value === 'string' && isHexColor(value);

/**
 * Single source of truth for every serializable conversion setting: validation
 * bounds, initial defaults, migration backfills, and the state <-> config
 * mapping all derive from this table. `paletteKey`, `uvMap` and `palette` are
 * deliberately excluded — they carry catalog/structural semantics handled by
 * dedicated code.
 */
export const CONFIG_FIELDS: ReadonlyArray<ConfigField> = [
  { key: 'resolution', path: ['resolution'], default: 128, validate: inRange(1, 4096) },
  { key: 'mode', path: ['mode'], default: 'floyd', validate: isEnum(ditherModes) },
  { key: 'strength', path: ['strength'], default: 0.85, validate: inRange(0, 1) },
  { key: 'brightness', path: ['brightness'], default: 0, validate: inRange(-100, 100) },
  { key: 'contrast', path: ['contrast'], default: 8, validate: inRange(-100, 100) },
  { key: 'saturation', path: ['saturation'], default: 5, validate: inRange(-100, 100) },
  { key: 'stripeAngle', path: ['stripeAngle'], default: 45, migrateDefault: 45, validate: inRange(0, 135) },
  { key: 'noiseScale', path: ['noiseScale'], default: 1, migrateDefault: 1, validate: inRange(1, 32) },
  { key: 'seed', path: ['seed'], default: 1, migrateDefault: 1, validate: inRange(0, 9999) },
  { key: 'aoBias', path: ['aoBias'], default: 0, migrateDefault: 0, validate: inRange(-1, 1) },
  { key: 'aoScale', path: ['aoScale'], default: 0.2, migrateDefault: 0.2, validate: inRange(0, 2) },
  { key: 'aoDistance', path: ['aoDistance'], default: 2, migrateDefault: 2, validate: inRange(0.05, 3) },
  { key: 'sunColor', path: ['sun', 'color'], default: '#ffffff', migrateDefault: '#ffffff', validate: isHex },
  { key: 'sunIntensity', path: ['sun', 'intensity'], default: DEFAULT_SUN_INTENSITY, migrateDefault: DEFAULT_SUN_INTENSITY, validate: inRange(0, 1) },
  { key: 'ambientColor', path: ['ambient', 'color'], default: '#ffffff', migrateDefault: '#ffffff', validate: isHex },
  { key: 'ambientIntensity', path: ['ambient', 'intensity'], default: DEFAULT_AMBIENT_INTENSITY, migrateDefault: DEFAULT_AMBIENT_INTENSITY, validate: inRange(0, 1) },
  { key: 'normalStrength', path: ['normalStrength'], default: 1, migrateDefault: 1, validate: inRange(0, 1) },
  { key: 'normalFormat', path: ['normalFormat'], default: 'opengl', migrateDefault: 'opengl', validate: isEnum(['opengl', 'directx']) },
];

function readPath(state: State, path: readonly string[]): unknown {
  let current: unknown = state;
  for (const segment of path) current = (current as Record<string, unknown>)[segment];
  return current;
}

function writePath(state: State, path: readonly string[], value: unknown): void {
  let current = state as unknown as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    const next = current[segment];
    current[segment] = (next ?? {}) as Record<string, unknown>;
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

/** Default values for every serializable setting, derived from the shared table. */
export function defaultConfigValues(): Record<keyof ConversionConfig, unknown> {
  return Object.fromEntries(CONFIG_FIELDS.map((field) => [field.key, field.default])) as Record<keyof ConversionConfig, unknown>;
}

/** Reads the serializable settings out of a `State` object via each field's path. */
export function collectConfigValues(state: State): ConversionConfig {
  const values: Record<string, unknown> = {};
  for (const field of CONFIG_FIELDS) values[field.key] = readPath(state, field.path);
  return values as unknown as ConversionConfig;
}

/** Writes flat config values into a `State` object via each field's path. */
export function applyConfigValues(state: State, values: Readonly<Record<string, unknown>>): void {
  for (const field of CONFIG_FIELDS) {
    const value = values[field.key];
    if (value === undefined) continue;
    writePath(state, field.path, value);
  }
}

export function isConversionPreset(value: unknown): value is ConversionPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<ConversionPreset>;
  return preset.version === PRESET_VERSION
    && typeof preset.id === 'string' && /^[a-z0-9][a-z0-9-]{0,119}$/i.test(preset.id)
    && typeof preset.name === 'string' && preset.name.trim().length > 0 && preset.name.length <= 60
    && typeof preset.description === 'string' && preset.description.length <= 160
    && typeof preset.createdAt === 'string' && !Number.isNaN(Date.parse(preset.createdAt))
    && typeof preset.paletteKey === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(preset.paletteKey)
    && typeof preset.uvMap === 'string' && /^uv\d*$/.test(preset.uvMap)
    && isPalette(preset.palette)
    && CONFIG_FIELDS.every((field) => field.validate(preset[field.key]));
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
  return serializeJsonFile(preset, isConversionPreset, 'Cannot export an invalid preset.');
}

function migratePreset(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  let preset = value as Record<string, unknown>;
  if (preset.version === 1) {
    const { aoIntensity, ...rest } = preset;
    preset = { ...rest, version: 2, aoBias: 0, aoScale: typeof aoIntensity === 'number' ? aoIntensity : 0.2 };
  }
  if (preset.version === 2) preset = { ...preset, version: 3 };
  if (preset.version === 3) preset = { ...preset, version: 4 };
  if (preset.version === 4) {
    // v4 stored three.js physical light intensities (sun 0-10, ambient 0-5).
    // v5 treats them as direct [0, 1] multipliers, so rescale by 1/pi to keep the look.
    preset = {
      ...preset,
      version: PRESET_VERSION,
      sunIntensity: typeof preset.sunIntensity === 'number' ? clamp01(preset.sunIntensity / Math.PI) : preset.sunIntensity,
      ambientIntensity: typeof preset.ambientIntensity === 'number' ? clamp01(preset.ambientIntensity / Math.PI) : preset.ambientIntensity,
    };
  }
  if (preset.version !== PRESET_VERSION) return value;
  const migrated: Record<string, unknown> = { ...preset };
  if (migrated.mode === 'diagonal') {
    migrated.mode = 'stripes';
    migrated.stripeAngle = 45;
  } else if (migrated.mode === 'vertical') {
    migrated.mode = 'stripes';
    migrated.stripeAngle = 0;
  }
  if (migrated.uvMap === undefined) migrated.uvMap = 'uv';
  for (const field of CONFIG_FIELDS) {
    if (field.migrateDefault !== undefined && migrated[field.key] === undefined) migrated[field.key] = field.migrateDefault;
  }
  return migrated;
}

export function parsePreset(json: string): ConversionPreset {
  return parseJsonFile(json, isConversionPreset, {
    invalidJson: 'Preset file is not valid JSON.',
    invalidData: 'Preset file has invalid or unsupported settings.',
  }, { before: migratePreset });
}
