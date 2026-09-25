/**
 * UltiPixelizer headless CLI.
 *
 * Runs the app's exact dither pipeline (the pure `processImageData` in
 * `src/lib/dither.ts`) on an image file, with no browser or WebGPU. Same
 * palettes, same settings format (`--preset`), same PNG output.
 *
 *   ultipixelizer --input texture.png --output out.png --palette gameboy --mode floyd
 *
 * Import order matters: `./imagedata` installs the `ImageData` shim before the
 * pipeline modules load.
 */
import './imagedata';

import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { processImageData, type DitherMode } from '../src/lib/dither';
import { isPalette, palettes, type Palette } from '../src/lib/palettes';
import { defaultConfigValues, ditherModes, parsePreset, upscaleMethods, type ConversionConfig } from '../src/lib/presets';
import { decodeImage, encodePng, type DecodedImage } from './imageIo';
import { computeOutputDimensions, resampleAndPixelate, type UpscaleMethod } from './resample';

type CliConfig = {
  input: string | null;
  output: string | null;
  preset: string | null;
  paletteKey: string | null;
  paletteFile: string | null;
  resolution: number;
  mode: DitherMode;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  pixelation: number;
  upscale: UpscaleMethod;
  stripeAngle: number;
  seed: number;
  uvScale: number;
  worldspaceScale: number;
  patternSpace: 'uv' | 'world';
  json: boolean;
};

const DEFAULTS: CliConfig = {
  input: null,
  output: null,
  preset: null,
  paletteKey: null,
  paletteFile: null,
  resolution: 128,
  mode: 'floyd',
  strength: 0.85,
  brightness: 0,
  contrast: 8,
  saturation: 5,
  pixelation: 0,
  upscale: 'nearest',
  stripeAngle: 45,
  seed: 1,
  uvScale: 1,
  worldspaceScale: 1.5,
  patternSpace: 'uv',
  json: false,
};

export const DEFAULT_PALETTE_KEY = 'desert';

const HELP = `UltiPixelizer CLI  headless texture dithering

Usage:
  ultipixelizer --input <file> [--output <file>] [options]

Input / output:
  -i, --input <file>        Source image (.png / .jpg / .jpeg)
  -o, --output <file>       Output PNG (default: <input>_ultipixelized.png)

Settings:
  -p, --preset <file>       Load an UltiPixelizer settings/preset JSON
      --palette <key>       Built-in palette key (see --list-palettes)
      --palette-file <file> Custom palette (.json or .hex color list)
  -m, --mode <mode>         Dither mode (see --list-modes)
  -r, --resolution <n>      Target pixel width, 1..4096       [${DEFAULTS.resolution}]
      --strength <0..1>     Dither strength                  [${DEFAULTS.strength}]
      --brightness <-100..100>  Brightness                   [${DEFAULTS.brightness}]
      --contrast <-100..100>    Contrast                     [${DEFAULTS.contrast}]
      --saturation <-100..100>  Saturation                   [${DEFAULTS.saturation}]
      --pixelation <0..80>  Block-pixelation percent         [${DEFAULTS.pixelation}]
      --upscale <method>    nearest | bilinear               [${DEFAULTS.upscale}]
      --stripe-angle <0..135>  Stripe angle (stripes mode)   [${DEFAULTS.stripeAngle}]
      --seed <0..9999>      Pattern seed                     [${DEFAULTS.seed}]
      --uv-scale <n>        Pattern cells per pixel          [${DEFAULTS.uvScale}]
      --worldspace-scale <n>  Pattern cells per world unit   [${DEFAULTS.worldspaceScale}]
      --pattern-space <uv|world>  Pattern sampling space     [${DEFAULTS.patternSpace}]

Info:
      --list-palettes       List built-in palette keys and exit
      --list-modes          List dither modes and exit
      --json                Print a machine-readable result summary
  -h, --help                Show this help

Note: 'world' pattern space needs per-texel world positions from a 3D bake, so
the CLI only supports 'uv' (it errors on 'world').`;

class CliError extends Error {}
class HelpRequested extends Error {}

function parseArgs(argv: string[]): CliConfig {
  const cfg: CliConfig = { ...DEFAULTS };
  const take = (i: number, name: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(`Option ${name} needs a value.`);
    return value;
  };
  const num = (raw: string, name: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new CliError(`Option ${name} expects a number, got "${raw}".`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-i': case '--input': cfg.input = take(i, arg); i += 1; break;
      case '-o': case '--output': cfg.output = take(i, arg); i += 1; break;
      case '-p': case '--preset': cfg.preset = take(i, arg); i += 1; break;
      case '--palette': cfg.paletteKey = take(i, arg); i += 1; break;
      case '--palette-file': cfg.paletteFile = take(i, arg); i += 1; break;
      case '-m': case '--mode': {
        const value = take(i, arg);
        if (!ditherModes.includes(value as DitherMode)) throw new CliError(`Unknown mode "${value}". Try --list-modes.`);
        cfg.mode = value as DitherMode; i += 1; break;
      }
      case '-r': case '--resolution': cfg.resolution = num(take(i, arg), arg); i += 1; break;
      case '--strength': cfg.strength = num(take(i, arg), arg); i += 1; break;
      case '--brightness': cfg.brightness = num(take(i, arg), arg); i += 1; break;
      case '--contrast': cfg.contrast = num(take(i, arg), arg); i += 1; break;
      case '--saturation': cfg.saturation = num(take(i, arg), arg); i += 1; break;
      case '--pixelation': cfg.pixelation = num(take(i, arg), arg); i += 1; break;
      case '--upscale': {
        const value = take(i, arg);
        if (!upscaleMethods.includes(value as UpscaleMethod)) throw new CliError(`Unknown upscale "${value}". Use nearest or bilinear.`);
        cfg.upscale = value as UpscaleMethod; i += 1; break;
      }
      case '--stripe-angle': cfg.stripeAngle = num(take(i, arg), arg); i += 1; break;
      case '--seed': cfg.seed = num(take(i, arg), arg); i += 1; break;
      case '--uv-scale': cfg.uvScale = num(take(i, arg), arg); i += 1; break;
      case '--worldspace-scale': cfg.worldspaceScale = num(take(i, arg), arg); i += 1; break;
      case '--pattern-space': {
        const value = take(i, arg);
        if (value !== 'uv' && value !== 'world') throw new CliError('--pattern-space must be uv or world.');
        cfg.patternSpace = value; i += 1; break;
      }
      case '--json': cfg.json = true; break;
      case '-h': case '--help': throw new HelpRequested();
      default:
        if (arg.startsWith('-')) throw new CliError(`Unknown option "${arg}". Try --help.`);
        if (!cfg.input) cfg.input = arg;
        else throw new CliError(`Unexpected argument "${arg}".`);
    }
  }
  return cfg;
}

const MODE_NOTES: Partial<Record<DitherMode, string>> = {
  halftone: 'two stacked dot screens (needs lighting for the ink layer)',
  none: 'no diffusion  raw palette quantization',
};

/** Option tokens that were explicitly passed on the command line, so preset
 * values are only overridden when the user actually typed a flag. */
function providedFlags(argv: string[]): Set<string> {
  const flags = new Set<string>();
  const withValue = new Set([
    '-i', '--input', '-o', '--output', '-p', '--preset', '--palette', '--palette-file',
    '-m', '--mode', '-r', '--resolution', '--strength', '--brightness', '--contrast',
    '--saturation', '--pixelation', '--upscale', '--stripe-angle', '--seed',
    '--uv-scale', '--worldspace-scale', '--pattern-space',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (withValue.has(arg)) { flags.add(arg); i += 1; } else flags.add(arg);
  }
  return flags;
}

function listPalettes(): void {
  const keys = Object.keys(palettes).sort();
  process.stdout.write(`${keys.length} built-in palettes:\n`);
  for (const key of keys) {
    const p = palettes[key];
    process.stdout.write(`  ${key.padEnd(22)} ${String(p.colors.length).padStart(3)} colors  ${p.name}\n`);
  }
}

function listModes(): void {
  process.stdout.write('Dither modes:\n');
  for (const mode of ditherModes) {
    const note = MODE_NOTES[mode] ? `  (${MODE_NOTES[mode]})` : '';
    process.stdout.write(`  ${mode}${note}\n`);
  }
}

/** Parses a `.hex` or JSON custom palette file. `.hex` lists one color per
 * line (#rrggbb); JSON accepts an UltiPixelizer palette object or a bare array
 * of hex strings. The palette name comes from the file name. */
function loadPaletteFile(path: string): Palette {
  const text = readFileSync(path, 'utf8');
  const name = basename(path, extname(path));
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

/** Working config: defaults, then preset, then CLI flags (flags win). */
function resolveConfig(cfg: CliConfig, argv: string[]): { config: ConversionConfig; colors: string[]; paletteLabel: string } {
  const flags = providedFlags(argv);
  let config: ConversionConfig = {
    ...defaultConfigValues(),
    paletteKey: DEFAULT_PALETTE_KEY,
    palette: palettes[DEFAULT_PALETTE_KEY],
  } as unknown as ConversionConfig;
  let colors = palettes[DEFAULT_PALETTE_KEY].colors;
  let paletteLabel = `${DEFAULT_PALETTE_KEY} (default)`;

  if (cfg.preset) {
    config = { ...parsePreset(readFileSync(cfg.preset, 'utf8')) };
    colors = config.palette.colors;
    paletteLabel = `${config.paletteKey} (preset)`;
  }

  if (cfg.paletteFile) {
    const custom = loadPaletteFile(cfg.paletteFile);
    config.palette = custom;
    colors = custom.colors;
    paletteLabel = `${custom.name} (file)`;
  } else if (cfg.paletteKey) {
    const builtin = palettes[cfg.paletteKey];
    if (!builtin) throw new CliError(`Unknown palette "${cfg.paletteKey}". Try --list-palettes.`);
    config.paletteKey = cfg.paletteKey;
    config.palette = builtin;
    colors = builtin.colors;
    paletteLabel = cfg.paletteKey;
  }

  if (flags.has('-m') || flags.has('--mode')) config.mode = cfg.mode;
  if (flags.has('-r') || flags.has('--resolution')) config.resolution = cfg.resolution;
  if (flags.has('--strength')) config.strength = cfg.strength;
  if (flags.has('--brightness')) config.brightness = cfg.brightness;
  if (flags.has('--contrast')) config.contrast = cfg.contrast;
  if (flags.has('--saturation')) config.saturation = cfg.saturation;
  if (flags.has('--pixelation')) config.pixelation = cfg.pixelation;
  if (flags.has('--upscale')) config.upscale = cfg.upscale;
  if (flags.has('--stripe-angle')) config.stripeAngle = cfg.stripeAngle;
  if (flags.has('--seed')) config.seed = cfg.seed;
  if (flags.has('--uv-scale')) config.uvScale = cfg.uvScale;
  if (flags.has('--worldspace-scale')) config.worldspaceScale = cfg.worldspaceScale;
  if (flags.has('--pattern-space')) config.patternSpace = cfg.patternSpace;

  return { config, colors, paletteLabel };
}

function defaultOutputPath(input: string): string {
  return join(dirname(input), `${basename(input, extname(input))}_ultipixelized.png`);
}

const ImageDataCtor = (globalThis as unknown as {
  ImageData: new (d: Uint8ClampedArray, w: number, h: number) => ImageData;
}).ImageData;

export async function runCli(argv: string[]): Promise<number> {
  // Info commands short-circuit before option parsing so they never depend on
  // a valid input/preset.
  if (argv.includes('--list-palettes')) { listPalettes(); return 0; }
  if (argv.includes('--list-modes')) { listModes(); return 0; }

  let cfg: CliConfig;
  try {
    cfg = parseArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) { process.stdout.write(`${HELP}\n`); return 0; }
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 2;
  }

  if (!cfg.input) {
    process.stderr.write('error: --input <file> is required. Try --help.\n');
    return 2;
  }

  let resolved: { config: ConversionConfig; colors: string[]; paletteLabel: string };
  try {
    resolved = resolveConfig(cfg, argv);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 2;
  }
  const { config, colors, paletteLabel } = resolved;

  if (config.patternSpace === 'world') {
    process.stderr.write('error: pattern space "world" needs a 3D bake for per-texel world positions; the headless CLI supports "uv".\n');
    return 2;
  }

  const inputPath = resolve(cfg.input);
  const outputPath = cfg.output ? resolve(cfg.output) : defaultOutputPath(inputPath);

  const source = await decodeImage(inputPath);
  const { width, height } = computeOutputDimensions(config.resolution, source);
  const resampled = resampleAndPixelate(source, width, height, config.pixelation, config.upscale);

  const imageData = new ImageDataCtor(resampled.data, resampled.width, resampled.height);

  const processed = processImageData(imageData, {
    palette: colors,
    mode: config.mode,
    strength: config.strength,
    brightness: config.brightness,
    contrast: config.contrast,
    saturation: config.saturation,
    stripeAngle: config.stripeAngle,
    seed: config.seed,
    uvScale: config.uvScale,
    worldspaceScale: config.worldspaceScale,
    patternSpace: 'uv',
  });

  const out: DecodedImage = { data: processed.data, width: processed.width, height: processed.height };
  const bytes = await encodePng(outputPath, out);

  if (cfg.json) {
    process.stdout.write(`${JSON.stringify({
      input: inputPath,
      output: outputPath,
      resolution: config.resolution,
      size: { width, height },
      mode: config.mode,
      palette: paletteLabel,
      paletteColors: colors.length,
      bytes,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`UltiPixelizer: ${inputPath}\n`);
    process.stdout.write(`  -> ${outputPath}  (${width}x${height}, ${config.mode}, ${paletteLabel}, ${colors.length} colors, ${bytes} bytes)\n`);
  }
  return 0;
}

export { HELP };
