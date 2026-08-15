import './style.css';
import { createSampleTexture, downloadCanvas, downloadText, loadImageFile } from './lib/canvas';
import { createCustomPalette, deleteCustomPalette, duplicatePalette, loadCustomPalettes, parseCustomPalette, serializeCustomPalette, updateCustomPalette, upsertCustomPalette, type CustomPalette } from './lib/customPalettes';
import { processImageData, type DitherMode } from './lib/dither';
import { palettes, type Palette, type PaletteCategory } from './lib/palettes';
import { createRenderScheduler } from './lib/renderScheduler';
import { createModelFileBundle, modelFormat, type ModelFileBundle } from './lib/modelFiles';
import { cloneModelScene, disposeModel, geometryUVChannels } from './lib/modelScene';
import { prepareModelLods } from './lib/modelLod';
import { loadModel, ModelViewport } from './lib/modelPreview';
import { createPreset, parsePreset, serializePreset, type ConversionPreset } from './lib/presets';

type SourceImage = CanvasImageSource & { width: number; height: number };

type State = {
  source: SourceImage;
  sourceName: string;
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
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application root not found.');

const buildNumber = import.meta.env.VITE_BUILD_NUMBER || 'DEV';
const commitSha = import.meta.env.VITE_COMMIT_SHA || 'LOCAL';
const buildLabel = `v${buildNumber} · ${commitSha}`;

const sample = createSampleTexture();
const state: State = {
  source: sample,
  sourceName: 'sample-landscape.png',
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
};

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="UltiPixelizer home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span>ULTI<span>PIXELIZER</span></span>
        <span class="build-version" title="Build version and commit">${buildLabel}</span>
      </a>
      <div class="topbar-actions">
        <button class="button button-quiet" id="saveButton" type="button">Save</button>
        <button class="button button-quiet" id="loadButton" type="button">Load</button>
        <button class="button button-quiet" id="resetButton" type="button">Reset settings</button>
      </div>
    </header>

    <main class="workspace">
      <section class="preview-column" aria-label="Texture preview">
        <div class="preview-toolbar">
          <div>
            <p class="eyebrow">TEXTURE PREVIEW</p>
            <h1 id="fileName">${state.sourceName}</h1>
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
        </div>

        <footer class="preview-footer">
          <div class="file-meta">
            <span class="meta-icon">▧</span>
            <div><strong id="footerFileName">${state.sourceName}</strong><small id="sourceDimensions">640 × 461 source</small></div>
          </div>
          <label class="button button-secondary file-button">
            <input id="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
            Replace image
          </label>
          <label class="button button-secondary file-button">
            <input id="modelInput" type="file" multiple accept=".fbx,.obj,.mtl,.gltf,.glb,.bin,image/*" />
            Load model
          </label>
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
            <div class="palette-editor-fields">
              <label><span>Name</span><input id="customPaletteName" maxlength="60" placeholder="Palette name" /></label>
              <label><span>Description</span><input id="customPaletteDescription" maxlength="160" placeholder="Palette description" /></label>
            </div>
            <div id="customColors" class="custom-colors"></div>
            <div class="palette-editor-actions">
              <label class="button button-secondary file-button"><input id="importCustomPalette" type="file" accept="application/json,.json" />Import</label>
            </div>
          </details>
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
            <input class="range" id="stripeAngle" type="range" min="0" max="90" value="45" aria-label="Stripe angle" />
          </div>
          <div class="noise-scale-control" id="noiseScaleControl" hidden>
            <label class="control-row"><span><strong>Noise scale</strong><small>Grain size</small></span><output id="noiseScaleValue">1 px</output></label>
            <input class="range" id="noiseScale" type="range" min="1" max="32" value="1" aria-label="Noise scale" />
          </div>
        </section>

        <section class="panel adjustments">
          <div class="panel-heading compact"><div><p class="eyebrow">TONE CONTROL / 04</p><h2>Adjustments</h2></div></div>
          <div id="adjustmentControls"></div>
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
const toast = document.querySelector<HTMLDivElement>('#toast')!;
let savedCustomPalettes = loadCustomPalettes(localStorage);
let editingCustomKey: string | null = null;
let toastTimer = 0;
let renderedCanvas = document.createElement('canvas');
let modelBundle: ModelFileBundle | null = null;
let originalViewport: ModelViewport | null = null;
let processedViewport: ModelViewport | null = null;
let modelUVChannels: string[] = [];
let modelLodLevels: number[] = [];

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
  const width = Math.min(state.resolution, state.source.width);
  return { width, height: Math.max(1, Math.round(width * state.source.height / state.source.width)) };
}

function updatePreviewBadge(width?: number, height?: number): void {
  if (modelBundle) {
    const format = modelFormat(modelBundle.primary.name)?.toUpperCase();
    document.querySelector('#dimensionBadge')!.textContent = `${format} · ${modelUVChannels.length} UV MAP${modelUVChannels.length === 1 ? '' : 'S'}`;
  } else if (width && height) {
    document.querySelector('#dimensionBadge')!.textContent = `${width} × ${height} PX`;
  }
}

function render(): void {
  const { width, height } = dimensions();
  renderedCanvas = document.createElement('canvas');
  renderedCanvas.width = width;
  renderedCanvas.height = height;
  const renderContext = renderedCanvas.getContext('2d', { willReadFrequently: true });
  if (!renderContext) return;
  renderContext.drawImage(state.source, 0, 0, width, height);
  const sourceData = renderContext.getImageData(0, 0, width, height);
  renderContext.putImageData(processImageData(sourceData, {
    palette: currentColors(), mode: state.mode, strength: state.strength,
    brightness: state.brightness, contrast: state.contrast, saturation: state.saturation,
    stripeAngle: state.stripeAngle, noiseScale: state.noiseScale,
  }), 0, 0);

  previewCanvas.width = width;
  previewCanvas.height = height;
  previewCanvas.getContext('2d')?.drawImage(renderedCanvas, 0, 0);
  originalCanvas.width = width;
  originalCanvas.height = height;
  originalCanvas.getContext('2d')?.drawImage(state.source, 0, 0, width, height);
  updatePreviewBadge(width, height);
  if (originalViewport && processedViewport) {
    originalViewport.applyImage(state.source);
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

function closeModelPreview(): void {
  originalViewport?.dispose();
  processedViewport?.dispose();
  modelBundle?.revoke();
  originalViewport = null;
  processedViewport = null;
  modelBundle = null;
  modelUVChannels = [];
  modelLodLevels = [];
  originalModelHost.hidden = true;
  processedModelHost.hidden = true;
  originalCanvas.hidden = false;
  previewCanvas.hidden = false;
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
    originalViewport = new ModelViewport(originalModelHost);
    processedViewport = new ModelViewport(processedModelHost);
    originalViewport.setModel(cloneModelScene(loaded.scene), loaded.animations);
    processedViewport.setModel(cloneModelScene(loaded.scene), loaded.animations);
    originalViewport.applyLOD(state.lodLevel);
    processedViewport.applyLOD(state.lodLevel);
    disposeModel(loaded.scene);
    originalModelHost.hidden = false;
    processedModelHost.hidden = false;
    originalCanvas.hidden = true;
    previewCanvas.hidden = true;
    renderUVControl();
    renderLodControl();
    renderSunControl();
    applySunDirection();
    if (modelUVChannels.length) applyModelUV(state.uvMap);
    originalViewport.applyImage(state.source);
    processedViewport.applyImage(renderedCanvas);
    updatePreviewBadge();
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

const SAVED_CONFIG_KEY = 'ditherlab.saved-config';

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
  };
}

function saveConfig(): void {
  try {
    localStorage.setItem(SAVED_CONFIG_KEY, serializePreset(createPreset('saved', '', currentConfig())));
    showToast('Settings saved');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not save settings.');
  }
}

function loadConfig(): void {
  const raw = localStorage.getItem(SAVED_CONFIG_KEY);
  if (!raw) {
    showToast('No saved settings yet');
    return;
  }
  try {
    applyPreset(parsePreset(raw));
    showToast('Settings loaded');
  } catch (error) {
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
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', (button as HTMLElement).dataset.mode === preset.mode));
  updatePatternControls();
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

async function setSource(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file.');
    return;
  }
  try {
    const image = await loadImageFile(file);
    renderScheduler.cancel();
    state.source = image;
    state.sourceName = file.name;
    if (!modelBundle) document.querySelector('#fileName')!.textContent = file.name;
    document.querySelector('#footerFileName')!.textContent = file.name;
    document.querySelector('#sourceDimensions')!.textContent = `${image.width} × ${image.height} source`;
    render();
    showToast('Texture loaded');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not load image.');
  }
}

function reset(): void {
  renderScheduler.cancel();
  Object.assign(state, { paletteKey: 'pico8', customColors: [], paletteSnapshot: undefined, resolution: 128, mode: 'floyd', strength: 0.85, brightness: 0, contrast: 8, saturation: 5, stripeAngle: 45, noiseScale: 1 });
  editingCustomKey = null;
  customPaletteName.value = '';
  customPaletteDescription.value = '';
  (document.querySelector('#strength') as HTMLInputElement).value = '85';
  document.querySelector('#strengthValue')!.textContent = '85%';
  stripeAngleInput.value = '45';
  stripeAngleValue.textContent = '45°';
  noiseScaleInput.value = '1';
  noiseScaleValue.textContent = '1 px';
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', (button as HTMLElement).dataset.mode === 'floyd'));
  updatePatternControls();
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

const fileInput = document.querySelector<HTMLInputElement>('#fileInput')!;
fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void setSource(file); });
const modelInput = document.querySelector<HTMLInputElement>('#modelInput')!;
modelInput.addEventListener('change', () => {
  const files = Array.from(modelInput.files ?? []);
  if (files.length) void setModel(files);
  modelInput.value = '';
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
  else if (files[0]) void setSource(files[0]);
});
document.querySelector('#saveButton')!.addEventListener('click', saveConfig);
document.querySelector('#loadButton')!.addEventListener('click', loadConfig);
document.querySelector('#resetButton')!.addEventListener('click', reset);
document.querySelector('#exportButton')!.addEventListener('click', () => {
  const safeName = state.sourceName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-');
  downloadCanvas(renderedCanvas, `${safeName}-dithered.png`);
  showToast(`Exported ${renderedCanvas.width} × ${renderedCanvas.height} PNG`);
});
