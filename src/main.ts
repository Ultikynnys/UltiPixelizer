import './style.css';
import { createSampleTexture, downloadCanvas, downloadText, loadImageFile } from './lib/canvas';
import { createCustomPalette, deleteCustomPalette, duplicatePalette, loadCustomPalettes, parseCustomPalette, serializeCustomPalette, updateCustomPalette, upsertCustomPalette, type CustomPalette } from './lib/customPalettes';
import { processImageData, type DitherMode } from './lib/dither';
import { palettes, type Palette, type PaletteCategory } from './lib/palettes';
import { createRenderScheduler } from './lib/renderScheduler';
import { createModelFileBundle, modelFormat, type ModelFileBundle } from './lib/modelFiles';
import { cloneModelScene, disposeModel, geometryUVChannels } from './lib/modelScene';
import { applyLodLevel, prepareModelLods } from './lib/modelLod';
import { loadModel, ModelViewport } from './lib/modelPreview';
import { createPreset, parsePreset, serializePreset, type ConversionPreset } from './lib/presets';
import { applyAO, imageAOFactors } from './lib/ao';
import { bakeMeshAO } from './lib/aoBake';
import { Mesh, MeshBasicMaterial, type Object3D } from 'three';

type SourceImage = CanvasImageSource & { width: number; height: number };

type TextureChannelId = 'base' | 'ao' | 'normal';

type TextureSlot = { image: SourceImage | null; name: string };

const TEXTURE_CHANNELS: ReadonlyArray<{ id: TextureChannelId; label: string }> = [
  { id: 'base', label: 'BaseColor' },
  { id: 'ao', label: 'AO' },
  { id: 'normal', label: 'Normal' },
];

type State = {
  paletteKey: string;
  customColors: string[];
  paletteSnapshot?: Palette;
  resolution: number;
  mode: DitherMode;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  paletteFilter: PaletteCategory | 'all';
  uvMap: string;
  lodLevel: number;
  sunAzimuth: number;
  sunElevation: number;
  stripeAngle: number;
  noiseScale: number;
  seed: number;
  aoIntensity: number;
  aoDistance: number;
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application root not found.');

const buildNumber = import.meta.env.VITE_BUILD_NUMBER || 'DEV';
const commitSha = import.meta.env.VITE_COMMIT_SHA || 'LOCAL';
const buildLabel = `v${buildNumber} · ${commitSha}`;

const sample = createSampleTexture();
const textures: Record<TextureChannelId, TextureSlot> = {
  base: { image: sample, name: 'sample-landscape.png' },
  ao: { image: null, name: '' },
  normal: { image: null, name: '' },
};
const state: State = {
  paletteKey: 'pico8',
  customColors: [],
  resolution: 128,
  mode: 'floyd',
  strength: 0.85,
  brightness: 0,
  contrast: 8,
  saturation: 5,
  paletteFilter: 'all',
  uvMap: 'uv',
  lodLevel: 0,
  sunAzimuth: 45,
  sunElevation: 45,
  stripeAngle: 45,
  noiseScale: 1,
  seed: 1,
  aoIntensity: 1,
  aoDistance: 2,
};

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-group">
        <a class="brand" href="#" aria-label="UltiPixelizer home">
          <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span>ULTI<span>PIXELIZER</span></span>
        </a>
        <span class="build-version" title="Build version and commit">${buildLabel}</span>
        <a class="circle-link circle-github" href="https://github.com/Ultikynnys/UltiPixelizer" target="_blank" rel="noopener noreferrer" aria-label="GitHub repository">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
          <span class="circle-label">GitHub</span>
        </a>
        <a class="circle-link circle-kofi" href="https://ko-fi.com/r60dr60d" target="_blank" rel="noopener noreferrer" aria-label="Support the developer on Ko-fi">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M11.351 2.715c-2.7 0-4.986.025-6.83.26C2.078 3.285 0 5.154 0 8.61c0 3.506.182 6.13 1.585 8.493 1.584 2.701 4.233 4.182 7.662 4.182h.83c4.209 0 6.494-2.234 7.637-4a9.5 9.5 0 0 0 1.091-2.338C21.792 14.688 24 12.22 24 9.208v-.415c0-3.247-2.13-5.507-5.792-5.87-1.558-.156-2.65-.208-6.857-.208m0 1.947c4.208 0 5.09.052 6.571.182 2.624.311 4.13 1.584 4.13 4v.39c0 2.156-1.792 3.844-3.87 3.844h-.935l-.156.649c-.208 1.013-.597 1.818-1.039 2.546-.909 1.428-2.545 3.064-5.922 3.064h-.805c-2.571 0-4.831-.883-6.078-3.195-1.09-2-1.298-4.155-1.298-7.506 0-2.181.857-3.402 3.012-3.714 1.533-.233 3.559-.26 6.39-.26m6.547 2.287c-.416 0-.65.234-.65.546v2.935c0 .311.234.545.65.545 1.324 0 2.051-.754 2.051-2s-.727-2.026-2.052-2.026m-10.39.182c-1.818 0-3.013 1.48-3.013 3.142 0 1.533.858 2.857 1.949 3.897.727.701 1.87 1.429 2.649 1.896a1.47 1.47 0 0 0 1.507 0c.78-.467 1.922-1.195 2.623-1.896 1.117-1.039 1.974-2.364 1.974-3.897 0-1.662-1.247-3.142-3.039-3.142-1.065 0-1.792.545-2.338 1.298-.493-.753-1.246-1.298-2.312-1.298"/></svg>
          <span class="circle-label">Support the developer!</span>
        </a>
      </div>
      <div class="topbar-actions">
        <button class="button button-quiet" id="saveButton" type="button">Save</button>
        <button class="button button-quiet" id="loadButton" type="button">Load</button>
        <button class="button button-quiet" id="resetButton" type="button">Reset settings</button>
        <input id="loadConfigInput" type="file" accept=".json,application/json" hidden />
      </div>
    </header>

    <main class="workspace">
      <section class="preview-column" aria-label="Texture preview">
        <div class="preview-toolbar">
          <div>
            <p class="eyebrow">TEXTURE PREVIEW</p>
            <h1 id="fileName">${textures.base.name}</h1>
          </div>
          <div class="toolbar-actions">
            <label class="uv-control" id="uvControl" hidden><span>UV map</span><select id="uvMap" aria-label="Model UV map"></select></label>
            <label class="uv-control" id="lodControl" hidden><span>LOD</span><select id="lodMap" aria-label="Model LOD level"></select></label>
            <div class="sun-control" id="sunControl" hidden>
              <span>Sun</span>
              <label class="sun-axis"><span>Azimuth</span><input id="sunAzimuth" class="range sun-range" type="range" min="0" max="360" value="45" aria-label="Sun azimuth" /></label>
              <label class="sun-axis"><span>Elevation</span><input id="sunElevation" class="range sun-range" type="range" min="0" max="90" value="45" aria-label="Sun elevation" /></label>
            </div>
            <span class="dimension-badge" id="dimensionBadge">128 × 92 PX</span>
          </div>
        </div>

        <div class="texture-ribbon" id="textureRibbon" aria-label="Texture sources">
          ${TEXTURE_CHANNELS.map((channel) => `
            <div class="texture-slot" data-texture="${channel.id}" tabindex="0" aria-label="${channel.label} texture slot">
              <span class="texture-slot-preview"><span class="texture-slot-empty-mark">+</span></span>
              <span class="texture-slot-label">+${channel.label}</span>
              <button class="texture-slot-clear" data-clear-texture="${channel.id}" type="button" aria-label="Clear ${channel.label}">×</button>
            </div>
          `).join('')}
          <div class="texture-slot texture-slot-model" data-model-slot tabindex="0" aria-label="Model bundle slot">
            <span class="texture-slot-preview"><span class="texture-slot-empty-mark">+</span></span>
            <span class="texture-slot-label">+Model</span>
            <button class="texture-slot-clear" data-clear-model type="button" aria-label="Clear model">×</button>
          </div>
          <input id="textureInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
          <input id="modelInput" type="file" multiple accept=".fbx,.obj,.mtl,.gltf,.glb,.bin,image/*" hidden />
        </div>

        <div class="canvas-stage" id="dropZone">
          <div class="comparison-grid" aria-label="Original and dithered texture comparison">
            <figure class="preview-pane original-pane">
              <figcaption><span>01</span> Original</figcaption>
              <div class="canvas-frame"><canvas id="originalCanvas" aria-label="Original texture preview"></canvas><div class="model-host" id="originalModelHost" hidden></div></div>
            </figure>
            <figure class="preview-pane processed-pane">
              <figcaption><span>02</span> Dithered</figcaption>
              <div class="canvas-frame"><canvas id="previewCanvas" aria-label="Dithered texture preview"></canvas><div class="model-host" id="processedModelHost" hidden></div></div>
            </figure>
          </div>
          <div class="drop-hint" id="dropHint">Drop an image or model bundle anywhere</div>
          <div class="preview-mode-toggle" id="previewModeToggle" hidden role="group" aria-label="Preview mode">
            <button type="button" data-preview-mode="2d" class="active">2D</button>
            <button type="button" data-preview-mode="3d">3D</button>
          </div>
        </div>

        <footer class="preview-footer">
          <div class="file-meta">
            <span class="meta-icon">▧</span>
            <div><strong id="footerFileName">${textures.base.name}</strong><small id="sourceDimensions">640 × 461 source</small></div>
          </div>
          <button class="button button-primary" id="exportButton" type="button">Export PNG <span>↓</span></button>
        </footer>
      </section>

      <aside class="control-column">
        <section class="panel">
          <div class="panel-heading">
            <div><p class="eyebrow">RESOLUTION</p><h2>Pixel grid</h2></div>
            <output class="value-pill" id="resolutionValue">128 px</output>
          </div>
          <input class="range" id="resolution" type="range" min="24" max="512" step="8" value="128" aria-label="Pixelization width" />
          <div class="range-labels"><span>CHUNKY</span><span>FINE</span></div>
          <div class="resolution-presets" role="group" aria-label="Resolution presets">
            <button type="button" data-resolution="32">32</button>
            <button type="button" data-resolution="64">64</button>
            <button class="active" type="button" data-resolution="128">128</button>
            <button type="button" data-resolution="256">256</button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><p class="eyebrow">COLOR SYSTEM / 02</p><h2>Palette library</h2></div><span class="catalog-count" id="paletteCount">${Object.keys(palettes).length} PRESETS</span></div>
          <div class="palette-filters" id="paletteFilters" role="group" aria-label="Filter palette library">
            <button class="active" type="button" data-filter="all">All</button>
            <button type="button" data-filter="compact">Compact</button>
            <button type="button" data-filter="pixel-art">Pixel art</button>
            <button type="button" data-filter="hardware">Hardware</button>
            <button type="button" data-filter="themed">Themed</button>
            <button type="button" data-filter="extended">Extended</button>
            <button type="button" data-filter="custom">Custom</button>
          </div>
          <div class="palette-grid" id="paletteGrid"></div>
          <div class="palette-detail">
            <div><strong id="paletteName">PICO-8</strong><small id="paletteDescription">Punchy fantasy console</small></div>
            <div class="swatch-strip" id="activeSwatches"></div>
          </div>
          <details class="custom-palette" open>
            <summary>Custom palette editor <span>+</span></summary>
            <fieldset class="palette-editor" id="paletteEditor">
              <div class="palette-editor-fields">
                <label><span>Name</span><input id="customPaletteName" maxlength="60" placeholder="Palette name" /></label>
                <label><span>Description</span><input id="customPaletteDescription" maxlength="160" placeholder="Palette description" /></label>
              </div>
              <div id="customColors" class="custom-colors"></div>
            </fieldset>
          </details>
          <input id="importCustomPalette" type="file" accept="application/json,.json" hidden />
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><p class="eyebrow">DITHER MATRIX / 03</p><h2>Pattern</h2></div></div>
          <div class="mode-grid" role="group" aria-label="Dithering algorithm">
            <button class="mode-button active" data-mode="floyd" type="button"><span class="pattern pattern-noise"></span><strong>Floyd–Steinberg</strong><small>Organic grain</small></button>
            <button class="mode-button" data-mode="atkinson" type="button"><span class="pattern pattern-atkinson"></span><strong>Atkinson</strong><small>Crisp contrast</small></button>
            <button class="mode-button" data-mode="ordered" type="button"><span class="pattern pattern-grid"></span><strong>Ordered 4×4</strong><small>Regular matrix</small></button>
            <button class="mode-button" data-mode="cross" type="button"><span class="pattern pattern-cross"></span><strong>Cross</strong><small>Intersecting bands</small></button>
            <button class="mode-button" data-mode="stripes" type="button"><span class="pattern pattern-stripes"></span><strong>Stripes</strong><small>Directional bands</small></button>
            <button class="mode-button" data-mode="noise" type="button"><span class="pattern pattern-random"></span><strong>Noise</strong><small>Randomized grain</small></button>
            <button class="mode-button" data-mode="checker" type="button"><span class="pattern pattern-checker"></span><strong>Checker</strong><small>Alternating grid</small></button>
            <button class="mode-button" data-mode="none" type="button"><span class="pattern pattern-none"></span><strong>Hard map</strong><small>No diffusion</small></button>
          </div>
          <label class="control-row"><span><strong>Dither strength</strong><small>Error diffusion amount</small></span><output id="strengthValue">85%</output></label>
          <input class="range" id="strength" type="range" min="0" max="100" value="85" aria-label="Dither strength" />
          <div class="stripe-angle-control" id="stripeAngleControl" hidden>
            <label class="control-row"><span><strong>Stripe angle</strong><small>Band direction</small></span><output id="stripeAngleValue">45°</output></label>
            <input class="range" id="stripeAngle" type="range" min="0" max="135" value="45" aria-label="Stripe angle" />
          </div>
          <div class="noise-scale-control" id="noiseScaleControl" hidden>
            <label class="control-row"><span><strong>Noise scale</strong><small>Grain size</small></span><output id="noiseScaleValue">1 px</output></label>
            <input class="range" id="noiseScale" type="range" min="1" max="32" value="1" aria-label="Noise scale" />
            <label class="control-row"><span><strong>Seed</strong><small>Noise pattern</small></span><output id="seedValue">1</output></label>
            <input class="range" id="seed" type="range" min="0" max="9999" value="1" aria-label="Noise seed" />
          </div>
        </section>

        <section class="panel adjustments">
          <div class="panel-heading compact"><div><p class="eyebrow">TONE CONTROL / 04</p><h2>Adjustments</h2></div></div>
          <div id="adjustmentControls"></div>
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><p class="eyebrow">LIGHTING / 05</p><h2>Ambient occlusion</h2></div></div>
          <label class="control-row"><span><strong>Strength</strong><small>Occlusion darkness</small></span><output id="aoIntensityValue">100%</output></label>
          <input class="range" id="aoIntensity" type="range" min="0" max="100" value="100" aria-label="Ambient occlusion strength" />
          <label class="control-row"><span><strong>Distance</strong><small>Ray reach for generated AO</small></span><output id="aoDistanceValue">2.00×</output></label>
          <input class="range" id="aoDistance" type="range" min="0.05" max="3" step="0.05" value="2" aria-label="Ambient occlusion distance" />
          <button class="button button-secondary ao-generate-button" id="generateAoButton" type="button">Generate AO</button>
        </section>
      </aside>
    </main>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </div>
`;

const previewCanvas = document.querySelector<HTMLCanvasElement>('#previewCanvas')!;
const originalCanvas = document.querySelector<HTMLCanvasElement>('#originalCanvas')!;
const paletteGrid = document.querySelector<HTMLDivElement>('#paletteGrid')!;
const paletteFilters = document.querySelector<HTMLDivElement>('#paletteFilters')!;
const activeSwatches = document.querySelector<HTMLDivElement>('#activeSwatches')!;
const customColors = document.querySelector<HTMLDivElement>('#customColors')!;
const customPaletteName = document.querySelector<HTMLInputElement>('#customPaletteName')!;
const customPaletteDescription = document.querySelector<HTMLInputElement>('#customPaletteDescription')!;
const paletteEditor = document.querySelector<HTMLFieldSetElement>('#paletteEditor')!;
const originalModelHost = document.querySelector<HTMLDivElement>('#originalModelHost')!;
const processedModelHost = document.querySelector<HTMLDivElement>('#processedModelHost')!;
const uvControl = document.querySelector<HTMLLabelElement>('#uvControl')!;
const uvMapSelect = document.querySelector<HTMLSelectElement>('#uvMap')!;
const lodControl = document.querySelector<HTMLLabelElement>('#lodControl')!;
const lodMapSelect = document.querySelector<HTMLSelectElement>('#lodMap')!;
const sunControl = document.querySelector<HTMLDivElement>('#sunControl')!;
const sunAzimuthInput = document.querySelector<HTMLInputElement>('#sunAzimuth')!;
const sunElevationInput = document.querySelector<HTMLInputElement>('#sunElevation')!;
const stripeAngleControl = document.querySelector<HTMLDivElement>('#stripeAngleControl')!;
const stripeAngleInput = document.querySelector<HTMLInputElement>('#stripeAngle')!;
const stripeAngleValue = document.querySelector<HTMLOutputElement>('#stripeAngleValue')!;
const noiseScaleControl = document.querySelector<HTMLDivElement>('#noiseScaleControl')!;
const noiseScaleInput = document.querySelector<HTMLInputElement>('#noiseScale')!;
const noiseScaleValue = document.querySelector<HTMLOutputElement>('#noiseScaleValue')!;
const seedInput = document.querySelector<HTMLInputElement>('#seed')!;
const seedValue = document.querySelector<HTMLOutputElement>('#seedValue')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
const loadConfigInput = document.querySelector<HTMLInputElement>('#loadConfigInput')!;
const textureRibbon = document.querySelector<HTMLDivElement>('#textureRibbon')!;
const textureInput = document.querySelector<HTMLInputElement>('#textureInput')!;
const previewModeToggle = document.querySelector<HTMLDivElement>('#previewModeToggle')!;
const aoIntensityInput = document.querySelector<HTMLInputElement>('#aoIntensity')!;
const aoIntensityValue = document.querySelector<HTMLOutputElement>('#aoIntensityValue')!;
const aoDistanceInput = document.querySelector<HTMLInputElement>('#aoDistance')!;
const aoDistanceValue = document.querySelector<HTMLOutputElement>('#aoDistanceValue')!;
const generateAoButton = document.querySelector<HTMLButtonElement>('#generateAoButton')!;
let savedCustomPalettes = loadCustomPalettes(localStorage);
let editingCustomKey: string | null = null;
let toastTimer = 0;
let renderedCanvas = document.createElement('canvas');
let modelBundle: ModelFileBundle | null = null;
let previewMode: '2d' | '3d' = '2d';
let originalViewport: ModelViewport | null = null;
let processedViewport: ModelViewport | null = null;
let modelUVChannels: string[] = [];
let modelLodLevels: number[] = [];
let aoBakeScene: Object3D | null = null;
let pendingTextureChannel: TextureChannelId | null = null;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2400);
}

function customPaletteRecord(): Record<string, CustomPalette> {
  return Object.fromEntries(savedCustomPalettes.map((palette) => [palette.key, palette]));
}

function paletteCatalog(): Record<string, Palette> {
  return { ...palettes, ...customPaletteRecord() };
}

function currentPalette(): Palette {
  return state.paletteSnapshot ?? paletteCatalog()[state.paletteKey] ?? palettes.pico8;
}

function currentColors(): string[] {
  return state.customColors.length > 0 ? state.customColors : currentPalette().colors;
}

function dimensions(): { width: number; height: number } {
  const source = textures.base.image!;
  const width = Math.min(state.resolution, source.width);
  return { width, height: Math.max(1, Math.round(width * source.height / source.width)) };
}

function updatePreviewBadge(width?: number, height?: number): void {
  if (modelBundle) {
    const format = modelFormat(modelBundle.primary.name)?.toUpperCase();
    document.querySelector('#dimensionBadge')!.textContent = `${format} · ${modelUVChannels.length} UV MAP${modelUVChannels.length === 1 ? '' : 'S'}`;
  } else if (width && height) {
    document.querySelector('#dimensionBadge')!.textContent = `${width} × ${height} PX`;
  }
}

const AO_BAKE_SIZE = 512;

function factorsToCanvas(factors: Uint8ClampedArray, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  const imageData = context.createImageData(size, size);
  for (let i = 0; i < factors.length; i += 1) {
    const value = factors[i];
    const offset = i * 4;
    imageData.data[offset] = value;
    imageData.data[offset + 1] = value;
    imageData.data[offset + 2] = value;
    imageData.data[offset + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

function currentAOFactors(width: number, height: number): Uint8ClampedArray | null {
  const source = textures.ao.image;
  if (!source) return null;
  return imageAOFactors(source, width, height);
}

function computeAO(): void {
  const scene = aoBakeScene;
  if (!scene) {
    textures.ao.image = null;
    textures.ao.name = '';
    return;
  }
  textures.ao.image = factorsToCanvas(bakeMeshAO(scene, AO_BAKE_SIZE, AO_BAKE_SIZE, { distance: state.aoDistance }), AO_BAKE_SIZE);
  textures.ao.name = 'Generated AO';
}

function generateAo(): void {
  if (!aoBakeScene) {
    showToast('Load a model to generate AO');
    return;
  }
  showToast('Generating AO…');
  window.setTimeout(() => {
    try {
      computeAO();
      renderTextureRibbon();
      render();
      showToast('Ambient occlusion generated');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not generate ambient occlusion.');
    }
  }, 30);
}

function buildAOScene(source: Object3D): Object3D {
  const clone = cloneModelScene(source);
  const dummy = new MeshBasicMaterial();
  clone.traverse((child) => {
    if (child instanceof Mesh) child.material = dummy;
  });
  return clone;
}

function disposeAOScene(scene: Object3D | null): void {
  if (!scene) return;
  scene.traverse((child) => {
    if (child instanceof Mesh) child.geometry.dispose();
  });
}

function render(): void {
  const { width, height } = dimensions();
  renderedCanvas = document.createElement('canvas');
  renderedCanvas.width = width;
  renderedCanvas.height = height;
  const renderContext = renderedCanvas.getContext('2d', { willReadFrequently: true });
  if (!renderContext) return;
  renderContext.drawImage(textures.base.image!, 0, 0, width, height);
  const sourceData = renderContext.getImageData(0, 0, width, height);

  const aoFactors = currentAOFactors(width, height);
  if (aoFactors) applyAO(sourceData.data, aoFactors, state.aoIntensity);

  const litSource = document.createElement('canvas');
  litSource.width = width;
  litSource.height = height;
  litSource.getContext('2d')?.putImageData(sourceData, 0, 0);

  renderContext.putImageData(processImageData(sourceData, {
    palette: currentColors(), mode: state.mode, strength: state.strength,
    brightness: state.brightness, contrast: state.contrast, saturation: state.saturation,
    stripeAngle: state.stripeAngle, noiseScale: state.noiseScale, seed: state.seed,
  }), 0, 0);

  previewCanvas.width = width;
  previewCanvas.height = height;
  previewCanvas.getContext('2d')?.drawImage(renderedCanvas, 0, 0);
  originalCanvas.width = width;
  originalCanvas.height = height;
  originalCanvas.getContext('2d')?.drawImage(litSource, 0, 0);
  updatePreviewBadge(width, height);
  if (originalViewport && processedViewport) {
    originalViewport.applyImage(litSource);
    processedViewport.applyImage(renderedCanvas);
  }
}

function renderUVControl(): void {
  uvControl.hidden = modelUVChannels.length === 0;
  uvMapSelect.innerHTML = modelUVChannels.map((channel, index) => `<option value="${channel}" ${channel === state.uvMap ? 'selected' : ''}>UV ${index + 1} · ${channel}</option>`).join('');
}

function renderLodControl(): void {
  lodControl.hidden = modelLodLevels.length <= 1;
  lodMapSelect.innerHTML = modelLodLevels.map((level) => `<option value="${level}" ${level === state.lodLevel ? 'selected' : ''}>LOD ${level}</option>`).join('');
}

function renderSunControl(): void {
  sunControl.hidden = !modelBundle;
}

function updatePatternControls(): void {
  stripeAngleControl.hidden = state.mode !== 'stripes';
  noiseScaleControl.hidden = state.mode !== 'noise';
}

function updateAOControls(): void {
  aoIntensityInput.value = String(Math.round(state.aoIntensity * 100));
  aoIntensityValue.textContent = `${Math.round(state.aoIntensity * 100)}%`;
  aoDistanceInput.value = String(state.aoDistance);
  aoDistanceValue.textContent = `${state.aoDistance.toFixed(2)}×`;
}

function renderTextureRibbon(): void {
  for (const channel of TEXTURE_CHANNELS) {
    const slotElement = document.querySelector<HTMLElement>(`[data-texture="${channel.id}"]`);
    if (!slotElement) continue;
    const data = textures[channel.id];
    const preview = slotElement.querySelector<HTMLElement>('.texture-slot-preview');
    const label = slotElement.querySelector<HTMLElement>('.texture-slot-label');
    slotElement.classList.toggle('filled', !!data.image);
    slotElement.classList.toggle('disabled', !modelBundle && channel.id !== 'base');
    if (preview) {
      if (data.image) {
        const canvas = document.createElement('canvas');
        canvas.width = 40;
        canvas.height = 34;
        canvas.getContext('2d')?.drawImage(data.image, 0, 0, 40, 34);
        preview.replaceChildren(canvas);
      } else {
        preview.innerHTML = '<span class="texture-slot-empty-mark">+</span>';
      }
    }
    if (label) label.textContent = data.image ? channel.label : `+${channel.label}`;
  }
  const modelSlot = document.querySelector<HTMLElement>('[data-model-slot]');
  if (modelSlot) {
    const label = modelSlot.querySelector<HTMLElement>('.texture-slot-label');
    modelSlot.classList.toggle('filled', !!modelBundle);
    if (label) label.textContent = modelBundle ? modelBundle.primary.name : '+Model';
  }
}

function applyModelUV(channel: string): void {
  state.uvMap = channel;
  const originalStatus = originalViewport?.applyUV(channel);
  processedViewport?.applyUV(channel);
  if (originalStatus) {
    const notes = [originalStatus.fallbackMeshes ? `${originalStatus.fallbackMeshes} fallback` : '', originalStatus.missingMeshes ? `${originalStatus.missingMeshes} without UVs` : ''].filter(Boolean);
    showToast(notes.length ? `UV ${channel} applied · ${notes.join(', ')}` : `UV ${channel} applied`);
  }
}

function applyModelLod(level: number): void {
  state.lodLevel = level;
  originalViewport?.applyLOD(level);
  processedViewport?.applyLOD(level);
}

function applySunDirection(): void {
  originalViewport?.setSunDirection(state.sunAzimuth, state.sunElevation);
  processedViewport?.setSunDirection(state.sunAzimuth, state.sunElevation);
}

function applyPreviewMode(): void {
  const threeD = modelBundle !== null && previewMode === '3d';
  originalModelHost.hidden = !threeD;
  processedModelHost.hidden = !threeD;
  originalCanvas.hidden = threeD;
  previewCanvas.hidden = threeD;
  previewModeToggle.hidden = modelBundle === null;
  previewModeToggle.querySelectorAll<HTMLButtonElement>('[data-preview-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.previewMode === previewMode);
  });
}

function closeModelPreview(): void {
  originalViewport?.dispose();
  processedViewport?.dispose();
  modelBundle?.revoke();
  originalViewport = null;
  processedViewport = null;
  modelBundle = null;
  modelUVChannels = [];
  modelLodLevels = [];
  disposeAOScene(aoBakeScene);
  aoBakeScene = null;
  previewMode = '2d';
  applyPreviewMode();
  renderUVControl();
  renderLodControl();
  renderSunControl();
}

async function setModel(files: File[]): Promise<void> {
  let bundle: ModelFileBundle | null = null;
  try {
    bundle = createModelFileBundle(files);
    const loaded = await loadModel(bundle, files);
    closeModelPreview();
    modelBundle = bundle;
    const lodPreparation = prepareModelLods(loaded.scene);
    modelLodLevels = lodPreparation.levels;
    state.lodLevel = modelLodLevels[0] ?? 0;
    modelUVChannels = geometryUVChannels(loaded.scene);
    state.uvMap = modelUVChannels[0] ?? 'uv';
    aoBakeScene = buildAOScene(loaded.scene);
    applyLodLevel(aoBakeScene, state.lodLevel);
    originalViewport = new ModelViewport(originalModelHost);
    processedViewport = new ModelViewport(processedModelHost);
    originalViewport.setModel(cloneModelScene(loaded.scene), loaded.animations);
    processedViewport.setModel(cloneModelScene(loaded.scene), loaded.animations);
    originalViewport.applyLOD(state.lodLevel);
    processedViewport.applyLOD(state.lodLevel);
    disposeModel(loaded.scene);
    previewMode = '3d';
    applyPreviewMode();
    renderUVControl();
    renderLodControl();
    renderSunControl();
    applySunDirection();
    if (modelUVChannels.length) applyModelUV(state.uvMap);
    renderTextureRibbon();
    render();
    document.querySelector('#fileName')!.textContent = modelBundle.primary.name;
    showToast(`Loaded ${modelBundle.primary.name}${lodPreparation.collidersRemoved ? ` · ${lodPreparation.collidersRemoved} colliders removed` : ''}`);
    bundle = null;
  } catch (error) {
    if (modelBundle === bundle) closeModelPreview();
    bundle?.revoke();
    showToast(error instanceof Error ? error.message : 'Could not load model.');
  }
}

function representativeColors(input: string[], limit = 16): string[] {
  if (input.length <= limit) return input;
  return Array.from({ length: limit }, (_, index) => input[Math.round(index * (input.length - 1) / (limit - 1))]);
}

function activePaletteIsCustom(): boolean {
  return state.customColors.length > 0 || savedCustomPalettes.some((palette) => palette.key === state.paletteKey);
}

function renderPalettes(): void {
  const catalog = paletteCatalog();
  document.querySelector('#paletteCount')!.textContent = `${Object.keys(catalog).length} PRESETS`;
  const visiblePalettes = Object.entries(catalog).filter(([, palette]) => state.paletteFilter === 'all' || palette.category === state.paletteFilter);
  const customKeys = new Set(savedCustomPalettes.map((palette) => palette.key));
  paletteGrid.innerHTML = visiblePalettes.map(([key, palette]) => `
    <div class="palette-card ${key === state.paletteKey && state.customColors.length === 0 ? 'active' : ''}" data-palette="${escapeHtml(key)}" role="button" tabindex="0" aria-label="${escapeHtml(palette.name)}, ${palette.colors.length} colors">
      <span class="mini-swatches">${representativeColors(palette.colors).map((color) => `<i style="--swatch:${color}"></i>`).join('')}</span>
      <span class="palette-card-label"><span>${escapeHtml(palette.name)}</span><b>${palette.colors.length}</b></span>
      <span class="palette-card-actions">
        <button type="button" class="palette-card-duplicate" data-duplicate-palette="${escapeHtml(key)}" aria-label="Duplicate ${escapeHtml(palette.name)}" title="Duplicate ${escapeHtml(palette.name)}"><svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><rect x="5" y="5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="2" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button>
        ${customKeys.has(key) ? `
          <button type="button" class="palette-card-export" data-export-palette="${escapeHtml(key)}" aria-label="Export ${escapeHtml(palette.name)}" title="Export ${escapeHtml(palette.name)}"><svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v7M4.5 6.5L7 9l2.5-2.5M2.5 11.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button type="button" class="palette-card-delete" data-delete-palette="${escapeHtml(key)}" aria-label="Delete ${escapeHtml(palette.name)}">×</button>` : ''}
      </span>
    </div>
  `).join('') + (state.paletteFilter === 'custom' ? `
    <button type="button" class="palette-card palette-card-new" data-new-palette aria-label="Create new palette">
      <span class="palette-card-new-icon">+</span>
      <span class="palette-card-new-label">Create new palette</span>
    </button>
    <button type="button" class="palette-card palette-card-new" data-import-palette aria-label="Import palette">
      <span class="palette-card-new-icon">↓</span>
      <span class="palette-card-new-label">Import palette</span>
    </button>
  ` : '');
  const palette = currentPalette();
  const selectedColors = currentColors();
  const credit = palette.attribution ? ` · ${palette.attribution}${palette.source ? ` / ${palette.source}` : ''}` : '';
  document.querySelector('#paletteName')!.textContent = state.customColors.length ? 'CUSTOM MIX' : palette.name.toUpperCase();
  document.querySelector('#paletteDescription')!.textContent = state.customColors.length ? `${selectedColors.length} hand-picked colors` : `${palette.description} · ${palette.colors.length} colors${credit}`;
  activeSwatches.innerHTML = representativeColors(selectedColors, 24).map((color) => `<span style="--swatch:${color}" title="${color}"></span>`).join('');
  customColors.innerHTML = selectedColors.map((color, index) => `
    <div class="custom-color">
      <label title="Edit ${color}"><input type="color" value="${color}" data-color-index="${index}" aria-label="Color ${index + 1}, ${color}" /><span style="--swatch:${color}"></span></label>
      <button type="button" data-remove-color="${index}" aria-label="Remove color ${index + 1}">×</button>
    </div>
  `).join('') + `
    <button type="button" class="custom-color-add" data-add-color aria-label="Add color">+</button>
  `;
  paletteEditor.disabled = !activePaletteIsCustom();
}

function renderAdjustments(): void {
  const controls: Array<[keyof Pick<State, 'brightness' | 'contrast' | 'saturation'>, string]> = [
    ['brightness', 'Brightness'], ['contrast', 'Contrast'], ['saturation', 'Saturation'],
  ];
  document.querySelector('#adjustmentControls')!.innerHTML = controls.map(([key, label]) => `
    <div class="adjustment-row">
      <label for="${key}"><span>${label}</span><output id="${key}Value">${state[key] > 0 ? '+' : ''}${state[key]}</output></label>
      <input class="range" id="${key}" type="range" min="-100" max="100" value="${state[key]}" />
    </div>
  `).join('');
}

function beginCustomDraft(name: string, description: string, colors: string[], key: string | null = null): void {
  editingCustomKey = key;
  customPaletteName.value = name;
  customPaletteDescription.value = description;
  state.customColors = [...colors];
  state.paletteSnapshot = {
    name: name || 'Untitled Custom Palette',
    description: description || 'Custom color palette',
    category: 'custom',
    colors: [...colors],
  };
  renderPalettes();
  render();
}

function ensureCustomDraft(): void {
  if (state.customColors.length > 0) return;
  const selectedCustom = savedCustomPalettes.find((palette) => palette.key === state.paletteKey);
  if (selectedCustom) beginCustomDraft(selectedCustom.name, selectedCustom.description, selectedCustom.colors, selectedCustom.key);
  else beginCustomDraft(`${currentPalette().name} Copy`, `Custom copy of ${currentPalette().name}`, currentPalette().colors);
}

function persistCustomDraft(): void {
  try {
    const existing = savedCustomPalettes.find((palette) => palette.key === editingCustomKey);
    const palette = existing
      ? updateCustomPalette(existing, customPaletteName.value, customPaletteDescription.value, currentColors())
      : createCustomPalette(customPaletteName.value, customPaletteDescription.value, currentColors(), new Date(), editingCustomKey ?? undefined);
    savedCustomPalettes = upsertCustomPalette(localStorage, palette);
    editingCustomKey = palette.key;
    state.paletteKey = palette.key;
    state.customColors = [];
    state.paletteSnapshot = undefined;
    customPaletteName.value = palette.name;
    customPaletteDescription.value = palette.description;
    renderPalettes();
    render();
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not save custom palette.');
  }
}

function createNewPalette(): void {
  beginCustomDraft('New Palette', 'Custom color palette', ['#000000', '#ffffff']);
  persistCustomDraft();
}

function duplicatePaletteByKey(key: string): void {
  const source = paletteCatalog()[key];
  if (!source) return;
  const duplicate = duplicatePalette(source);
  beginCustomDraft(duplicate.name, duplicate.description, duplicate.colors, duplicate.key);
  persistCustomDraft();
}

function exportPaletteByKey(key: string): void {
  try {
    const palette = savedCustomPalettes.find((entry) => entry.key === key);
    if (!palette) return;
    const safeName = palette.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || 'custom-palette';
    downloadText(serializeCustomPalette(palette), `${safeName}.palette.json`);
    showToast(`Custom palette “${palette.name}” exported`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not export custom palette.');
  }
}

function selectPalette(key: string): void {
  state.paletteKey = key;
  state.customColors = [];
  state.paletteSnapshot = undefined;
  const selectedCustom = savedCustomPalettes.find((palette) => palette.key === key);
  editingCustomKey = selectedCustom?.key ?? null;
  customPaletteName.value = selectedCustom?.name ?? currentPalette().name;
  customPaletteDescription.value = selectedCustom?.description ?? currentPalette().description;
  renderPalettes();
  render();
}

function removeCustomPalette(key: string): void {
  try {
    savedCustomPalettes = deleteCustomPalette(localStorage, key);
    if (editingCustomKey === key) editingCustomKey = null;
    if (state.paletteKey === key) {
      state.paletteKey = 'pico8';
      state.customColors = [];
      state.paletteSnapshot = undefined;
      customPaletteName.value = '';
      customPaletteDescription.value = '';
    }
    renderPalettes();
    render();
    showToast('Custom palette deleted');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not delete custom palette.');
  }
}

function activePaletteSnapshot() {
  const base = currentPalette();
  return {
    ...base,
    name: state.customColors.length ? `${base.name} Custom` : base.name,
    description: state.customColors.length ? `Custom colors based on ${base.name}` : base.description,
    colors: [...currentColors()],
  };
}

const CONFIG_FILE_NAME = 'ditherlab-settings.json';
const CONFIG_FILE_TYPE = { description: 'JSON settings', accept: { 'application/json': ['.json'] } };

function serializeConfig(): string {
  return serializePreset(createPreset('saved', '', currentConfig()));
}

async function applyConfigFile(file: File): Promise<void> {
  if (file.size > 1_000_000) throw new Error('Settings file is too large.');
  applyPreset(parsePreset(await file.text()));
  showToast('Settings loaded');
}

function currentConfig() {
  return {
    resolution: state.resolution,
    mode: state.mode,
    strength: state.strength,
    brightness: state.brightness,
    contrast: state.contrast,
    saturation: state.saturation,
    paletteKey: state.paletteKey,
    palette: activePaletteSnapshot(),
    uvMap: state.uvMap,
    stripeAngle: state.stripeAngle,
    noiseScale: state.noiseScale,
    seed: state.seed,
    aoIntensity: state.aoIntensity,
    aoDistance: state.aoDistance,
  };
}

async function saveConfig(): Promise<void> {
  const content = serializeConfig();
  try {
    if (typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({ suggestedName: CONFIG_FILE_NAME, types: [CONFIG_FILE_TYPE] });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
    } else {
      downloadText(content, CONFIG_FILE_NAME);
    }
    showToast('Settings saved');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    showToast(error instanceof Error ? error.message : 'Could not save settings.');
  }
}

async function loadConfig(): Promise<void> {
  try {
    if (typeof window.showOpenFilePicker === 'function') {
      const [handle] = await window.showOpenFilePicker({ types: [CONFIG_FILE_TYPE], multiple: false });
      await applyConfigFile(await handle.getFile());
    } else {
      loadConfigInput.click();
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    showToast(error instanceof Error ? error.message : 'Could not load settings.');
  }
}

function applyPreset(preset: ConversionPreset): void {
  renderScheduler.cancel();
  const catalogPalette = paletteCatalog()[preset.paletteKey];
  const matchesCatalog = catalogPalette && JSON.stringify(catalogPalette.colors) === JSON.stringify(preset.palette.colors);
  Object.assign(state, {
    resolution: preset.resolution,
    mode: preset.mode,
    strength: preset.strength,
    brightness: preset.brightness,
    contrast: preset.contrast,
    saturation: preset.saturation,
    paletteKey: preset.paletteKey,
    uvMap: preset.uvMap,
    stripeAngle: preset.stripeAngle,
    noiseScale: preset.noiseScale,
    seed: preset.seed,
    aoIntensity: preset.aoIntensity,
    aoDistance: preset.aoDistance,
    paletteSnapshot: matchesCatalog ? undefined : { ...preset.palette, colors: [...preset.palette.colors] },
    customColors: matchesCatalog ? [] : [...preset.palette.colors],
  });
  const selectedCustom = savedCustomPalettes.find((palette) => palette.key === preset.paletteKey);
  editingCustomKey = selectedCustom?.key ?? null;
  customPaletteName.value = selectedCustom?.name ?? preset.palette.name;
  customPaletteDescription.value = selectedCustom?.description ?? preset.palette.description;
  (document.querySelector('#strength') as HTMLInputElement).value = String(Math.round(preset.strength * 100));
  document.querySelector('#strengthValue')!.textContent = `${Math.round(preset.strength * 100)}%`;
  stripeAngleInput.value = String(preset.stripeAngle);
  stripeAngleValue.textContent = `${preset.stripeAngle}°`;
  noiseScaleInput.value = String(preset.noiseScale);
  noiseScaleValue.textContent = `${preset.noiseScale} px`;
  seedInput.value = String(preset.seed);
  seedValue.textContent = String(preset.seed);
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', (button as HTMLElement).dataset.mode === preset.mode));
  updatePatternControls();
  updateAOControls();
  renderAdjustments();
  bindAdjustmentEvents();
  renderPalettes();
  updateResolution(preset.resolution, true);
  if (modelUVChannels.includes(preset.uvMap)) {
    uvMapSelect.value = preset.uvMap;
    applyModelUV(preset.uvMap);
  }
}

const renderScheduler = createRenderScheduler(render);

function updateResolution(value: number, immediate = false): void {
  state.resolution = value;
  (document.querySelector('#resolution') as HTMLInputElement).value = String(value);
  document.querySelector('#resolutionValue')!.textContent = `${value} px`;
  document.querySelectorAll<HTMLButtonElement>('[data-resolution]').forEach((button) => button.classList.toggle('active', Number(button.dataset.resolution) === value));
  if (immediate) renderScheduler.flush();
  else renderScheduler.request();
}

function textureLabel(channel: TextureChannelId): string {
  return TEXTURE_CHANNELS.find((entry) => entry.id === channel)?.label ?? 'Texture';
}

function clearTexture(channel: TextureChannelId): void {
  if (channel === 'base') {
    textures.base.image = sample;
    textures.base.name = 'sample-landscape.png';
    document.querySelector('#fileName')!.textContent = textures.base.name;
    document.querySelector('#footerFileName')!.textContent = textures.base.name;
    document.querySelector('#sourceDimensions')!.textContent = `${sample.width} × ${sample.height} source`;
  } else {
    textures[channel].image = null;
    textures[channel].name = '';
  }
  renderTextureRibbon();
  render();
}

function clearModel(): void {
  renderScheduler.cancel();
  closeModelPreview();
  const base = textures.base.image;
  document.querySelector('#fileName')!.textContent = textures.base.name;
  document.querySelector('#footerFileName')!.textContent = textures.base.name;
  document.querySelector('#sourceDimensions')!.textContent = `${base?.width ?? 640} × ${base?.height ?? 461} source`;
  renderTextureRibbon();
  render();
  showToast('Model cleared');
}

async function setTexture(channel: TextureChannelId, file: File): Promise<void> {
  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file.');
    return;
  }
  try {
    const image = await loadImageFile(file);
    renderScheduler.cancel();
    textures[channel].image = image;
    textures[channel].name = file.name;
    if (channel === 'base') {
      if (!modelBundle) document.querySelector('#fileName')!.textContent = file.name;
      document.querySelector('#footerFileName')!.textContent = file.name;
      document.querySelector('#sourceDimensions')!.textContent = `${image.width} × ${image.height} source`;
    }
    renderTextureRibbon();
    render();
    showToast(`${textureLabel(channel)} loaded`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not load image.');
  }
}

function reset(): void {
  renderScheduler.cancel();
  Object.assign(state, { paletteKey: 'pico8', customColors: [], paletteSnapshot: undefined, resolution: 128, mode: 'floyd', strength: 0.85, brightness: 0, contrast: 8, saturation: 5, stripeAngle: 45, noiseScale: 1, seed: 1, aoIntensity: 1, aoDistance: 2 });
  editingCustomKey = null;
  customPaletteName.value = '';
  customPaletteDescription.value = '';
  (document.querySelector('#strength') as HTMLInputElement).value = '85';
  document.querySelector('#strengthValue')!.textContent = '85%';
  stripeAngleInput.value = '45';
  stripeAngleValue.textContent = '45°';
  noiseScaleInput.value = '1';
  noiseScaleValue.textContent = '1 px';
  seedInput.value = '1';
  seedValue.textContent = '1';
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', (button as HTMLElement).dataset.mode === 'floyd'));
  updatePatternControls();
  updateAOControls();
  renderAdjustments();
  bindAdjustmentEvents();
  renderPalettes();
  updateResolution(128, true);
  showToast('Settings reset');
}

function bindAdjustmentEvents(): void {
  (['brightness', 'contrast', 'saturation'] as const).forEach((key) => {
    document.querySelector<HTMLInputElement>(`#${key}`)?.addEventListener('input', (event) => {
      state[key] = Number((event.target as HTMLInputElement).value);
      document.querySelector(`#${key}Value`)!.textContent = `${state[key] > 0 ? '+' : ''}${state[key]}`;
      renderScheduler.request();
    });
    document.querySelector<HTMLInputElement>(`#${key}`)?.addEventListener('change', renderScheduler.flush);
  });
}

renderPalettes();
renderAdjustments();
bindAdjustmentEvents();
updatePatternControls();
updateAOControls();
renderTextureRibbon();
applyPreviewMode();
render();

document.querySelector('#resolution')!.addEventListener('input', (event) => updateResolution(Number((event.target as HTMLInputElement).value)));
document.querySelector('#resolution')!.addEventListener('change', renderScheduler.flush);
document.querySelectorAll<HTMLButtonElement>('[data-resolution]').forEach((button) => button.addEventListener('click', () => updateResolution(Number(button.dataset.resolution), true)));
document.querySelector('#strength')!.addEventListener('input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  state.strength = value / 100;
  document.querySelector('#strengthValue')!.textContent = `${value}%`;
  renderScheduler.request();
});
document.querySelector('#strength')!.addEventListener('change', renderScheduler.flush);
stripeAngleInput.addEventListener('input', (event) => {
  state.stripeAngle = Number((event.target as HTMLInputElement).value);
  stripeAngleValue.textContent = `${state.stripeAngle}°`;
  renderScheduler.request();
});
stripeAngleInput.addEventListener('change', renderScheduler.flush);
noiseScaleInput.addEventListener('input', (event) => {
  state.noiseScale = Number((event.target as HTMLInputElement).value);
  noiseScaleValue.textContent = `${state.noiseScale} px`;
  renderScheduler.request();
});
noiseScaleInput.addEventListener('change', renderScheduler.flush);
seedInput.addEventListener('input', (event) => {
  state.seed = Number((event.target as HTMLInputElement).value);
  seedValue.textContent = String(state.seed);
  renderScheduler.request();
});
seedInput.addEventListener('change', renderScheduler.flush);
aoIntensityInput.addEventListener('input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  state.aoIntensity = value / 100;
  aoIntensityValue.textContent = `${value}%`;
  renderScheduler.request();
});
aoIntensityInput.addEventListener('change', renderScheduler.flush);
aoDistanceInput.addEventListener('input', (event) => {
  state.aoDistance = Number((event.target as HTMLInputElement).value);
  aoDistanceValue.textContent = `${state.aoDistance.toFixed(2)}×`;
});
aoDistanceInput.addEventListener('change', renderScheduler.flush);
generateAoButton.addEventListener('click', generateAo);
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  state.mode = button.dataset.mode as DitherMode;
  document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
  updatePatternControls();
  render();
}));
paletteFilters.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (!button?.dataset.filter) return;
  state.paletteFilter = button.dataset.filter as PaletteCategory | 'all';
  paletteFilters.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
  renderPalettes();
});
paletteGrid.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest<HTMLButtonElement>('[data-import-palette]')) {
    importCustomPaletteInput.click();
    return;
  }
  if (target.closest<HTMLButtonElement>('[data-new-palette]')) {
    createNewPalette();
    return;
  }
  const duplicateButton = target.closest<HTMLButtonElement>('[data-duplicate-palette]');
  if (duplicateButton?.dataset.duplicatePalette) {
    duplicatePaletteByKey(duplicateButton.dataset.duplicatePalette);
    return;
  }
  const exportButton = target.closest<HTMLButtonElement>('[data-export-palette]');
  if (exportButton?.dataset.exportPalette) {
    exportPaletteByKey(exportButton.dataset.exportPalette);
    return;
  }
  const deleteButton = target.closest<HTMLButtonElement>('[data-delete-palette]');
  if (deleteButton?.dataset.deletePalette) {
    removeCustomPalette(deleteButton.dataset.deletePalette);
    return;
  }
  const card = target.closest<HTMLElement>('[data-palette]');
  if (card?.dataset.palette) selectPalette(card.dataset.palette);
});
paletteGrid.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target as HTMLElement;
  const card = target.closest<HTMLElement>('[data-palette]');
  if (!card?.dataset.palette || target.closest('button')) return;
  event.preventDefault();
  selectPalette(card.dataset.palette);
});
customColors.addEventListener('input', (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[type="color"]');
  if (!input) return;
  ensureCustomDraft();
  state.customColors[Number(input.dataset.colorIndex)] = input.value;
  input.nextElementSibling?.setAttribute('style', `--swatch:${input.value}`);
  input.setAttribute('aria-label', `Color ${Number(input.dataset.colorIndex) + 1}, ${input.value}`);
  state.paletteSnapshot = activePaletteSnapshot();
  render();
});
customColors.addEventListener('change', (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[type="color"]');
  if (input) persistCustomDraft();
});
customColors.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest<HTMLButtonElement>('[data-add-color]')) {
    ensureCustomDraft();
    if (state.customColors.length >= 256) return showToast('Palette limit reached');
    state.customColors.push('#ffffff');
    state.paletteSnapshot = activePaletteSnapshot();
    persistCustomDraft();
    return;
  }
  const button = target.closest<HTMLButtonElement>('[data-remove-color]');
  if (!button) return;
  ensureCustomDraft();
  if (state.customColors.length <= 2) return showToast('A palette needs at least two colors.');
  state.customColors.splice(Number(button.dataset.removeColor), 1);
  state.paletteSnapshot = activePaletteSnapshot();
  persistCustomDraft();
});
customPaletteName.addEventListener('change', persistCustomDraft);
customPaletteDescription.addEventListener('change', persistCustomDraft);

const importCustomPaletteInput = document.querySelector<HTMLInputElement>('#importCustomPalette')!;
importCustomPaletteInput.addEventListener('change', async () => {
  const file = importCustomPaletteInput.files?.[0];
  if (!file) return;
  try {
    if (file.size > 100_000) throw new Error('Palette file is too large.');
    const palette = parseCustomPalette(await file.text());
    savedCustomPalettes = upsertCustomPalette(localStorage, palette);
    state.paletteKey = palette.key;
    beginCustomDraft(palette.name, palette.description, palette.colors, palette.key);
    showToast(`Imported custom palette “${palette.name}”`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not import custom palette.');
  } finally {
    importCustomPaletteInput.value = '';
  }
});

textureRibbon.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-clear-model]')) {
    clearModel();
    return;
  }
  const clearButton = target.closest<HTMLButtonElement>('[data-clear-texture]');
  if (clearButton?.dataset.clearTexture) {
    clearTexture(clearButton.dataset.clearTexture as TextureChannelId);
    return;
  }
  if (target.closest('[data-model-slot]')) {
    modelInput.click();
    return;
  }
  const slot = target.closest<HTMLElement>('[data-texture]');
  if (!slot?.dataset.texture) return;
  if (slot.classList.contains('disabled')) {
    showToast('Load a model to enable AO and Normal maps.');
    return;
  }
  pendingTextureChannel = slot.dataset.texture as TextureChannelId;
  textureInput.click();
});
textureRibbon.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target as HTMLElement;
  if (target.closest('[data-model-slot]')) {
    event.preventDefault();
    modelInput.click();
    return;
  }
  const slot = target.closest<HTMLElement>('[data-texture]');
  if (!slot?.dataset.texture || target.closest('button')) return;
  event.preventDefault();
  if (slot.classList.contains('disabled')) {
    showToast('Load a model to enable AO and Normal maps.');
    return;
  }
  pendingTextureChannel = slot.dataset.texture as TextureChannelId;
  textureInput.click();
});
textureInput.addEventListener('change', () => {
  const file = textureInput.files?.[0];
  textureInput.value = '';
  const channel = pendingTextureChannel;
  pendingTextureChannel = null;
  if (file && channel) void setTexture(channel, file);
});
function bindSlotDragState(slot: HTMLElement): void {
  ['dragenter', 'dragover'].forEach((type) => slot.addEventListener(type, (event) => { event.preventDefault(); slot.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((type) => slot.addEventListener(type, (event) => { event.preventDefault(); slot.classList.remove('dragging'); }));
}

TEXTURE_CHANNELS.forEach((channel) => {
  const slot = document.querySelector<HTMLElement>(`[data-texture="${channel.id}"]`);
  if (!slot) return;
  bindSlotDragState(slot);
  slot.addEventListener('drop', (event) => {
    if (slot.classList.contains('disabled')) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    const image = files.find((file) => file.type.startsWith('image/'));
    if (image) void setTexture(channel.id, image);
  });
});
const modelSlot = document.querySelector<HTMLElement>('[data-model-slot]');
if (modelSlot) {
  bindSlotDragState(modelSlot);
  modelSlot.addEventListener('drop', (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.some((file) => modelFormat(file.name))) void setModel(files);
  });
}
const modelInput = document.querySelector<HTMLInputElement>('#modelInput')!;
modelInput.addEventListener('change', () => {
  const files = Array.from(modelInput.files ?? []);
  if (files.length) void setModel(files);
  modelInput.value = '';
});
previewModeToggle.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-preview-mode]');
  if (!button?.dataset.previewMode) return;
  previewMode = button.dataset.previewMode as '2d' | '3d';
  applyPreviewMode();
});
uvMapSelect.addEventListener('change', () => applyModelUV(uvMapSelect.value));
lodMapSelect.addEventListener('change', () => applyModelLod(Number(lodMapSelect.value)));
sunAzimuthInput.addEventListener('input', () => {
  state.sunAzimuth = Number(sunAzimuthInput.value);
  applySunDirection();
});
sunElevationInput.addEventListener('input', () => {
  state.sunElevation = Number(sunElevationInput.value);
  applySunDirection();
});
const dropZone = document.querySelector<HTMLDivElement>('#dropZone')!;
['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.some((file) => modelFormat(file.name))) void setModel(files);
  else if (files[0]) void setTexture('base', files[0]);
});
loadConfigInput.addEventListener('change', async () => {
  const file = loadConfigInput.files?.[0];
  loadConfigInput.value = '';
  if (!file) return;
  try {
    await applyConfigFile(file);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not load settings.');
  }
});
document.querySelector('#saveButton')!.addEventListener('click', saveConfig);
document.querySelector('#loadButton')!.addEventListener('click', loadConfig);
document.querySelector('#resetButton')!.addEventListener('click', reset);
document.querySelector('#exportButton')!.addEventListener('click', () => {
  const safeName = textures.base.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-');
  downloadCanvas(renderedCanvas, `${safeName}-dithered.png`);
  showToast(`Exported ${renderedCanvas.width} × ${renderedCanvas.height} PNG`);
});
