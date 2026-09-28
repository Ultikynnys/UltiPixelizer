/**
 * UltiPixelizer headless CLI core.
 *
 * Runs the app's dither + bake pipeline on files, with no browser: every
 * save-config setting is a flag, AO and lighting can be baked from a 3D model,
 * and the output texture type is chosen by the view mode  exactly like the
 * app's Export PNG button.
 *
 * Host-agnostic (see host.ts): the desktop binary drives this from its hidden
 * `cli` webview (src/cli/main.ts)  where the webview supplies `navigator.gpu`,
 * so AO bakes run on the GPU  and the Node test host drives it in CI. Import
 * order matters: `./imagedata` installs the `ImageData` shim before the
 * pipeline modules load (a no-op in the webview, which has ImageData natively).
 */
import './imagedata';

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
import { cliHost } from './host';
import { basename, dirname, extname, join } from './path';
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
  UltiPixelizer --input <file> [--output <file>] [options]

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
      --world-axis <axis>     blender | maya                          [blender]
      --generate-ao           Bake ambient occlusion from the model
      --bake-lighting         Bake a lightmap from the model
      --ao-samples <n>        Hemisphere samples per texel            [64]
      --gpu / --no-gpu        Run the AO bake on the GPU              [--gpu]
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
  cliHost().log(`${keys.length} built-in palettes:\n`);
  for (const key of keys) {
    const p = palettes[key];
    cliHost().log(`  ${key.padEnd(22)} ${String(p.colors.length).padStart(3)} colors  ${p.name}\n`);
  }
}

function listModes(): void {
  cliHost().log('Dither modes:\n');
  for (const mode of ditherModes) cliHost().log(`  ${mode}\n`);
}

function listViews(): void {
  cliHost().log('View modes (output texture type):\n');
  for (const view of VIEW_MODES) {
    cliHost().log(`  ${view.padEnd(16)} -> _${EXPORT_VIEW_SUFFIX[view]}.png\n`);
  }
}

/** Output file name: `<stem>_<View>.png` in `dir`, matching the app's export
 * naming (model stem when a model is loaded, else the base image stem). */
function outputFileName(dir: string, stem: string, view: string): string {
  return join(dir, `${stem}_${EXPORT_VIEW_SUFFIX[view as keyof typeof EXPORT_VIEW_SUFFIX]}.png`);
}

export async function runCli(argv: string[]): Promise<number> {
  const host = cliHost();
  if (argv.includes('--list-palettes')) { listPalettes(); await host.flush(); return 0; }
  if (argv.includes('--list-modes')) { listModes(); await host.flush(); return 0; }
  if (argv.includes('--list-views')) { listViews(); await host.flush(); return 0; }

  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    if (error instanceof CliError) { host.error(`error: ${error.message}\n`); await host.flush(); return 2; }
    throw error;
  }
  if (options.help) { host.log(`${HELP}\n`); await host.flush(); return 0; }

  let config; let colors: string[]; let paletteLabel: string;
  try {
    ({ config, colors, paletteLabel } = await buildConfig(options));
  } catch (error) {
    if (error instanceof CliError) { host.error(`error: ${error.message}\n`); await host.flush(); return 2; }
    throw error;
  }

  // --dump-config writes a preset of the resolved settings and exits.
  if (options.dumpConfig !== null) {
    const path = options.dumpConfig || (options.input
      ? join(dirname(host.resolvePath(options.input)), `${basename(options.input, extname(options.input))}.settings.json`)
      : 'ultipixelizer-settings.json');
    const name = basename(path, extname(path));
    const resolved = host.resolvePath(path);
    await host.writeFileBytes(resolved, new TextEncoder().encode(serializePreset(createPreset(name, '', config))));
    host.log(`Wrote preset: ${resolved}\n`);
    await host.flush();
    return 0;
  }

  if (!options.input) {
    host.error('error: --input <file> is required. Try --help.\n');
    await host.flush();
    return 2;
  }

  try {
    const code = await runPipeline(options, config, colors, paletteLabel);
    await host.flush();
    return code;
  } catch (error) {
    if (error instanceof CliError) { host.error(`error: ${error.message}\n`); await host.flush(); return 2; }
    throw error;
  }
}

async function runPipeline(
  options: CliOptions,
  config: import('../src/lib/presets').ConversionConfig,
  colors: string[],
  paletteLabel: string,
): Promise<number> {
  const host = cliHost();
  const base = await decodeImage(host.resolvePath(options.input!));
  const normal = options.normal ? await decodeImage(host.resolvePath(options.normal)) : null;
  const aoInput = options.aoMap ? await decodeImage(host.resolvePath(options.aoMap)) : null;
  const lightmapInput = options.lightmapMap ? await decodeImage(host.resolvePath(options.lightmapMap)) : null;

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
    scene = await loadModel(host.resolvePath(options.model));
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

  // AO: bake, or use a provided map (resampled to the grid). The bake runs on
  // the GPU (via navigator.gpu) when available and `--no-gpu` was not passed.
  let aoFactors = null as Uint8ClampedArray | null;
  if (options.generateAo) {
    aoFactors = await bakeAO(scene!, width, height, config, options.aoSamples, normalAtBake, options.gpu);
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

  const inputPath = host.resolvePath(options.input!);
  const modelPath = options.model ? host.resolvePath(options.model) : null;
  // The app names the export after the model when one is loaded, else the base
  // image (both sans extension)  matched here.
  const stem = modelPath ? basename(modelPath, extname(modelPath)) : basename(inputPath, extname(inputPath));
  const outputPath = options.output ? host.resolvePath(options.output) : outputFileName(dirname(inputPath), stem, options.view);
  const bytes = await encodePng(outputPath, { data: output, width, height });

  // Whether the AO bake ran on the GPU: WebGPU is present (the webview always
  // provides it; Node never does) and neither the view nor --no-gpu forbade it.
  const gpu = options.generateAo && options.gpu && typeof navigator !== 'undefined' && Boolean(navigator.gpu);

  if (options.json) {
    host.log(`${JSON.stringify({
      input: inputPath,
      output: outputPath,
      view: options.view,
      resolution: config.resolution,
      size: { width, height },
      mode: config.mode,
      palette: paletteLabel,
      paletteColors: colors.length,
      generatedAo: options.generateAo,
      bakedLighting: options.bakeLighting,
      gpu,
      model: options.model ? host.resolvePath(options.model) : null,
      modelPrep,
      bytes,
    }, null, 2)}\n`);
  } else {
    host.log(`UltiPixelizer: ${inputPath}  [${options.view}]\n`);
    host.log(`  -> ${outputPath}  (${width}x${height}, ${config.mode}, ${paletteLabel})\n`);
    if (gpu) host.log(`  gpu: WebGPU (AO bake)\n`);
  }
  return 0;
}

export { HELP };
