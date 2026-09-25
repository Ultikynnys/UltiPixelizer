/**
 * UltiPixelizer headless CLI.
 *
 * Runs the app's dither + bake pipeline on files, with no browser or GPU:
 * every save-config setting is a flag, AO and lighting can be baked from a 3D
 * model, and the output texture type is chosen by the view mode  exactly like
 * the app's Export PNG button.
 *
 * Import order matters: `./imagedata` installs the `ImageData` shim before the
 * pipeline modules load.
 */
import './imagedata';

import { writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Object3D } from 'three';
import { ditherModes } from '../src/lib/presets';
import { redChannelFactors } from '../src/lib/ao';
import { isWorldCapable } from '../src/lib/dither';
import { getBakeScene } from '../src/lib/bakeSceneCache';
import { rasterizeWorldPositions, type WorldPositionMap } from '../src/lib/bakeGeometry';
import { createPreset, serializePreset } from '../src/lib/presets';
import { palettes } from '../src/lib/palettes';
import { decodeImage, encodePng } from './imageIo';
import { computeOutputDimensions, resampleAndPixelate } from './resample';
import { bakeAO, bakeLighting, normalMapAtBakeResolution } from './bake';
import { fallbackQuad, loadModel, prepareModel, type ModelPrep } from './model';
import { composeView } from './compose';
import {
  buildConfig,
  configHelp,
  CliError,
  EXPORT_VIEW_SUFFIX,
  parseCli,
  VIEW_MODES,
  type CliOptions,
} from './config';

const HELP = `UltiPixelizer CLI  headless texture dithering + baking

Usage:
  ultipixelizer --input <file> [--output <file>] [options]

Input / output:
  -i, --input <file>          Source base texture (.png / .jpg / .jpeg)
  -o, --output <file>         Output PNG (default <input>_<View>.png)
  -p, --preset <file>         Load an UltiPixelizer settings/preset JSON
      --palette <key>         Built-in palette key (see --list-palettes)
      --palette-file <file>   Custom palette (.json or .hex color list)
      --normal <file>         Normal map input (used by bakes + Normals view)
      --ao <file>             Pre-baked AO map input
      --lightmap <file>       Pre-baked lightmap input

View mode (the output texture type  see --list-views):
  -v, --view <mode>           ${VIEW_MODES.join(' | ')}

3D model + baking:
      --model <file>          Model for bakes (.fbx / .obj / .gltf / .glb)
      --uv-map <name>         UV channel for baking                    [uv]
      --lod <n>               LOD level to bake                       [0]
      --world-axis <axis>     blender | maya                          [maya]
      --generate-ao           Bake ambient occlusion from the model
      --bake-lighting         Bake a lightmap from the model
      --ao-samples <n>        Hemisphere samples per texel            [64]
      --sun-direction <x,y,z> Sun travel direction
      --sun-azimuth <deg>     Sun azimuth (0 = +Z, toward +X)         [45]
      --sun-elevation <deg>   Sun elevation above horizon             [45]

Config round-trip:
      --dump-config [<file>]  Write the current settings as a preset JSON and exit

Info:
      --list-palettes         List built-in palette keys and exit
      --list-modes            List dither modes and exit
      --list-views            List view modes and exit
      --json                  Print a machine-readable result summary
  -h, --help                  Show this help

Every serialized setting is a flag (mirrors the save config):
${configHelp()}`;

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
  for (const mode of ditherModes) process.stdout.write(`  ${mode}\n`);
}

function listViews(): void {
  process.stdout.write('View modes (output texture type):\n');
  for (const view of VIEW_MODES) {
    process.stdout.write(`  ${view.padEnd(16)} -> _${EXPORT_VIEW_SUFFIX[view]}.png\n`);
  }
}

function defaultOutputPath(input: string, view: string): string {
  return join(dirname(input), `${basename(input, extname(input))}_${EXPORT_VIEW_SUFFIX[view as keyof typeof EXPORT_VIEW_SUFFIX]}.png`);
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes('--list-palettes')) { listPalettes(); return 0; }
  if (argv.includes('--list-modes')) { listModes(); return 0; }
  if (argv.includes('--list-views')) { listViews(); return 0; }

  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    if (error instanceof CliError) { process.stderr.write(`error: ${error.message}\n`); return 2; }
    throw error;
  }
  if (options.help) { process.stdout.write(`${HELP}\n`); return 0; }

  let config; let colors: string[]; let paletteLabel: string;
  try {
    ({ config, colors, paletteLabel } = buildConfig(options));
  } catch (error) {
    if (error instanceof CliError) { process.stderr.write(`error: ${error.message}\n`); return 2; }
    throw error;
  }

  // --dump-config writes a preset of the resolved settings and exits.
  if (options.dumpConfig !== null) {
    const path = options.dumpConfig || (options.input
      ? join(dirname(resolve(options.input)), `${basename(options.input, extname(options.input))}.settings.json`)
      : 'ultipixelizer-settings.json');
    const name = basename(path, extname(path));
    writeFileSync(resolve(path), serializePreset(createPreset(name, '', config)));
    process.stdout.write(`Wrote preset: ${resolve(path)}\n`);
    return 0;
  }

  if (!options.input) {
    process.stderr.write('error: --input <file> is required. Try --help.\n');
    return 2;
  }

  try {
    return await runPipeline(options, config, colors, paletteLabel);
  } catch (error) {
    if (error instanceof CliError) { process.stderr.write(`error: ${error.message}\n`); return 2; }
    throw error;
  }
}

async function runPipeline(
  options: CliOptions,
  config: import('../src/lib/presets').ConversionConfig,
  colors: string[],
  paletteLabel: string,
): Promise<number> {
  const base = await decodeImage(resolve(options.input!));
  const normal = options.normal ? await decodeImage(resolve(options.normal)) : null;
  const aoInput = options.aoMap ? await decodeImage(resolve(options.aoMap)) : null;
  const lightmapInput = options.lightmapMap ? await decodeImage(resolve(options.lightmapMap)) : null;

  const reference = base ?? normal ?? aoInput ?? lightmapInput;
  const { width, height } = computeOutputDimensions(config.resolution, reference!);

  // World-space dithering needs per-texel world positions baked from the scene.
  const useWorld = config.patternSpace === 'world' && isWorldCapable(config.mode);
  let worldPositions: WorldPositionMap | null = null;

  // Scene for bakes (a model, else the fallback quad) and for stretch/variance
  // views (a model only).
  let scene: Object3D | null = null;
  let modelPrep: ModelPrep | null = null;
  if (options.model) {
    scene = await loadModel(resolve(options.model));
    modelPrep = prepareModel(scene, { worldAxis: options.worldAxis, lod: options.lod, uvMap: options.uvMap });
  } else if (options.generateAo || options.bakeLighting || useWorld) {
    scene = fallbackQuad(config.quadTessellation, config.quadGrid);
  }
  const viewScene: Object3D | null = options.model ? scene : null;

  if (useWorld && scene) {
    const bakeScene = getBakeScene(scene);
    if (bakeScene) worldPositions = rasterizeWorldPositions(bakeScene, width, height);
  }

  const normalAtBake = normal ? normalMapAtBakeResolution(normal, width, height, config.pixelation, config.upscale) : null;

  // AO: bake, or use a provided map (resampled to the grid).
  let aoFactors = null as Uint8ClampedArray | null;
  if (options.generateAo) {
    aoFactors = bakeAO(scene!, width, height, config, options.aoSamples, normalAtBake);
  } else if (aoInput) {
    aoFactors = redChannelFactors(resampleAndPixelate(aoInput, width, height, config.pixelation, config.upscale));
  }

  // Lightmap: bake, or use a provided map.
  let lightmap = null as Uint8ClampedArray | null;
  if (options.bakeLighting) {
    lightmap = bakeLighting(scene!, width, height, config, normalAtBake);
  } else if (lightmapInput) {
    lightmap = resampleAndPixelate(lightmapInput, width, height, config.pixelation, config.upscale).data;
  }

  const output = composeView({
    base, normal, aoFactors, lightmap, scene: viewScene, worldPositions,
    width, height, config, colors, view: options.view,
  });

  const outputPath = options.output ? resolve(options.output) : defaultOutputPath(resolve(options.input!), options.view);
  const bytes = await encodePng(outputPath, { data: output, width, height });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      input: resolve(options.input!),
      output: outputPath,
      view: options.view,
      resolution: config.resolution,
      size: { width, height },
      mode: config.mode,
      palette: paletteLabel,
      paletteColors: colors.length,
      generatedAo: options.generateAo,
      bakedLighting: options.bakeLighting,
      model: options.model ? resolve(options.model) : null,
      modelPrep,
      bytes,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`UltiPixelizer: ${resolve(options.input!)}  [${options.view}]\n`);
    process.stdout.write(`  -> ${outputPath}  (${width}x${height}, ${config.mode}, ${paletteLabel})\n`);
  }
  return 0;
}

export { HELP };
