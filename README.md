# UltiPixelizer

> A local, browser-based texture pixelation and palette-dithering studio for 3D models.

![UltiPixelizer example](Assets/Example.png)

UltiPixelizer turns a texture — or a whole 3D model — into crisp, palette-driven pixel art, entirely in your browser. Every file is processed locally; nothing is uploaded.

## Features

- **Image + model input** — drop a PNG/JPG/WebP/GIF texture, or a 3D model bundle (FBX, OBJ, glTF/GLB plus companion textures).
- **Pixelation** — target resolution from 24 to 512 px.
- **Dithering** — Floyd–Steinberg, Atkinson, Ordered 4×4, Cross, Stripes, Noise, Checker, and Hard map (no diffusion).
- **Palettes** — 30 built-in presets plus a custom palette editor with import/export.
- **Adjustments** — brightness, contrast, and saturation.
- **3D preview** — orbit the model with live sun/ambient lighting; select UV channel, LOD level, and world axis (Blender Z-up / Maya Y-up).
- **Baking** — generate ambient occlusion, bake lighting into UV space, and apply normal maps.
- **UV overlap visualization** — an animated screen-space glow wave highlights overlapping UV shells.
- **Export** — save the dithered result as a PNG, and save/load settings as JSON.

## Getting started

### Prerequisites

- Node.js 20.19+

### Development

```bash
npm install
npm run dev
```

### Build

```bash
npm run build     # type-check + production build (outputs to dist/)
npm run preview   # preview the production build
```

### Tests

```bash
npm test              # run the Vitest suite
npm run test:coverage # run with coverage
```

## Usage

1. Drop a texture onto the **BaseColor** slot, or drop a model bundle (e.g. an FBX plus its textures) onto the **Model** slot.
2. Pick a resolution, palette, and dither mode.
3. Toggle **2D / 3D** to preview on the texture or on the model.
4. Optionally generate AO, bake lighting, and enable the **UV overlap** view.
5. **Export PNG**.

## Tech stack

- [Vite](https://vitejs.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [three.js](https://threejs.org/) for 3D rendering
- [Vitest](https://vitest.dev/) for testing
- GitHub Actions builds and deploys to GitHub Pages on every push to `main`

## License

[MIT](LICENSE)
