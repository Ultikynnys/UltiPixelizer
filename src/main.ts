import './style.css';
import { createSampleTexture, downloadCanvas, loadImageFile } from './lib/canvas';
import { processImageData, type DitherMode } from './lib/dither';
import { palettes, type PaletteCategory } from './lib/palettes';

type SourceImage = CanvasImageSource & { width: number; height: number };

type State = {
  source: SourceImage;
  sourceName: string;
  paletteKey: string;
  customColors: string[];
  resolution: number;
  mode: DitherMode;
  strength: number;
  brightness: number;
  contrast: number;
  saturation: number;
  compare: boolean;
  paletteFilter: PaletteCategory | 'all';
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
  compare: false,
  paletteFilter: 'all',
};

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="DitherLab home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span>DITHER<span>LAB</span></span>
        <span class="build-version" title="Build version and commit">${buildLabel}</span>
      </a>
      <button class="button button-quiet" id="resetButton" type="button">Reset settings</button>
    </header>

    <main class="workspace">
      <section class="preview-column" aria-label="Texture preview">
        <div class="preview-toolbar">
          <div>
            <p class="eyebrow">TEXTURE PREVIEW</p>
            <h1 id="fileName">${state.sourceName}</h1>
          </div>
          <div class="toolbar-actions">
            <button class="icon-button" id="compareButton" type="button" aria-pressed="false" title="Hold to compare original">◐</button>
            <span class="dimension-badge" id="dimensionBadge">128 × 92 PX</span>
          </div>
        </div>

        <div class="canvas-stage" id="dropZone">
          <div class="canvas-wrap">
            <canvas id="previewCanvas" aria-label="Dithered texture preview"></canvas>
            <div class="original-overlay" id="originalOverlay"><canvas id="originalCanvas"></canvas><span>ORIGINAL</span></div>
          </div>
          <div class="drop-hint" id="dropHint">Drop an image anywhere</div>
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
          <button class="button button-primary" id="exportButton" type="button">Export PNG <span>↓</span></button>
        </footer>
      </section>

      <aside class="control-column">
        <section class="panel intro-panel">
          <p class="eyebrow">PIXEL ENGINE / 01</p>
          <h2>Break the smooth.</h2>
          <p>Reduce, remap, and scatter your texture into deliberate pixels.</p>
        </section>

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
          <div class="panel-heading compact"><div><p class="eyebrow">COLOR SYSTEM / 02</p><h2>Palette library</h2></div><span class="catalog-count">${Object.keys(palettes).length} PRESETS</span></div>
          <div class="palette-filters" id="paletteFilters" role="group" aria-label="Filter palette library">
            <button class="active" type="button" data-filter="all">All</button>
            <button type="button" data-filter="compact">Compact</button>
            <button type="button" data-filter="pixel-art">Pixel art</button>
            <button type="button" data-filter="hardware">Hardware</button>
            <button type="button" data-filter="themed">Themed</button>
            <button type="button" data-filter="extended">Extended</button>
          </div>
          <div class="palette-grid" id="paletteGrid"></div>
          <div class="palette-detail">
            <div><strong id="paletteName">PICO-8</strong><small id="paletteDescription">Punchy fantasy console</small></div>
            <div class="swatch-strip" id="activeSwatches"></div>
          </div>
          <details class="custom-palette">
            <summary>Customize palette <span>+</span></summary>
            <div id="customColors" class="custom-colors"></div>
            <button id="addColor" class="text-button" type="button">+ Add color</button>
          </details>
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><p class="eyebrow">DITHER MATRIX / 03</p><h2>Pattern</h2></div></div>
          <div class="mode-grid" role="group" aria-label="Dithering algorithm">
            <button class="mode-button active" data-mode="floyd" type="button"><span class="pattern pattern-noise"></span><strong>Floyd–Steinberg</strong><small>Organic grain</small></button>
            <button class="mode-button" data-mode="atkinson" type="button"><span class="pattern pattern-atkinson"></span><strong>Atkinson</strong><small>Crisp contrast</small></button>
            <button class="mode-button" data-mode="ordered" type="button"><span class="pattern pattern-grid"></span><strong>Ordered 4×4</strong><small>Regular matrix</small></button>
            <button class="mode-button" data-mode="none" type="button"><span class="pattern pattern-none"></span><strong>Hard map</strong><small>No diffusion</small></button>
          </div>
          <label class="control-row"><span><strong>Dither strength</strong><small>Error diffusion amount</small></span><output id="strengthValue">85%</output></label>
          <input class="range" id="strength" type="range" min="0" max="100" value="85" aria-label="Dither strength" />
        </section>

        <section class="panel adjustments">
          <div class="panel-heading compact"><div><p class="eyebrow">TONE CONTROL / 04</p><h2>Adjustments</h2></div></div>
          <div id="adjustmentControls"></div>
        </section>

        <div class="privacy-note"><span>◆</span><p><strong>Your image stays yours.</strong><br />Everything is processed inside this browser.</p></div>
      </aside>
    </main>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </div>
`;

const previewCanvas = document.querySelector<HTMLCanvasElement>('#previewCanvas')!;
const originalCanvas = document.querySelector<HTMLCanvasElement>('#originalCanvas')!;
const originalOverlay = document.querySelector<HTMLDivElement>('#originalOverlay')!;
const paletteGrid = document.querySelector<HTMLDivElement>('#paletteGrid')!;
const paletteFilters = document.querySelector<HTMLDivElement>('#paletteFilters')!;
const activeSwatches = document.querySelector<HTMLDivElement>('#activeSwatches')!;
const customColors = document.querySelector<HTMLDivElement>('#customColors')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
let toastTimer = 0;
let renderedCanvas = document.createElement('canvas');

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2400);
}

function currentColors(): string[] {
  return state.customColors.length > 0 ? state.customColors : palettes[state.paletteKey].colors;
}

function dimensions(): { width: number; height: number } {
  const width = Math.min(state.resolution, state.source.width);
  return { width, height: Math.max(1, Math.round(width * state.source.height / state.source.width)) };
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
  }), 0, 0);

  previewCanvas.width = width;
  previewCanvas.height = height;
  previewCanvas.getContext('2d')?.drawImage(renderedCanvas, 0, 0);
  originalCanvas.width = width;
  originalCanvas.height = height;
  originalCanvas.getContext('2d')?.drawImage(state.source, 0, 0, width, height);
  document.querySelector('#dimensionBadge')!.textContent = `${width} × ${height} PX`;
}

function representativeColors(input: string[], limit = 16): string[] {
  if (input.length <= limit) return input;
  return Array.from({ length: limit }, (_, index) => input[Math.round(index * (input.length - 1) / (limit - 1))]);
}

function renderPalettes(): void {
  const visiblePalettes = Object.entries(palettes).filter(([, palette]) => state.paletteFilter === 'all' || palette.category === state.paletteFilter);
  paletteGrid.innerHTML = visiblePalettes.map(([key, palette]) => `
    <button type="button" class="palette-card ${key === state.paletteKey && state.customColors.length === 0 ? 'active' : ''}" data-palette="${key}" aria-label="${palette.name}, ${palette.colors.length} colors">
      <span class="mini-swatches">${representativeColors(palette.colors).map((color) => `<i style="--swatch:${color}"></i>`).join('')}</span>
      <span class="palette-card-label"><span>${palette.name}</span><b>${palette.colors.length}</b></span>
    </button>
  `).join('');
  const palette = palettes[state.paletteKey];
  const selectedColors = currentColors();
  const credit = palette.attribution ? ` · ${palette.attribution}${palette.source ? ` / ${palette.source}` : ''}` : '';
  document.querySelector('#paletteName')!.textContent = state.customColors.length ? 'CUSTOM MIX' : palette.name.toUpperCase();
  document.querySelector('#paletteDescription')!.textContent = state.customColors.length ? `${selectedColors.length} hand-picked colors` : `${palette.description} · ${palette.colors.length} colors${credit}`;
  activeSwatches.innerHTML = representativeColors(selectedColors, 24).map((color) => `<span style="--swatch:${color}" title="${color}"></span>`).join('');
  customColors.innerHTML = selectedColors.map((color, index) => `<label title="Edit ${color}"><input type="color" value="${color}" data-color-index="${index}" /><span style="--swatch:${color}"></span></label>`).join('');
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

function updateResolution(value: number): void {
  state.resolution = value;
  (document.querySelector('#resolution') as HTMLInputElement).value = String(value);
  document.querySelector('#resolutionValue')!.textContent = `${value} px`;
  document.querySelectorAll<HTMLButtonElement>('[data-resolution]').forEach((button) => button.classList.toggle('active', Number(button.dataset.resolution) === value));
  render();
}

async function setSource(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file.');
    return;
  }
  try {
    const image = await loadImageFile(file);
    state.source = image;
    state.sourceName = file.name;
    document.querySelector('#fileName')!.textContent = file.name;
    document.querySelector('#footerFileName')!.textContent = file.name;
    document.querySelector('#sourceDimensions')!.textContent = `${image.width} × ${image.height} source`;
    render();
    showToast('Texture loaded');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not load image.');
  }
}

function reset(): void {
  Object.assign(state, { paletteKey: 'pico8', customColors: [], resolution: 128, mode: 'floyd', strength: 0.85, brightness: 0, contrast: 8, saturation: 5 });
  (document.querySelector('#strength') as HTMLInputElement).value = '85';
  document.querySelector('#strengthValue')!.textContent = '85%';
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', (button as HTMLElement).dataset.mode === 'floyd'));
  renderAdjustments();
  bindAdjustmentEvents();
  renderPalettes();
  updateResolution(128);
  showToast('Settings reset');
}

function bindAdjustmentEvents(): void {
  (['brightness', 'contrast', 'saturation'] as const).forEach((key) => {
    document.querySelector<HTMLInputElement>(`#${key}`)?.addEventListener('input', (event) => {
      state[key] = Number((event.target as HTMLInputElement).value);
      document.querySelector(`#${key}Value`)!.textContent = `${state[key] > 0 ? '+' : ''}${state[key]}`;
      render();
    });
  });
}

renderPalettes();
renderAdjustments();
bindAdjustmentEvents();
render();

document.querySelector('#resolution')!.addEventListener('input', (event) => updateResolution(Number((event.target as HTMLInputElement).value)));
document.querySelectorAll<HTMLButtonElement>('[data-resolution]').forEach((button) => button.addEventListener('click', () => updateResolution(Number(button.dataset.resolution))));
document.querySelector('#strength')!.addEventListener('input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  state.strength = value / 100;
  document.querySelector('#strengthValue')!.textContent = `${value}%`;
  render();
});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  state.mode = button.dataset.mode as DitherMode;
  document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
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
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-palette]');
  if (!button?.dataset.palette) return;
  state.paletteKey = button.dataset.palette;
  state.customColors = [];
  renderPalettes();
  render();
});
customColors.addEventListener('input', (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[type="color"]');
  if (!input) return;
  if (state.customColors.length === 0) state.customColors = [...palettes[state.paletteKey].colors];
  state.customColors[Number(input.dataset.colorIndex)] = input.value;
  renderPalettes();
  render();
});
document.querySelector('#addColor')!.addEventListener('click', () => {
  if (state.customColors.length === 0) state.customColors = [...palettes[state.paletteKey].colors];
  if (state.customColors.length >= 256) return showToast('Palette limit reached');
  state.customColors.push('#ffffff');
  renderPalettes();
  render();
});
const fileInput = document.querySelector<HTMLInputElement>('#fileInput')!;
fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void setSource(file); });
const dropZone = document.querySelector<HTMLDivElement>('#dropZone')!;
['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (event) => { const file = event.dataTransfer?.files[0]; if (file) void setSource(file); });
const compareButton = document.querySelector<HTMLButtonElement>('#compareButton')!;
const compare = (active: boolean) => { originalOverlay.classList.toggle('visible', active); compareButton.setAttribute('aria-pressed', String(active)); };
compareButton.addEventListener('pointerdown', () => compare(true));
compareButton.addEventListener('pointerup', () => compare(false));
compareButton.addEventListener('pointerleave', () => compare(false));
compareButton.addEventListener('click', () => { state.compare = !state.compare; compare(state.compare); });
document.querySelector('#resetButton')!.addEventListener('click', reset);
document.querySelector('#exportButton')!.addEventListener('click', () => {
  const safeName = state.sourceName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-');
  downloadCanvas(renderedCanvas, `${safeName}-dithered.png`);
  showToast(`Exported ${renderedCanvas.width} × ${renderedCanvas.height} PNG`);
});
