/**
 * CLI flag model — a single source of truth derived from the app's
 * `CONFIG_FIELDS` table, so every serializable setting is exposed as a flag
 * automatically. `--dump-config` round-trips the same values back to a preset.
 */
import {
  CONFIG_FIELDS,
  defaultConfigValues,
  ditherModes,
  parsePreset,
  upscaleMethods,
  type ConversionConfig,
} from '../src/lib/presets';
import { isHexColor, isPalette, paletteCategories, palettes, type Palette } from '../src/lib/palettes';
import { readFileSync } from 'node:fs';
import type { DirectionVector } from '../src/lib/sunDirection';
import type { PreviewViewMode } from '../src/lib/state';

export const VIEW_MODES: PreviewViewMode[] = [
  'flat', 'basecolor', 'normals', 'ao', 'lightmap', 'lightmap-ao', 'uv-stretch', 'directionality', 'texel-variance',
];

/** Output file suffix per view mode — mirrors `EXPORT_VIEW_SUFFIX` in main.ts. */
export const EXPORT_VIEW_SUFFIX: Record<PreviewViewMode, string> = {
  flat: 'Combined',
  basecolor: 'BaseColor',
  normals: 'Normal',
  ao: 'AO',
  lightmap: 'Lightmap',
  'lightmap-ao': 'LightmapAO',
  'uv-stretch': 'UVStretch',
  directionality: 'Directionality',
  'texel-variance': 'TexelVariance',
};

const ENUM_VALUES: Partial<Record<keyof ConversionConfig, readonly string[]>> = {
  mode: ditherModes,
  upscale: upscaleMethods,
  patternSpace: ['uv', 'world'],
  normalFormat: ['opengl', 'directx'],
  paletteFilter: paletteCategories,
  paletteSearchSort: ['name', 'fewest', 'most'],
};

const HEX_KEYS = new Set<string>(['sunColor', 'ambientColor']);

/** Object-valued field handled by dedicated flags instead of one flat flag. */
const SPECIAL_KEYS = new Set<string>(['sunDirection']);

/** camelCase -> kebab-case (`aoBias` -> `ao-bias`, `showUVWireframeOriginal` -> `show-uv-wireframe-original`). */
export function kebab(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

export type FieldKind = 'number' | 'boolean' | 'enum' | 'hex' | 'string';

export type ConfigFlag = {
  key: keyof ConversionConfig;
  flag: string;
  kind: FieldKind;
  values?: readonly string[];
  default: unknown;
};

/** One CLI flag per serialized setting (minus the specially-handled ones). */
export const CONFIG_FLAGS: ConfigFlag[] = CONFIG_FIELDS
  .filter((field) => !SPECIAL_KEYS.has(field.key as string))
  .map((field) => {
    const key = field.key;
    const values = ENUM_VALUES[key];
    const kind: FieldKind = typeof field.default === 'boolean' ? 'boolean'
      : values ? 'enum'
      : HEX_KEYS.has(key as string) ? 'hex'
      : typeof field.default === 'number' ? 'number'
      : 'string';
    return { key, flag: `--${kebab(key as string)}`, kind, values, default: field.default };
  });

const FLAG_BY_NAME = new Map(CONFIG_FLAGS.map((entry) => [entry.flag, entry]));
const FIELD_VALIDATE = new Map(CONFIG_FIELDS.map((field) => [field.key as string, field.validate]));

export class CliError extends Error {}
export class HelpRequested extends Error {}

export type CliOptions = {
  input: string | null;
  output: string | null;
  preset: string | null;
  paletteKey: string | null;
  paletteFile: string | null;
  model: string | null;
  normal: string | null;
  aoMap: string | null;
  lightmapMap: string | null;
  uvMap: string;
  lod: number;
  worldAxis: 'blender' | 'maya';
  view: PreviewViewMode;
  json: boolean;
  dumpConfig: string | null;
  generateAo: boolean;
  bakeLighting: boolean;
  aoSamples: number;
  sunDirection: DirectionVector | null;
  sunAzimuth: number | null;
  sunElevation: number | null;
  /** Only the config keys the user explicitly passed. */
  overrides: Partial<ConversionConfig>;
  help: boolean;
};

const DEFAULTS: Omit<CliOptions, 'overrides'> = {
  input: null, output: null, preset: null, paletteKey: null, paletteFile: null,
  model: null, normal: null, aoMap: null, lightmapMap: null,
  uvMap: 'uv', lod: 0, worldAxis: 'maya',
  view: 'flat', json: false, dumpConfig: null,
  generateAo: false, bakeLighting: false, aoSamples: 64,
  sunDirection: null, sunAzimuth: null, sunElevation: null,
  help: false,
};

function parseNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new CliError(`Option ${name} expects a number, got "${raw}".`);
  return value;
}

function parseBoolean(raw: string, name: string): boolean {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new CliError(`Option ${name} expects true or false, got "${raw}".`);
}

export function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = { ...DEFAULTS, overrides: {} };
  const ALIASES: Record<string, string> = { '-r': '--resolution', '-m': '--mode' };
  const args = argv.map((a) => ALIASES[a] ?? a);
  const take = (i: number, name: string): string => {
    const value = args[i + 1];
    if (value === undefined || (value.startsWith('-') && !/^-?\d/.test(value))) {
      throw new CliError(`Option ${name} needs a value.`);
    }
    return value;
  };
  const setScalar = (name: string, raw: string): void => {
    const flag = FLAG_BY_NAME.get(name);
    if (!flag) return;
    const key = flag.key;
    if (flag.kind === 'number') {
      const value = parseNumber(raw, name);
      if (!FIELD_VALIDATE.get(key as string)?.(value)) throw new CliError(`Value ${value} for ${name} is out of range.`);
      options.overrides[key] = value as never;
    } else if (flag.kind === 'boolean') {
      options.overrides[key] = parseBoolean(raw, name) as never;
    } else if (flag.kind === 'enum') {
      if (!flag.values?.includes(raw)) throw new CliError(`Option ${name} must be one of: ${flag.values?.join(', ')}.`);
      options.overrides[key] = raw as never;
    } else if (flag.kind === 'hex') {
      if (!isHexColor(raw)) throw new CliError(`Option ${name} expects a #rrggbb color, got "${raw}".`);
      options.overrides[key] = raw as never;
    } else {
      options.overrides[key] = raw as never;
    }
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') { options.help = true; continue; }

    // Boolean config flags: `--quad-grid` (true) or `--quad-grid false`.
    if (FLAG_BY_NAME.get(arg)?.kind === 'boolean') {
      const next = args[i + 1];
      if (next === 'true' || next === 'false' || next === '1' || next === '0') {
        setScalar(arg, next); i += 1;
      } else {
        options.overrides[FLAG_BY_NAME.get(arg)!.key] = true as never;
      }
      continue;
    }
    // `--no-<flag>` negates a boolean config flag.
    if (arg.startsWith('--no-') && FLAG_BY_NAME.get(`--${arg.slice(5)}`)?.kind === 'boolean') {
      options.overrides[FLAG_BY_NAME.get(`--${arg.slice(5)}`)!.key] = false as never;
      continue;
    }

    switch (arg) {
      case '-i': case '--input': options.input = take(i, arg); i += 1; break;
      case '-o': case '--output': options.output = take(i, arg); i += 1; break;
      case '-p': case '--preset': options.preset = take(i, arg); i += 1; break;
      case '--palette': options.paletteKey = take(i, arg); i += 1; break;
      case '--palette-file': options.paletteFile = take(i, arg); i += 1; break;
      case '--model': options.model = take(i, arg); i += 1; break;
      case '--normal': options.normal = take(i, arg); i += 1; break;
      case '--ao': options.aoMap = take(i, arg); i += 1; break;
      case '--lightmap': options.lightmapMap = take(i, arg); i += 1; break;
      case '--uv-map': options.uvMap = take(i, arg); i += 1; break;
      case '--lod': options.lod = parseNumber(take(i, arg), arg); i += 1; break;
      case '--world-axis': {
        const value = take(i, arg);
        if (value !== 'blender' && value !== 'maya') throw new CliError('--world-axis must be blender or maya.');
        options.worldAxis = value; i += 1; break;
      }
      case '-v': case '--view': {
        const value = take(i, arg);
        if (!VIEW_MODES.includes(value as PreviewViewMode)) throw new CliError(`Unknown view "${value}". Options: ${VIEW_MODES.join(', ')}.`);
        options.view = value as PreviewViewMode; i += 1; break;
      }
      case '--generate-ao': options.generateAo = true; break;
      case '--bake-lighting': options.bakeLighting = true; break;
      case '--ao-samples': options.aoSamples = parseNumber(take(i, arg), arg); i += 1; break;
      case '--sun-direction': {
        const parts = take(i, arg).split(',').map((p) => Number(p.trim()));
        if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) throw new CliError('--sun-direction expects "x,y,z".');
        options.sunDirection = { x: parts[0], y: parts[1], z: parts[2] }; i += 1; break;
      }
      case '--sun-azimuth': options.sunAzimuth = parseNumber(take(i, arg), arg); i += 1; break;
      case '--sun-elevation': options.sunElevation = parseNumber(take(i, arg), arg); i += 1; break;
      case '--json': options.json = true; break;
      case '--dump-config': {
        const next = args[i + 1];
        if (next === undefined || next.startsWith('--')) { options.dumpConfig = ''; }
        else { options.dumpConfig = next; i += 1; }
        break;
      }
      default: {
        if (FLAG_BY_NAME.has(arg)) { setScalar(arg, take(i, arg)); i += 1; break; }
        throw new CliError(`Unknown option "${arg}". Try --help.`);
      }
    }
  }
  return options;
}

/** Working config: defaults, then preset, then CLI overrides. */
export function buildConfig(options: CliOptions): { config: ConversionConfig; colors: string[]; paletteLabel: string } {
  let config: ConversionConfig = {
    ...defaultConfigValues(),
    paletteKey: 'desert',
    palette: palettes.desert,
  } as unknown as ConversionConfig;
  let colors = palettes.desert.colors;
  let paletteLabel = 'desert (default)';

  if (options.preset) {
    config = { ...parsePreset(readPresetText(options.preset)) };
    colors = config.palette.colors;
    paletteLabel = `${config.paletteKey} (preset)`;
  }

  if (options.paletteFile) {
    const custom = loadPaletteFile(options.paletteFile);
    config.palette = custom;
    colors = custom.colors;
    paletteLabel = `${custom.name} (file)`;
  } else if (options.paletteKey) {
    const builtin = palettes[options.paletteKey];
    if (!builtin) throw new CliError(`Unknown palette "${options.paletteKey}". Try --list-palettes.`);
    config.paletteKey = options.paletteKey;
    config.palette = builtin;
    colors = builtin.colors;
    paletteLabel = options.paletteKey;
  }

  // CLI overrides win over the preset. `sunDirection` folds azimuth/elevation.
  Object.assign(config, options.overrides);
  if (options.overrides.sunDirection) config.sunDirection = options.overrides.sunDirection;
  if (options.sunDirection) config.sunDirection = options.sunDirection;
  if (options.sunAzimuth !== null || options.sunElevation !== null) {
    config.sunDirection = sunDirectionFromAngles(options.sunAzimuth, options.sunElevation);
  }

  return { config, colors, paletteLabel };
}

/** Sun travel direction from azimuth/elevation (degrees). Azimuth 0 = +Z,
 * increasing toward +X; elevation 0 = horizon, 90 = overhead. The default sun
 * (−0.5, −0.707, −0.5) is azimuth 45°, elevation 45°. */
export function sunDirectionFromAngles(azimuth: number | null, elevation: number | null): DirectionVector {
  const az = ((azimuth ?? 45) * Math.PI) / 180;
  const el = ((elevation ?? 45) * Math.PI) / 180;
  const sun = { x: Math.cos(el) * Math.sin(az), y: Math.sin(el), z: Math.cos(el) * Math.cos(az) };
  return { x: -sun.x, y: -sun.y, z: -sun.z };
}

let cachedPresetText: { path: string; text: string } | null = null;
function readPresetText(path: string): string {
  if (cachedPresetText?.path === path) return cachedPresetText.text;
  const text = readFileSync(path, 'utf8');
  cachedPresetText = { path, text };
  return text;
}

/** Parses a `.hex` or JSON custom palette file. */
export function loadPaletteFile(path: string): Palette {
  const text = readFileSync(path, 'utf8');
  const name = path.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPalette(parsed)) return parsed;
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) {
      return { name, category: 'custom', colors: parsed as string[] };
    }
    throw new CliError(`Palette file "${path}" is not a valid palette.`);
  }
  const colors = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^#[0-9a-f]{6}$/i.test(line));
  if (colors.length < 2) throw new CliError(`Palette file "${path}" needs at least two #rrggbb lines.`);
  return { name, category: 'custom', colors };
}

export function configHelp(): string {
  const lines = CONFIG_FLAGS.map((entry) => {
    const value = entry.kind === 'boolean' ? '[true|false]'
      : entry.kind === 'enum' ? `<${entry.values?.join('|')}>`
      : entry.kind === 'hex' ? '<#rrggbb>'
      : entry.kind === 'number' ? '<number>'
      : '<string>';
    return `      ${entry.flag.padEnd(30)} ${value}`;
  });
  return lines.join('\n');
}
