![UltiPixelizer](https://tf2stats.r60d.xyz/UltiPixelizerWeb/brand.png)

![UltiPixelizer example](https://tf2stats.r60d.xyz/UltiPixelizerWeb/Example.png)

On the surface, UltiPixelizer is an easy-to-use dithering tool for textures. But feed it a 3D model and you can bake lighting and ambient occlusion, which, combined with a normal map and a base color, achieve a retro PS1-esque aesthetic. Every file is processed locally in your browser; nothing is uploaded.

## Demo

Drag and drop a texture or a 3D model bundle straight into the window:

![Quick drag and drop usage](https://tf2stats.r60d.xyz/UltiPixelizerWeb/QuickDragDropUsage.webp)

## Showcase

Bake ambient occlusion directly in the app and apply it straight to the combined dither result:

![Baking ambient occlusion](https://tf2stats.r60d.xyz/UltiPixelizerWeb/BakeAO.webp)

Bake lightmaps directly in the app and apply them straight to the combined dither result:

![Baking lightmaps](https://tf2stats.r60d.xyz/UltiPixelizerWeb/BuiltinLightmaps.webp)

Nine dither methods, from error diffusion to a lighting-driven halftone dot screen:

![Nine dither methods](https://tf2stats.r60d.xyz/UltiPixelizerWeb/DitherMethods.webp)

Comes with 47 built-in palettes:

![Palette showcase](https://tf2stats.r60d.xyz/UltiPixelizerWeb/PaletteShowcase.webp)

Posterize ramps adapt their colors to your texture's tones:

![Dynamic posterize palettes](https://tf2stats.r60d.xyz/UltiPixelizerWeb/DynamicPosterizePalette.png)

Build your own palettes with the custom palette editor, save them in the app, and export any palette as a `.hex` color list. Import palettes back from `.hex` or plain-text files  the palette name comes from the file name:

![Custom palettes](https://tf2stats.r60d.xyz/UltiPixelizerWeb/CustomPalettes.png)

## Features

- **Image + model input**: drop a PNG/JPG/WebP/GIF texture, or a 3D model bundle (FBX, OBJ, glTF/GLB, USDZ plus companion textures).
- **Pixelation**: target resolution from 24 to 2048 px (2K).
- **Dithering**: Floyd-Steinberg, Atkinson, Ordered 4×4, Halftone, Cross, Stripes, Noise, Checker, and Hard map (no diffusion).
- **Palettes**: 47 built-in palettes  including 8 Posterize ramps (2–16 levels) whose colors are derived live from your BaseColor  plus a custom palette editor with import/export.
- **Adjustments**: brightness, contrast, and saturation.
- **3D preview**: orbit the model with baked lighting applied; select UV channel, LOD level, and world axis (Blender Z-up / Maya Y-up).
- **Baking**: generate ambient occlusion, bake lighting into UV space, and apply normal maps.
- **UV overlap visualization**: an animated screen-space glow wave highlights overlapping UV shells.
- **Export**: save the dithered result as a PNG, and save/load settings as JSON.

## Usage

Open the live app at [ultikynnys.github.io/UltiPixelizer](https://ultikynnys.github.io/UltiPixelizer/).

## Headless CLI

UltiPixelizer also runs headless  the same dither pipeline, palettes, and
settings format as the web app, with no browser or GPU. Build it once:

```bash
npm install
npm run build:cli          # -> dist-cli/ultipixelizer.mjs
```

Then dither any texture to a pixel-art PNG:

```bash
node dist-cli/ultipixelizer.mjs --input texture.png --output out.png --palette gameboy --mode floyd --resolution 128
```

Or, once the package is linked (`npm link`), via the `ultipixelizer` bin:

```bash
ultipixelizer -i texture.png -o out.png -p ultipixelizer-settings.json
```

Key options (full list via `--help`):

| Option | Meaning |
| --- | --- |
| `-i, --input <file>` | Source image (`.png` / `.jpg` / `.jpeg`) |
| `-o, --output <file>` | Output PNG (default `<input>_ultipixelized.png`) |
| `-p, --preset <file>` | Load an app settings/preset JSON (same format as the in-app export) |
| `--palette <key>` | Built-in palette key (`--list-palettes`) |
| `--palette-file <file>` | Custom palette (`.json` or a one-color-per-line `.hex` list) |
| `-m, --mode <mode>` | Dither mode (`--list-modes`) |
| `-r, --resolution <n>` | Target pixel width, 1–4096 |
| `--strength --brightness --contrast --saturation --pixelation --upscale --stripe-angle --seed` | Tone / dither controls |
| `--json` | Emit a machine-readable result summary |

```bash
# Batch a folder to GameBoy-color thumbnails
for f in textures/*.png; do
  node dist-cli/ultipixelizer.mjs -i "$f" --palette gameboy -r 64
done
```

Preset values are used as-is; any flag you pass on the command line overrides
the corresponding preset field. The `world` pattern space (which needs per-texel
world positions from a 3D bake) is intentionally not available in the CLI.

## License

[MIT](LICENSE)

## Support

If you find UltiPixelizer useful, consider supporting the developer on Ko-fi:

<a href="https://ko-fi.com/r60dr60d" target="_blank"><img src="https://storage.ko-fi.com/cdn/kofi5.png?v=6" height="36" alt="Support me on Ko-fi at ko-fi.com" /></a>

## Attributions

3D models used in the demo videos and screenshots:

- ["Needle OC"](https://sketchfab.com/3d-models/needle-oc-2d523b639c79407daff09ed23491e706) by [CataRackta](https://www.artstation.com/catarackta), [CC Attribution](https://creativecommons.org/licenses/by/4.0/)
- ["Gun of Leila from D the Vampire Hunter - Blood L"](https://sketchfab.com/3d-models/gun-of-leila-from-d-the-vampire-hunter-blood-l-3RXKSlKHlIhV8Cjs1DqRq3mQheN) by Csaba Baity (tsabszy), [CC Attribution](https://creativecommons.org/licenses/by/4.0/)
