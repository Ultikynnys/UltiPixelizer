import { isHexColor, isPalette, paletteCategories, type Palette, type PaletteCategory } from './palettes';
import type { DitherMode } from './dither';
import type { UpscaleMethod } from './canvas';
import { clamp01 } from './math';
import { parseJsonFile, serializeJsonFile } from './storage';
import { slugify } from './strings';
import { DEFAULT_AMBIENT_INTENSITY, DEFAULT_NORMAL_STRENGTH, DEFAULT_SUN_INTENSITY, DEFAULT_UV_STRETCH_SENSITIVITY, DEFAULT_WORLDSPACE_SCALE } from './defaults';
import type { NormalFormat } from './normal';
import { DEFAULT_SUN_DIRECTION, type DirectionVector } from './sunDirection';
import type { PaletteSearchSort, State } from './state';

export const PRESET_VERSION = 7;

export const ditherModes: DitherMode[] = ['floyd', 'atkinson', 'ordered', 'worldspace', 'cross', 'stripes', 'noise', 'checker', 'halftone', 'none'];

export const upscaleMethods: UpscaleMethod[] = ['nearest', 'bilinear'];

export type ConversionConfig = {
  resolution: number;
  mode: DitherMode;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  pixelation: number;
  upscale: UpscaleMethod;
  paletteKey: string;
  palette: Palette;
  stripeAngle: number;
  noiseScale: number;
  worldspaceScale: number;
  halftoneScale: number;
  seed: number;
  aoBias: number;
  aoPower: number;
  aoDistance: number;
  sunColor: string;
  sunIntensity: number;
  ambientColor: string;
  ambientIntensity: number;
  normalStrength: number;
  normalFormat: NormalFormat;
  /** UV-stretch heatmap sensitivity  a display gain, persisted with the other
   * settings so the tuned stretch view survives restarts. */
  uvStretchSensitivity: number;
  sunDirection: DirectionVector;
  quadTessellation: number;
  quadGrid: boolean;
  displacementStrength: number;
  displacementFlip: boolean;
  /** Pane-specific UV Islands overlay preferences. */
  showUVWireframeOriginal: boolean;
  showUVWireframeProcessed: boolean;
  /** Left-drag camera action for the 3D viewports: pan (on) or orbit (off). */
  navigationPan: boolean;
  /** Shared 10 cm floor reference shown in both 3D viewports. */
  showFloorGrid: boolean;
  /** Active palette-library filter  UI state, persisted like the settings. */
  paletteFilter: PaletteCategory;
  /** Palette-library search query (Search category), remembered across restarts. */
  paletteSearchQuery: string;
  /** Search-category sort order. */
  paletteSearchSort: PaletteSearchSort;
  /** Saved orbit-camera views for the two viewports  viewport state, not
   * State fields, so they're handled by dedicated code like paletteKey. */
  originalCamera?: SavedCamera;
  processedCamera?: SavedCamera;
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
  /** Flat serialized key in `ConversionConfig`  part of the storage format, must stay stable. */
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
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isShortString = (value: unknown): value is string => typeof value === 'string' && value.length <= 200;
const isDirectionVector = (value: unknown): value is DirectionVector => {
  if (typeof value !== 'object' || value === null) return false;
  const vector = value as DirectionVector;
  return typeof vector.x === 'number' && Number.isFinite(vector.x)
    && typeof vector.y === 'number' && Number.isFinite(vector.y)
    && typeof vector.z === 'number' && Number.isFinite(vector.z)
    && Math.hypot(vector.x, vector.y, vector.z) > 0;
};

/** A finite 3D point  like a direction vector, but allowed to sit at the
 * origin (the orbit target is a point and defaults there). */
const isVector3 = (value: unknown): value is DirectionVector => {
  if (typeof value !== 'object' || value === null) return false;
  const vector = value as DirectionVector;
  return typeof vector.x === 'number' && Number.isFinite(vector.x)
    && typeof vector.y === 'number' && Number.isFinite(vector.y)
    && typeof vector.z === 'number' && Number.isFinite(vector.z);
};

/** Saved orbit-camera view for one viewport. Position plus the orbit target
 * fully determine the view (the up axis is fixed), so both the camera angle
 * and its position survive the round-trip. */
export type SavedCamera = {
  /** World position of the orbit camera. */
  position: DirectionVector;
  /** Orbit target  where the camera looks. */
  target: DirectionVector;
};

const isSavedCamera = (value: unknown): value is SavedCamera => {
  if (typeof value !== 'object' || value === null) return false;
  const camera = value as SavedCamera;
  return isDirectionVector(camera.position) && isVector3(camera.target);
};

/**
 * Single source of truth for every serializable conversion setting: validation
 * bounds, initial defaults, migration backfills, and the state <-> config
 * mapping all derive from this table. `paletteKey` and `palette` are
 * deliberately excluded  they carry catalog/structural semantics handled by
 * dedicated code.
 */
export const CONFIG_FIELDS: ReadonlyArray<ConfigField> = [
  { key: 'resolution', path: ['resolution'], default: 128, validate: inRange(1, 4096) },
  { key: 'mode', path: ['mode'], default: 'floyd', validate: isEnum(ditherModes) },
  { key: 'strength', path: ['strength'], default: 0.85, validate: inRange(0, 1) },
  { key: 'brightness', path: ['brightness'], default: 0, validate: inRange(-100, 100) },
  { key: 'contrast', path: ['contrast'], default: 8, validate: inRange(-100, 100) },
  { key: 'saturation', path: ['saturation'], default: 5, validate: inRange(-100, 100) },
  { key: 'pixelation', path: ['pixelation'], default: 0, migrateDefault: 0, validate: inRange(0, 80) },
  { key: 'upscale', path: ['upscale'], default: 'nearest', migrateDefault: 'nearest', validate: isEnum(upscaleMethods) },
  { key: 'stripeAngle', path: ['stripeAngle'], default: 45, migrateDefault: 45, validate: inRange(0, 135) },
  { key: 'noiseScale', path: ['noiseScale'], default: 1, migrateDefault: 1, validate: inRange(1, 32) },
  { key: 'worldspaceScale', path: ['worldspaceScale'], default: DEFAULT_WORLDSPACE_SCALE, migrateDefault: DEFAULT_WORLDSPACE_SCALE, validate: inRange(0.25, 64) },
  { key: 'halftoneScale', path: ['halftoneScale'], default: 1, migrateDefault: 1, validate: inRange(0.5, 4) },
  { key: 'seed', path: ['seed'], default: 1, migrateDefault: 1, validate: inRange(0, 9999) },
  { key: 'aoBias', path: ['aoBias'], default: 0, migrateDefault: 0, validate: inRange(-1, 1) },
  { key: 'aoPower', path: ['aoPower'], default: 1, migrateDefault: 1, validate: inRange(0, 16) },
  { key: 'aoDistance', path: ['aoDistance'], default: 2, migrateDefault: 2, validate: inRange(0.05, 3) },
  { key: 'sunColor', path: ['sun', 'color'], default: '#ffffff', migrateDefault: '#ffffff', validate: isHex },
  { key: 'sunIntensity', path: ['sun', 'intensity'], default: DEFAULT_SUN_INTENSITY, migrateDefault: DEFAULT_SUN_INTENSITY, validate: inRange(0, 2) },
  { key: 'ambientColor', path: ['ambient', 'color'], default: '#ffffff', migrateDefault: '#ffffff', validate: isHex },
  { key: 'ambientIntensity', path: ['ambient', 'intensity'], default: DEFAULT_AMBIENT_INTENSITY, migrateDefault: DEFAULT_AMBIENT_INTENSITY, validate: inRange(0, 1) },
  { key: 'normalStrength', path: ['normalStrength'], default: DEFAULT_NORMAL_STRENGTH, migrateDefault: DEFAULT_NORMAL_STRENGTH, validate: inRange(0, 1) },
  { key: 'normalFormat', path: ['normalFormat'], default: 'opengl', migrateDefault: 'opengl', validate: isEnum(['opengl', 'directx']) },
  { key: 'uvStretchSensitivity', path: ['uvStretchSensitivity'], default: DEFAULT_UV_STRETCH_SENSITIVITY, migrateDefault: DEFAULT_UV_STRETCH_SENSITIVITY, validate: inRange(0, 4) },
  { key: 'sunDirection', path: ['sun', 'direction'], default: DEFAULT_SUN_DIRECTION, migrateDefault: DEFAULT_SUN_DIRECTION, validate: isDirectionVector },
  // Fallback-quad parameters  the quad is the implicit model when none is
  // loaded, so its panel settings are saved like any other setting.
  { key: 'quadTessellation', path: ['quadTessellation'], default: 16, migrateDefault: 16, validate: inRange(2, 128) },
  { key: 'quadGrid', path: ['quadGrid'], default: false, migrateDefault: false, validate: isBoolean },
  { key: 'displacementStrength', path: ['displacementStrength'], default: 0.15, migrateDefault: 0.15, validate: inRange(0, 0.2) },
  { key: 'displacementFlip', path: ['displacementFlip'], default: false, migrateDefault: false, validate: isBoolean },
  // Pane overlay preferences are UI state, but persist with the rest of the
  // settings so disabling UV Islands survives a browser restart.
  { key: 'showUVWireframeOriginal', path: ['showUVWireframeOriginal'], default: false, migrateDefault: false, validate: isBoolean },
  { key: 'showUVWireframeProcessed', path: ['showUVWireframeProcessed'], default: false, migrateDefault: false, validate: isBoolean },
  // Camera interaction preference  the "Alt controls" pill. Not a conversion
  // parameter, but it is saved like the other settings (and restored from old
  // files via migrateDefault).
  { key: 'navigationPan', path: ['navigationPan'], default: false, migrateDefault: false, validate: isBoolean },
  { key: 'showFloorGrid', path: ['showFloorGrid'], default: false, migrateDefault: false, validate: isBoolean },
  // Palette-library UI state  like navigationPan, not a conversion parameter,
  // but saved with the settings so the last filter/query/sort survive restarts.
  { key: 'paletteFilter', path: ['paletteFilter'], default: 'compact', migrateDefault: 'compact', validate: isEnum(paletteCategories) },
  { key: 'paletteSearchQuery', path: ['paletteSearchQuery'], default: '', migrateDefault: '', validate: isShortString },
  { key: 'paletteSearchSort', path: ['paletteSearchSort'], default: 'name', migrateDefault: 'name', validate: isEnum(['name', 'fewest', 'most']) },
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
    && isPalette(preset.palette)
    && (preset.originalCamera === undefined || isSavedCamera(preset.originalCamera))
    && (preset.processedCamera === undefined || isSavedCamera(preset.processedCamera))
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
    preset = { ...rest, version: 2, aoBias: 0, aoScale: typeof aoIntensity === 'number' ? aoIntensity : 1 };
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
  if (preset.version === 5) {
    // v6 removed the sun/ambient enable toggles  intensity 0 now means "off".
    // Fold a disabled light into a zero intensity so saved presets keep their look.
    const { sunEnabled, ambientEnabled, ...rest } = preset;
    preset = {
      ...rest,
      version: PRESET_VERSION,
      sunIntensity: sunEnabled === false ? 0 : rest.sunIntensity,
      ambientIntensity: ambientEnabled === false ? 0 : rest.ambientIntensity,
    };
  }
  if (preset.version === 6) {
    // v7 renamed AO "Scale" to "Power" (an exponent). Carry the value over
    // 1:1  both default to 1 ("as baked"); only the curve shape differs.
    const { aoScale, ...rest } = preset;
    preset = { ...rest, version: PRESET_VERSION, aoPower: typeof aoScale === 'number' ? aoScale : 1 };
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
  // v7 renamed AO "Scale" to "Power"; older migrations that jumped straight
  // to the current version may still carry aoScale  convert and drop it.
  if (migrated.aoPower === undefined && typeof migrated.aoScale === 'number') migrated.aoPower = migrated.aoScale;
  delete migrated.aoScale;
  // v7 and earlier stored the model-specific UV-channel selection; it no
  // longer belongs in the saved format, so strip it from legacy files.
  delete migrated.uvMap;
  // v7 and earlier also stored the 3D camera angle. It is view state  the
  // Orient Sun with Camera button derives the saved sun direction from it 
  // so it never belonged in the saved format either.
  delete migrated.cameraDirection;
  // The displacement push amount was capped at 0.2: the old 0–1 range was
  // far too strong for quad displacement. Files saved above the cap are
  // clamped so they still load, with the tamed look landing at the new max.
  if (migrated.displacementStrength !== undefined) migrated.displacementStrength = Math.min(Number(migrated.displacementStrength), 0.2);
  // The pixelation slider was capped at 80%: the old 0–99 range bottomed out
  // into unusably tiny blocks. Files saved above the cap are clamped so they
  // still load, with the chunkiest allowed look landing at the new max.
  if (migrated.pixelation !== undefined) migrated.pixelation = Math.min(Number(migrated.pixelation), 80);
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
