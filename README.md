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

UltiPixelizer also runs headless  the same dither **and bake** pipeline,
palettes, and settings format as the web app, with no browser or GPU. Build it
once:

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

### Output texture type = view mode

`--view` selects which texture is written  exactly like the app's Export PNG
button, including the file-name suffix (`--list-views`):

| `--view` | Output |
| --- | --- |
| `flat` | BaseColor, dithered, with AO × lightmap applied (`*_Combined.png`) |
| `basecolor` | BaseColor, dithered, no lighting (`*_BaseColor.png`) |
| `normals` | Normal map, pixelized (`*_Normal.png`) |
| `ao` | Bias/power-remapped AO (`*_AO.png`) |
| `lightmap` | Raw lightmap (`*_Lightmap.png`) |
| `lightmap-ao` | AO × lightmap (`*_LightmapAO.png`) |
| `uv-stretch` / `texel-variance` | UV diagnostics from the model |
| `directionality` | UV-directionality reference |

### Every setting is a flag

All serialized settings are exposed as `--kebab-case` flags with the same
validation as the app (`--help` lists them all)  e.g. `--ao-bias`, `--ao-power`,
`--ao-distance`, `--sun-color`, `--sun-intensity`, `--ambient-color`,
`--ambient-intensity`, `--normal-strength`, `--normal-format`,
`--uv-stretch-sensitivity`, `--quad-tessellation`, `--quad-grid`,
`--displacement-strength`, `--displacement-flip`, `--pattern-space`,
`--uv-scale`, `--worldspace-scale`, `--seed`, and the palette-library fields.

```bash
# Bake AO + a lightmap from a model, then export the combined texture
node dist-cli/ultipixelizer.mjs \
  -i texture.png --model prop.fbx --normal texture_Normal.png \
  --generate-ao --bake-lighting \
  --sun-azimuth 120 --sun-elevation 35 --sun-intensity 1.4 --ambient-intensity 0.3 \
  --palette c64 --view flat -r 256
```

Key options:

| Option | Meaning |
| --- | --- |
| `-i, --input <file>` | Source base texture (`.png` / `.jpg` / `.jpeg`) |
| `-o, --output <file>` | Output PNG (default `<input>_<View>.png`) |
| `-p, --preset <file>` | Load an app settings/preset JSON |
| `--palette <key>` / `--palette-file <file>` | Built-in palette, or custom JSON/`.hex` |
| `--normal <file>` / `--ao <file>` / `--lightmap <file>` | Map inputs |
| `-m, --mode <mode>`, `-r, --resolution <n>` | Dither mode (`--list-modes`), target width |
| `--model <file>` | Model for bakes (`.fbx` / `.obj` / `.gltf` / `.glb`) |
| `--uv-map`, `--lod`, `--world-axis` | Model preparation |
| `--generate-ao` / `--bake-lighting` | Bake from the model (fallback quad if none) |
| `--sun-azimuth` / `--sun-elevation` / `--sun-direction x,y,z` | Sun angle |
| `--dump-config [<file>]` | Write the current settings as a preset JSON and exit |
| `--json` | Machine-readable result summary |
| `--list-palettes` / `--list-modes` / `--list-views` | Discover values |

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
