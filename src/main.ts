import './style.css';
import { createSampleTexture, downloadCanvas, downloadText, loadImageFile } from './lib/canvas';
import { createCustomPalette, deleteCustomPalette, duplicatePalette, loadCustomPalettes, parseCustomPalette, selectOrCreatePalette, serializeCustomPalette, updateCustomPalette, upsertCustomPalette, type CustomPalette } from './lib/customPalettes';
import type { DitherMode } from './lib/dither';
import { palettes, type Palette, type PaletteCategory } from './lib/palettes';
import { createRenderScheduler } from './lib/renderScheduler';
import { createModelFileBundle, modelFormat, type ModelFileBundle, type WorldAxis } from './lib/modelFiles';
import { applyUVChannel, cloneModelScene, disposeModel, geometryUVChannels } from './lib/modelScene';
import { applyLodLevel, prepareModelLods } from './lib/modelLod';
import { loadModel, ModelViewport, upAxisRotation } from './lib/modelPreview';
import { createPreset, parsePreset, serializePreset, type ConversionPreset } from './lib/presets';
import { lightmapMatchesBaseColor } from './lib/lightmap';
import type { NormalFormat } from './lib/normal';
import { DEFAULT_AMBIENT_INTENSITY, DEFAULT_SMOOTH_ANGLE, DEFAULT_SUN_INTENSITY } from './lib/defaults';
import { createRenderer } from './lib/render';
import type { LightState, PreviewMode, State, TextureChannelId, TextureSlot } from './lib/state';
import { safeFileName } from './lib/strings';
import { DEFAULT_SUN_DIRECTION, type DirectionVector } from './lib/sunDirection';
import { Mesh, MeshBasicMaterial, type Object3D } from 'three';
import exampleModelUrl from '../Example/Book.fbx?url';
import exampleBaseColorUrl from '../Example/Book_BaseColor.png?url';
import exampleNormalUrl from '../Example/Book_NormalMap.png?url';

const TEXTURE_CHANNELS: ReadonlyArray<{ id: TextureChannelId; label: string }> = [
  { id: 'base', label: 'BaseColor' },
  { id: 'ao', label: 'AO' },
  { id: 'normal', label: 'Normal' },
  { id: 'lightmap', label: 'Lightmap' },
];

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
  lightmap: { image: null, name: '' },
};
const sunOverlayMarkup = (): string => `
  <div class="sun-overlay" id="sunControl" hidden>
    <div class="sun-overlay-heading">
      <span>Sun</span>
      <label class="sun-toggle" title="Toggle sun lighting"><input id="sunEnabled" type="checkbox" checked aria-label="Toggle sun lighting" /><span aria-hidden="true"></span></label>
    </div>
    <button class="orient-sun-button" id="orientSunWithCamera" type="button" title="Copy the Original 3D viewport angle to the sun">Orient Sun with Camera</button>
    <div class="orientation-readout" title="World-space direction (x, y, z)">
      <div class="orientation-row"><span class="orientation-label">Sun</span><output id="sunDirectionValue">—</output></div>
      <div class="orientation-row"><span class="orientation-label">Camera</span><output id="cameraDirectionValue">—</output></div>
    </div>
    <div class="light-controls">
      <label class="light-color-control"><span>Sun color</span>${colorControl('#ffffff', 'Sun color', 'id="sunColor"')}</label>
      ${rangeControl('sunIntensity', 'Sun intensity', 0, 1, 0.01, DEFAULT_SUN_INTENSITY)}
      <div class="light-section-title ambient-heading"><span>Ambient</span><label class="sun-toggle" title="Toggle ambient lighting"><input id="ambientEnabled" type="checkbox" checked aria-label="Toggle ambient lighting" /><span aria-hidden="true"></span></label></div>
      <label class="light-color-control"><span>Color</span>${colorControl('#ffffff', 'Ambient light color', 'id="ambientColor"')}</label>
      ${rangeControl('ambientIntensity', 'Intensity', 0, 1, 0.01, DEFAULT_AMBIENT_INTENSITY)}
    </div>
    <div class="lightmap-active-label" role="status">Lightmap Active</div>
  </div>
`;

function defaultState(): State {
  return {
    paletteKey: 'desert',
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
    sun: { direction: { ...DEFAULT_SUN_DIRECTION }, enabled: true, color: '#ffffff', intensity: DEFAULT_SUN_INTENSITY },
    ambient: { color: '#ffffff', intensity: DEFAULT_AMBIENT_INTENSITY, enabled: true },
    worldAxis: 'blender',
    useSourceNormals: false,
    smoothAngle: DEFAULT_SMOOTH_ANGLE,
    stripeAngle: 45,
    noiseScale: 1,
    seed: 1,
    aoBias: 0,
    aoScale: 1,
    aoDistance: 2,
    lightmapContribution: 1,
    normalStrength: 1,
    normalFormat: 'opengl',
    showUVOverlap: false,
    showUVWireframe: true,
    showNormals: false,
  };
}

const state: State = defaultState();

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
        <button class="button button-secondary" id="saveButton" type="button">Save</button>
        <button class="button button-secondary" id="loadButton" type="button">Load</button>
        <button class="button button-secondary" id="resetButton" type="button">Reset settings</button>
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
            <label class="uv-control" id="worldAxisControl" hidden><span>World axis</span><select id="worldAxis" aria-label="Model world axis">
              <option value="blender">Blender · Z-up</option>
              <option value="maya">Maya · Y-up</option>
            </select></label>
            <label class="uv-overlap-control" id="uvOverlapControl" hidden title="Highlight regions where UV shells overlap">
              <span>UV overlap</span>
              <span class="sun-toggle"><input id="uvOverlap" type="checkbox" aria-label="Show overlapping UVs" /><span aria-hidden="true"></span></span>
            </label>
            <label class="uv-overlap-control" id="uvWireframeControl" hidden title="Overlay UV island wireframes on the 2D view">
              <span>UV islands</span>
              <span class="sun-toggle"><input id="uvWireframe" type="checkbox" checked aria-label="Show UV island wireframes" /><span aria-hidden="true"></span></span>
            </label>
            <label class="uv-overlap-control" id="normalsControl" hidden title="Use the normals embedded in the model file instead of recomputing flat normals">
              <span>Source normals</span>
              <span class="sun-toggle"><input id="useSourceNormals" type="checkbox" aria-label="Use source normals" /><span aria-hidden="true"></span></span>
            </label>
            <label class="uv-overlap-control" id="normalsViewControl" hidden title="Render the model with normals as color to inspect normal direction">
              <span>Normals</span>
              <span class="sun-toggle"><input id="showNormals" type="checkbox" aria-label="Show normals as color" /><span aria-hidden="true"></span></span>
            </label>

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
              <figcaption><span>01</span> Original <span class="fig-dims" id="sourceDimensions">640 × 461</span></figcaption>
              <div class="canvas-frame">
                <canvas id="originalCanvas" aria-label="Original texture preview"></canvas>
                <div class="model-host" id="originalModelHost" hidden></div>
                ${sunOverlayMarkup()}
                <div class="preview-mode-toggle" id="originalPreviewToggle" hidden role="group" aria-label="Preview mode">
                  <button type="button" data-preview-mode="2d" class="active">2D</button>
                  <button type="button" data-preview-mode="3d">3D</button>
                </div>
              </div>
            </figure>
            <figure class="preview-pane processed-pane">
              <figcaption><span>02</span> Dithered <span class="fig-dims" id="processedDimensions">128 × 92 PX</span></figcaption>
              <div class="canvas-frame">
                <canvas id="previewCanvas" aria-label="Dithered texture preview"></canvas>
                <div class="model-host" id="processedModelHost" hidden></div>
                <div class="preview-mode-toggle" id="processedPreviewToggle" hidden role="group" aria-label="Preview mode">
                  <button type="button" data-preview-mode="2d" class="active">2D</button>
                  <button type="button" data-preview-mode="3d">3D</button>
                </div>
              </div>
            </figure>
          </div>
          <div class="drop-hint" id="dropHint">Drop an image or model bundle anywhere</div>
        </div>

        <footer class="preview-footer">
          <button class="button button-primary" id="exportButton" type="button">Export PNG <span>↓</span></button>
        </footer>
      </section>

      <aside class="control-column">
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
          <div class="panel-heading compact">
            <div><p class="eyebrow">RESOLUTION + TONE / 01</p><h2>Adjustments</h2></div>
            <output class="value-pill" id="resolutionValue">128 px</output>
          </div>
          <div class="resolution-block">
            <input class="range" id="resolution" type="range" min="24" max="512" step="8" value="128" aria-label="Pixelization width" />
            <div class="range-labels"><span>CHUNKY</span><span>FINE</span></div>
            <div class="resolution-presets" role="group" aria-label="Resolution presets">
              <button type="button" data-resolution="32">32</button>
              <button type="button" data-resolution="64">64</button>
              <button class="active" type="button" data-resolution="128">128</button>
              <button type="button" data-resolution="256">256</button>
            </div>
          </div>
          <div id="adjustmentControls"></div>
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><p class="eyebrow">LIGHTING / 04</p><h2>Ambient occlusion</h2></div></div>
          <label class="control-row"><span><strong>Bias</strong><small>Shift occlusion baseline</small></span><output id="aoBiasValue">+0.00</output></label>
          <input class="range" id="aoBias" type="range" min="-1" max="1" step="0.01" value="0" aria-label="Ambient occlusion bias" />
          <label class="control-row"><span><strong>Scale</strong><small>Occlusion strength</small></span><output id="aoScaleValue">1.00×</output></label>
          <input class="range" id="aoScale" type="range" min="0" max="2" step="0.01" value="1" aria-label="Ambient occlusion scale" />
          <label class="control-row"><span><strong>Distance</strong><small>Ray reach for generated AO</small></span><output id="aoDistanceValue">2.00×</output></label>
          <input class="range" id="aoDistance" type="range" min="0.05" max="3" step="0.05" value="2" aria-label="Ambient occlusion distance" />
          <button class="button button-secondary button-full" id="generateAoButton" type="button">Generate AO</button>
        </section>

        <section class="panel normals-panel">
          <div class="panel-heading compact"><div><p class="eyebrow">SURFACE NORMALS / 05</p><h2>Normals</h2></div></div>
          <p class="panel-description">Smooth mesh normals where the face angle is below the threshold, then perturb lighting with a normal map.</p>
          ${rangeControl('smoothAngle', 'Smooth angle', 0, 180, 1, DEFAULT_SMOOTH_ANGLE, `${DEFAULT_SMOOTH_ANGLE}°`)}
          ${rangeControl('normalStrength', 'Normal strength', 0, 100, 1, 100, '100%')}
          <label class="control-row"><span><strong>Format</strong><small>Green channel convention</small></span></label>
          <select class="normal-format-select" id="normalFormat" aria-label="Normal map format">
            <option value="opengl">OpenGL · +Y up</option>
            <option value="directx">DirectX · −Y up</option>
          </select>
          <div class="normal-status" id="normalStatus">No normal map loaded</div>
        </section>

        <section class="panel lightmap-panel">
          <div class="panel-heading compact"><div><p class="eyebrow">LIGHTMAP BAKE / 06</p><h2>Baked lighting</h2></div></div>
          <p class="panel-description">Bake the current sun and ambient lighting into UV space, or load a matching custom lightmap.</p>
          <label class="control-row"><span><strong>Contribution</strong><small>White to full lightmap</small></span><output id="lightmapContributionValue">100%</output></label>
          <input class="range" id="lightmapContribution" type="range" min="0" max="100" step="1" value="100" aria-label="Lightmap contribution" />
          <div class="lightmap-status" id="lightmapStatus">No lightmap loaded</div>
          <button class="button button-secondary button-full" id="bakeLightmapButton" type="button">Generate Lighting</button>
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
const worldAxisControl = document.querySelector<HTMLLabelElement>('#worldAxisControl')!;
const worldAxisSelect = document.querySelector<HTMLSelectElement>('#worldAxis')!;
const uvOverlapControl = document.querySelector<HTMLLabelElement>('#uvOverlapControl')!;
const uvOverlapInput = document.querySelector<HTMLInputElement>('#uvOverlap')!;
const uvWireframeControl = document.querySelector<HTMLLabelElement>('#uvWireframeControl')!;
const uvWireframeInput = document.querySelector<HTMLInputElement>('#uvWireframe')!;
const normalsControl = document.querySelector<HTMLLabelElement>('#normalsControl')!;
const useSourceNormalsInput = document.querySelector<HTMLInputElement>('#useSourceNormals')!;
const normalsViewControl = document.querySelector<HTMLLabelElement>('#normalsViewControl')!;
const showNormalsInput = document.querySelector<HTMLInputElement>('#showNormals')!;
type SunElements = {
  control: HTMLDivElement;
  enabled: HTMLInputElement;
  orientWithCamera: HTMLButtonElement;
  color: HTMLInputElement;
  intensity: HTMLInputElement;
  intensityValue: HTMLOutputElement;
  ambientEnabled: HTMLInputElement;
  ambientColor: HTMLInputElement;
  ambientIntensity: HTMLInputElement;
  ambientIntensityValue: HTMLOutputElement;
};

const sunControlElements: SunElements = {
  control: document.querySelector<HTMLDivElement>('#sunControl')!,
  enabled: document.querySelector<HTMLInputElement>('#sunEnabled')!,
  orientWithCamera: document.querySelector<HTMLButtonElement>('#orientSunWithCamera')!,
  color: document.querySelector<HTMLInputElement>('#sunColor')!,
  intensity: document.querySelector<HTMLInputElement>('#sunIntensity')!,
  intensityValue: document.querySelector<HTMLOutputElement>('#sunIntensityValue')!,
  ambientEnabled: document.querySelector<HTMLInputElement>('#ambientEnabled')!,
  ambientColor: document.querySelector<HTMLInputElement>('#ambientColor')!,
  ambientIntensity: document.querySelector<HTMLInputElement>('#ambientIntensity')!,
  ambientIntensityValue: document.querySelector<HTMLOutputElement>('#ambientIntensityValue')!,
};
const sunDirectionValue = document.querySelector<HTMLOutputElement>('#sunDirectionValue')!;
const cameraDirectionValue = document.querySelector<HTMLOutputElement>('#cameraDirectionValue')!;
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
const originalPreviewToggle = document.querySelector<HTMLDivElement>('#originalPreviewToggle')!;
const processedPreviewToggle = document.querySelector<HTMLDivElement>('#processedPreviewToggle')!;
const aoBiasInput = document.querySelector<HTMLInputElement>('#aoBias')!;
const aoBiasValue = document.querySelector<HTMLOutputElement>('#aoBiasValue')!;
const aoScaleInput = document.querySelector<HTMLInputElement>('#aoScale')!;
const aoScaleValue = document.querySelector<HTMLOutputElement>('#aoScaleValue')!;
const aoDistanceInput = document.querySelector<HTMLInputElement>('#aoDistance')!;
const aoDistanceValue = document.querySelector<HTMLOutputElement>('#aoDistanceValue')!;
const strengthInput = document.querySelector<HTMLInputElement>('#strength')!;
const strengthValue = document.querySelector<HTMLOutputElement>('#strengthValue')!;
const generateAoButton = document.querySelector<HTMLButtonElement>('#generateAoButton')!;
const lightmapContributionInput = document.querySelector<HTMLInputElement>('#lightmapContribution')!;
const lightmapContributionValue = document.querySelector<HTMLOutputElement>('#lightmapContributionValue')!;
const lightmapStatus = document.querySelector<HTMLDivElement>('#lightmapStatus')!;
const bakeLightmapButton = document.querySelector<HTMLButtonElement>('#bakeLightmapButton')!;
const normalStrengthInput = document.querySelector<HTMLInputElement>('#normalStrength')!;
const normalStrengthValue = document.querySelector<HTMLOutputElement>('#normalStrengthValue')!;
const normalFormatSelect = document.querySelector<HTMLSelectElement>('#normalFormat')!;
const normalStatus = document.querySelector<HTMLDivElement>('#normalStatus')!;
const smoothAngleInput = document.querySelector<HTMLInputElement>('#smoothAngle')!;
const smoothAngleValue = document.querySelector<HTMLOutputElement>('#smoothAngleValue')!;
let savedCustomPalettes = loadCustomPalettes(localStorage);
let editingCustomKey: string | null = null;
let toastTimer = 0;
let modelBundle: ModelFileBundle | null = null;
let modelFiles: File[] = [];
let originalPreviewMode: PreviewMode = '2d';
let processedPreviewMode: PreviewMode = '2d';
let originalViewport: ModelViewport | null = null;
let processedViewport: ModelViewport | null = null;

function forEachViewport(callback: (viewport: ModelViewport) => void): void {
  if (originalViewport) callback(originalViewport);
  if (processedViewport) callback(processedViewport);
}
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
  const badge = document.querySelector('#processedDimensions')!;
  if (modelBundle) {
    const format = modelFormat(modelBundle.primary.name)?.toUpperCase();
    badge.textContent = `${format} · ${modelUVChannels.length} UV MAP${modelUVChannels.length === 1 ? '' : 'S'}`;
  } else if (width && height) {
    badge.textContent = `${width} × ${height} PX`;
  }
}

const formatPercent = (value: number): string => `${value}%`;
const formatDegrees = (value: number): string => `${value}°`;
const formatPixels = (value: number): string => `${value} px`;
const formatPlain = (value: number): string => String(value);
const formatSignedFixed2 = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
const formatTimes2 = (value: number): string => `${value.toFixed(2)}×`;
const formatSignedInt = (value: number): string => `${value > 0 ? '+' : ''}${value}`;

function renderLightmapControls(): void {
  const active = textures.lightmap.image !== null;
  const contribution = Math.round(state.lightmapContribution * 100);
  lightmapContributionInput.value = String(contribution);
  lightmapContributionValue.textContent = formatPercent(contribution);
  lightmapStatus.textContent = active && textures.lightmap.image
    ? `${textures.lightmap.name} · ${textures.lightmap.image.width} × ${textures.lightmap.image.height}`
    : 'No lightmap loaded';
  bakeLightmapButton.disabled = aoBakeScene === null;
}

function renderNormalControls(): void {
  const strength = Math.round(state.normalStrength * 100);
  const lightmapActive = textures.lightmap.image !== null;
  normalStrengthInput.value = String(strength);
  normalStrengthInput.disabled = lightmapActive;
  normalStrengthValue.textContent = formatPercent(strength);
  normalFormatSelect.value = state.normalFormat;
  normalFormatSelect.disabled = lightmapActive;
  smoothAngleInput.value = String(state.smoothAngle);
  smoothAngleValue.textContent = formatDegrees(state.smoothAngle);
  smoothAngleInput.disabled = state.useSourceNormals;
  const image = textures.normal.image;
  normalStatus.textContent = image
    ? `${textures.normal.name} · ${image.width} × ${image.height}`
    : 'No normal map loaded';
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

function renderUVControl(): void {
  uvControl.hidden = modelUVChannels.length === 0;
  uvMapSelect.innerHTML = modelUVChannels.map((channel, index) => `<option value="${channel}" ${channel === state.uvMap ? 'selected' : ''}>UV ${index + 1} · ${channel}</option>`).join('');
}

function renderUVOverlapControl(): void {
  uvOverlapControl.hidden = modelUVChannels.length === 0;
  uvOverlapInput.checked = state.showUVOverlap;
}

function renderUVWireframeControl(): void {
  uvWireframeControl.hidden = modelUVChannels.length === 0;
  uvWireframeInput.checked = state.showUVWireframe;
}

function renderLodControl(): void {
  lodControl.hidden = modelLodLevels.length <= 1;
  lodMapSelect.innerHTML = modelLodLevels.map((level) => `<option value="${level}" ${level === state.lodLevel ? 'selected' : ''}>LOD ${level}</option>`).join('');
}

function renderWorldAxisControl(): void {
  const supportsAxis = modelBundle !== null && (modelBundle.format === 'fbx' || modelBundle.format === 'obj');
  worldAxisControl.hidden = !supportsAxis;
  worldAxisSelect.value = state.worldAxis;
}

function renderNormalsControl(): void {
  normalsControl.hidden = modelBundle === null;
  useSourceNormalsInput.checked = state.useSourceNormals;
}

function renderNormalsViewControl(): void {
  normalsViewControl.hidden = modelBundle === null;
  showNormalsInput.checked = state.showNormals;
}

function formatDirection(vector: DirectionVector): string {
  return `(${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)})`;
}

function renderOrientationReadout(): void {
  sunDirectionValue.textContent = formatDirection(state.sun.direction);
  cameraDirectionValue.textContent = originalViewport
    ? formatDirection(originalViewport.getCameraForward())
    : '—';
}

function renderSunControl(): void {
  sunControlElements.control.hidden = modelBundle === null || (originalPreviewMode !== '3d' && processedPreviewMode !== '3d');
  const lightmapActive = textures.lightmap.image !== null;
  sunControlElements.enabled.checked = state.sun.enabled;
  sunControlElements.enabled.disabled = lightmapActive;
  sunControlElements.control.classList.toggle('off', !state.sun.enabled || lightmapActive);
  sunControlElements.control.classList.toggle('lightmap-active', lightmapActive);
  sunControlElements.orientWithCamera.disabled = !state.sun.enabled || lightmapActive || originalPreviewMode !== '3d' || originalViewport === null;
  sunControlElements.color.disabled = !state.sun.enabled || lightmapActive;
  sunControlElements.intensity.disabled = !state.sun.enabled || lightmapActive;
  sunControlElements.ambientEnabled.checked = state.ambient.enabled;
  sunControlElements.ambientEnabled.disabled = lightmapActive;
  sunControlElements.ambientColor.disabled = !state.ambient.enabled || lightmapActive;
  sunControlElements.ambientIntensity.disabled = !state.ambient.enabled || lightmapActive;
  sunControlElements.color.value = state.sun.color;
  syncColorChip(sunControlElements.color);
  sunControlElements.intensity.value = String(state.sun.intensity);
  sunControlElements.intensityValue.textContent = state.sun.intensity.toFixed(2);
  sunControlElements.ambientColor.value = state.ambient.color;
  syncColorChip(sunControlElements.ambientColor);
  sunControlElements.ambientIntensity.value = String(state.ambient.intensity);
  sunControlElements.ambientIntensityValue.textContent = state.ambient.intensity.toFixed(2);
}

function updatePatternControls(): void {
  stripeAngleControl.hidden = state.mode !== 'stripes';
  noiseScaleControl.hidden = state.mode !== 'noise';
}

function updateAOControls(): void {
  aoBiasInput.value = String(Math.round(state.aoBias * 100) / 100);
  aoBiasValue.textContent = formatSignedFixed2(state.aoBias);
  aoScaleInput.value = String(Math.round(state.aoScale * 100) / 100);
  aoScaleValue.textContent = formatTimes2(state.aoScale);
  aoDistanceInput.value = String(state.aoDistance);
  aoDistanceValue.textContent = formatTimes2(state.aoDistance);
  renderLightmapControls();
}

function setActiveMode(mode: DitherMode): void {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
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
  if (channel !== state.uvMap && textures.lightmap.image) clearLightmap();
  state.uvMap = channel;
  if (aoBakeScene) applyUVChannel(aoBakeScene, channel);
  const originalStatus = originalViewport?.applyUV(channel);
  processedViewport?.applyUV(channel);
  refreshUVOverlap();
  if (originalStatus) {
    const notes = [originalStatus.fallbackMeshes ? `${originalStatus.fallbackMeshes} fallback` : '', originalStatus.missingMeshes ? `${originalStatus.missingMeshes} without UVs` : ''].filter(Boolean);
    showToast(notes.length ? `UV ${channel} applied · ${notes.join(', ')}` : `UV ${channel} applied`);
  }
}

function applyModelLod(level: number): void {
  if (level !== state.lodLevel && textures.lightmap.image) clearLightmap();
  state.lodLevel = level;
  forEachViewport((viewport) => viewport.applyLOD(level));
  if (aoBakeScene) applyLodLevel(aoBakeScene, level);
  refreshUVOverlap();
  if (state.showUVOverlap) render();
}

function applySun(): void {
  renderSunControl();
  renderOrientationReadout();
  const lightmapActive = textures.lightmap.image !== null;
  const ambientNeutral = lightmapActive || !state.ambient.enabled;
  forEachViewport((viewport) => {
    viewport.setSunDirection(state.sun.direction);
    viewport.setSunEnabled(state.sun.enabled && !lightmapActive);
    viewport.setSunColor(state.sun.color);
    viewport.setSunIntensity(state.sun.intensity);
    viewport.setAmbientColor(ambientNeutral ? '#ffffff' : state.ambient.color);
    viewport.setAmbientIntensity(ambientNeutral ? 1 : state.ambient.intensity);
  });
  scheduleImplicitLightmapBake();
}

function applyWorldAxis(): void {
  forEachViewport((viewport) => viewport.setWorldAxis(state.worldAxis));
  if (aoBakeScene) aoBakeScene.rotation.set(upAxisRotation(state.worldAxis), 0, 0);
  refreshUVOverlap();
}

function applyPreviewMode(): void {
  const applyPane = (mode: PreviewMode, canvas: HTMLCanvasElement, host: HTMLDivElement, toggle: HTMLDivElement): void => {
    const threeD = modelBundle !== null && mode === '3d';
    host.hidden = !threeD;
    canvas.hidden = threeD;
    toggle.hidden = modelBundle === null;
    toggle.querySelectorAll<HTMLButtonElement>('[data-preview-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.previewMode === mode);
    });
  };
  applyPane(originalPreviewMode, originalCanvas, originalModelHost, originalPreviewToggle);
  applyPane(processedPreviewMode, previewCanvas, processedModelHost, processedPreviewToggle);
  renderSunControl();
}

function closeModelPreview(): void {
  originalViewport?.dispose();
  processedViewport?.dispose();
  modelBundle?.revoke();
  originalViewport = null;
  processedViewport = null;
  modelBundle = null;
  modelFiles = [];
  modelUVChannels = [];
  modelLodLevels = [];
  disposeAOScene(aoBakeScene);
  aoBakeScene = null;
  resetPreview();
  textures.lightmap.image = null;
  textures.lightmap.name = '';
  renderLightmapControls();
  originalPreviewMode = '2d';
  processedPreviewMode = '2d';
  applyPreviewMode();
  renderUVControl();
  renderUVOverlapControl();
  renderUVWireframeControl();
  renderLodControl();
  renderSunControl();
  renderOrientationReadout();
  renderWorldAxisControl();
  renderNormalsControl();
  renderNormalsViewControl();
}

async function setModel(files: File[]): Promise<void> {
  let bundle: ModelFileBundle | null = null;
  try {
    bundle = createModelFileBundle(files);
    const loaded = await loadModel(bundle, files, state.worldAxis, { useSourceNormals: state.useSourceNormals, smoothAngle: state.smoothAngle });
    closeModelPreview();
    modelBundle = bundle;
    modelFiles = files;
    const lodPreparation = prepareModelLods(loaded.scene);
    modelLodLevels = lodPreparation.levels;
    state.lodLevel = modelLodLevels[0] ?? 0;
    modelUVChannels = geometryUVChannels(loaded.scene);
    state.uvMap = modelUVChannels[0] ?? 'uv';
    aoBakeScene = buildAOScene(loaded.scene);
    applyLodLevel(aoBakeScene, state.lodLevel);
    refreshUVWireframe();
    renderLightmapControls();
    originalViewport = new ModelViewport(originalModelHost);
    processedViewport = new ModelViewport(processedModelHost);
    originalViewport.onCameraChange = renderOrientationReadout;
    originalViewport.setModel(cloneModelScene(loaded.scene), loaded.animations);
    processedViewport.setModel(cloneModelScene(loaded.scene), loaded.animations);
    originalViewport.applyLOD(state.lodLevel);
    processedViewport.applyLOD(state.lodLevel);
    originalViewport.setNormalsView(state.showNormals);
    processedViewport.setNormalsView(state.showNormals);
    disposeModel(loaded.scene);
    originalPreviewMode = '3d';
    processedPreviewMode = '3d';
    applyPreviewMode();
    renderUVControl();
    renderUVOverlapControl();
    renderUVWireframeControl();
    renderLodControl();
    renderSunControl();
    renderWorldAxisControl();
    renderNormalsControl();
    renderNormalsViewControl();
    applySun();
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
          <button type="button" class="palette-card-export" data-export-palette="${escapeHtml(key)}" aria-label="Export ${escapeHtml(palette.name)}" title="Export ${escapeHtml(palette.name)}"><svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 12v-7M4.5 7.5L7 5l2.5 2.5M2.5 11.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button type="button" class="palette-card-delete" data-delete-palette="${escapeHtml(key)}" aria-label="Delete ${escapeHtml(palette.name)}">×</button>` : ''}
      </span>
    </div>
  `).join('') + (state.paletteFilter === 'custom' ? `
    <button type="button" class="palette-card palette-card-new" data-new-palette aria-label="Create new palette">
      <span class="palette-card-new-icon">+</span>
      <span class="palette-card-new-label">Create new palette</span>
    </button>
    <button type="button" class="palette-card palette-card-new" data-import-palette aria-label="Import palette">
      <span class="palette-card-new-icon"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v7M4.5 6.5L7 9l2.5-2.5M2.5 11.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
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
      <label title="Edit ${color}">${colorControl(color, `Color ${index + 1}, ${color}`, `data-color-index="${index}"`)}</label>
      <button type="button" data-remove-color="${index}" aria-label="Remove color ${index + 1}">×</button>
    </div>
  `).join('') + `
    <button type="button" class="custom-color-add" data-add-color aria-label="Add color">+</button>
  `;
  paletteEditor.disabled = !activePaletteIsCustom();
}

// Single slider generator — every range control in the app must go through this.
// Markup matches the Adjustments panel rows: label (span + output) above a .range input.
function rangeControl(key: string, label: string, min: number, max: number, step: number | 'any', value: number, display: string = String(value)): string {
  return `
    <div class="adjustment-row">
      <label for="${key}"><span>${label}</span><output id="${key}Value">${display}</output></label>
      <input class="range" id="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}" />
    </div>
  `;
}

// Single color-picker generator — visually-hidden input + live --swatch chip, matching the palette editor.
// Every color input in the app goes through this; syncColorChip keeps the chip in lockstep with the value.
function colorControl(value: string, ariaLabel: string, attrs: string = ''): string {
  return `<input type="color" value="${value}" aria-label="${ariaLabel}" ${attrs}/><span style="--swatch:${value}"></span>`;
}
function syncColorChip(input: HTMLInputElement): void {
  input.nextElementSibling?.setAttribute('style', `--swatch:${input.value}`);
}

function renderAdjustments(): void {
  const controls: Array<[keyof Pick<State, 'brightness' | 'contrast' | 'saturation'>, string]> = [
    ['brightness', 'Brightness'], ['contrast', 'Contrast'], ['saturation', 'Saturation'],
  ];
  document.querySelector('#adjustmentControls')!.innerHTML = controls.map(([key, label]) =>
    rangeControl(key, label, -100, 100, 1, state[key], `${state[key] > 0 ? '+' : ''}${state[key]}`),
  ).join('');
}

function hydrateCustomDraft(name: string, description: string, colors: string[], key: string | null = null): void {
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
}

function beginCustomDraft(name: string, description: string, colors: string[], key: string | null = null): void {
  hydrateCustomDraft(name, description, colors, key);
  renderPalettes();
  render();
}

// Hydrate the draft state WITHOUT re-rendering the palette rows: re-rendering would replace the
// <input type="color"> the user is currently editing, detaching it so the picker's trailing
// 'change' event never bubbles to the customColors listener and the edit is never persisted.
function ensureCustomDraft(): void {
  if (state.customColors.length > 0) return;
  const selectedCustom = savedCustomPalettes.find((palette) => palette.key === state.paletteKey);
  if (selectedCustom) hydrateCustomDraft(selectedCustom.name, selectedCustom.description, selectedCustom.colors, selectedCustom.key);
  else hydrateCustomDraft(`${currentPalette().name} Copy`, `Custom copy of ${currentPalette().name}`, currentPalette().colors);
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

function revealPalette(key: string): void {
  state.paletteFilter = 'custom';
  paletteFilters.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.paletteFilter);
  });
  renderPalettes();
  requestAnimationFrame(() => {
    const card = paletteGrid.querySelector<HTMLElement>(`[data-palette="${key}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    card?.focus({ preventScroll: true });
  });
}

function duplicatePaletteByKey(key: string): void {
  const source = paletteCatalog()[key];
  if (!source) return;
  const duplicate = duplicatePalette(source);
  beginCustomDraft(duplicate.name, duplicate.description, duplicate.colors, duplicate.key);
  persistCustomDraft();
  if (state.paletteKey === duplicate.key) revealPalette(duplicate.key);
}

function exportPaletteByKey(key: string): void {
  try {
    const palette = savedCustomPalettes.find((entry) => entry.key === key);
    if (!palette) return;
    const safeName = safeFileName(palette.name, 'custom-palette');
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
      state.paletteKey = 'desert';
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

type RangeBinding = {
  input: HTMLInputElement;
  output: HTMLElement;
  format: (value: number) => string;
  apply: (value: number) => void;
};

function bindRange({ input, output, format, apply }: RangeBinding): void {
  input.addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    apply(value);
    output.textContent = format(value);
    renderScheduler.request();
  });
  input.addEventListener('change', renderScheduler.flush);
}

function syncControlsFromState(): void {
  strengthInput.value = String(Math.round(state.strength * 100));
  strengthValue.textContent = formatPercent(Math.round(state.strength * 100));
  stripeAngleInput.value = String(state.stripeAngle);
  stripeAngleValue.textContent = formatDegrees(state.stripeAngle);
  noiseScaleInput.value = String(state.noiseScale);
  noiseScaleValue.textContent = formatPixels(state.noiseScale);
  seedInput.value = String(state.seed);
  seedValue.textContent = formatPlain(state.seed);
  setActiveMode(state.mode);
  updatePatternControls();
  updateAOControls();
  renderSunControl();
  renderNormalControls();
  renderAdjustments();
  bindAdjustmentEvents();
  renderPalettes();
}

const CONFIG_FILE_NAME = 'ultipixelizer-settings.json';
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
    aoBias: state.aoBias,
    aoScale: state.aoScale,
    aoDistance: state.aoDistance,
    sunColor: state.sun.color,
    sunIntensity: state.sun.intensity,
    ambientColor: state.ambient.color,
    ambientIntensity: state.ambient.intensity,
    lightmapContribution: state.lightmapContribution,
    normalStrength: state.normalStrength,
    normalFormat: state.normalFormat,
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
  const paletteSelection = selectOrCreatePalette(localStorage, paletteCatalog(), preset.palette, preset.paletteKey);
  const paletteKey = paletteSelection.key;
  savedCustomPalettes = paletteSelection.customPalettes;
  Object.assign(state, {
    resolution: preset.resolution,
    mode: preset.mode,
    strength: preset.strength,
    brightness: preset.brightness,
    contrast: preset.contrast,
    saturation: preset.saturation,
    paletteKey,
    uvMap: preset.uvMap,
    stripeAngle: preset.stripeAngle,
    noiseScale: preset.noiseScale,
    seed: preset.seed,
    aoBias: preset.aoBias,
    aoScale: preset.aoScale,
    aoDistance: preset.aoDistance,
    sun: { ...state.sun, color: preset.sunColor, intensity: preset.sunIntensity },
    ambient: { ...state.ambient, color: preset.ambientColor, intensity: preset.ambientIntensity },
    lightmapContribution: preset.lightmapContribution,
    normalStrength: preset.normalStrength,
    normalFormat: preset.normalFormat,
    paletteSnapshot: undefined,
    customColors: [],
  });
  const selectedCustom = savedCustomPalettes.find((palette) => palette.key === paletteKey);
  const selectedPalette = paletteCatalog()[paletteKey];
  editingCustomKey = selectedCustom?.key ?? null;
  customPaletteName.value = selectedCustom?.name ?? selectedPalette.name;
  customPaletteDescription.value = selectedCustom?.description ?? selectedPalette.description;
  syncControlsFromState();
  applySun();
  updateResolution(preset.resolution, true);
  if (modelUVChannels.includes(preset.uvMap)) {
    uvMapSelect.value = preset.uvMap;
    applyModelUV(preset.uvMap);
  }
}

const renderer = createRenderer({
  state,
  textures,
  previewCanvas,
  originalCanvas,
  getAOScene: () => aoBakeScene,
  forEachViewport,
  getOriginalViewport: () => originalViewport,
  getProcessedViewport: () => processedViewport,
  getOriginalPreviewMode: () => originalPreviewMode,
  getProcessedPreviewMode: () => processedPreviewMode,
  dimensions,
  currentColors,
  updatePreviewBadge,
  showToast,
  renderLightmapControls,
  renderNormalControls,
  renderTextureRibbon,
  applySun,
});

const {
  render,
  generateAo,
  bakeLighting,
  clearLightmap,
  scheduleImplicitLightmapBake,
  scheduleNormalAdjustedLighting,
  refreshUVWireframe,
  refreshUVOverlap,
  resetPreview,
} = renderer;

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

function updateFileMeta(name: string, width: number, height: number, updateHeading = true): void {
  if (updateHeading) document.querySelector('#fileName')!.textContent = name;
  document.querySelector('#sourceDimensions')!.textContent = `${width} × ${height}`;
}

function clearTexture(channel: TextureChannelId): void {
  if (channel === 'base') {
    if (textures.lightmap.image) clearLightmap();
    textures.base.image = sample;
    textures.base.name = 'sample-landscape.png';
    updateFileMeta(textures.base.name, sample.width, sample.height);
    refreshUVOverlap();
  } else if (channel === 'lightmap') {
    clearLightmap();
    return;
  } else {
    textures[channel].image = null;
    textures[channel].name = '';
    if (channel === 'normal') {
      renderNormalControls();
      scheduleNormalAdjustedLighting();
    }
  }
  renderTextureRibbon();
  render();
}

function clearModel(): void {
  renderScheduler.cancel();
  closeModelPreview();
  const base = textures.base.image;
  updateFileMeta(textures.base.name, base?.width ?? 640, base?.height ?? 461);
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
    if (channel === 'base' && textures.lightmap.image) clearLightmap();
    if (channel === 'lightmap') {
      const baseColor = textures.base.image!;
      if (!lightmapMatchesBaseColor(image, baseColor)) {
        throw new Error(`Lightmap must match BaseColor: expected ${baseColor.width} × ${baseColor.height}, received ${image.width} × ${image.height}.`);
      }
    }
    textures[channel].image = image;
    textures[channel].name = file.name;
    if (channel === 'base') {
      updateFileMeta(file.name, image.width, image.height, !modelBundle);
      refreshUVOverlap();
    }
    if (channel === 'lightmap') {
      renderLightmapControls();
      renderNormalControls();
      applySun();
    }
    if (channel === 'normal') {
      renderNormalControls();
      scheduleNormalAdjustedLighting();
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
  Object.assign(state, defaultState(), { paletteSnapshot: undefined });
  textures.lightmap.image = null;
  textures.lightmap.name = '';
  renderTextureRibbon();
  editingCustomKey = null;
  customPaletteName.value = '';
  customPaletteDescription.value = '';
  syncControlsFromState();
  scheduleNormalAdjustedLighting();
  applySun();
  refreshUVOverlap();
  renderUVOverlapControl();
  renderUVWireframeControl();
  renderNormalsControl();
  renderNormalsViewControl();
  originalViewport?.setNormalsView(state.showNormals);
  processedViewport?.setNormalsView(state.showNormals);
  updateResolution(128, true);
  showToast('Settings reset');
}

function bindAdjustmentEvents(): void {
  (['brightness', 'contrast', 'saturation'] as const).forEach((key) => {
    const input = document.querySelector<HTMLInputElement>(`#${key}`);
    const output = document.querySelector<HTMLElement>(`#${key}Value`);
    if (!input || !output) return;
    bindRange({
      input,
      output,
      format: formatSignedInt,
      apply: (value) => { state[key] = value; },
    });
  });
}

async function fetchExampleFile(url: string, name: string, type: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${name} (${response.status})`);
  return new File([await response.blob()], name, { type });
}

async function loadExampleAssets(): Promise<void> {
  try {
    const [baseColor, normal, model] = await Promise.all([
      fetchExampleFile(exampleBaseColorUrl, 'Book_BaseColor.png', 'image/png'),
      fetchExampleFile(exampleNormalUrl, 'Book_NormalMap.png', 'image/png'),
      fetchExampleFile(exampleModelUrl, 'Book.fbx', 'application/octet-stream'),
    ]);
    await setTexture('base', baseColor);
    await setTexture('normal', normal);
    await setModel([model]);
  } catch (error) {
    console.warn('Example assets could not be loaded; using the sample texture.', error);
  }
}

syncControlsFromState();
renderTextureRibbon();
applyPreviewMode();
render();
void loadExampleAssets();

document.querySelector('#resolution')!.addEventListener('input', (event) => updateResolution(Number((event.target as HTMLInputElement).value)));
document.querySelector('#resolution')!.addEventListener('change', renderScheduler.flush);
document.querySelectorAll<HTMLButtonElement>('[data-resolution]').forEach((button) => button.addEventListener('click', () => updateResolution(Number(button.dataset.resolution), true)));
bindRange({
  input: strengthInput,
  output: strengthValue,
  format: formatPercent,
  apply: (value) => { state.strength = value / 100; },
});
bindRange({
  input: stripeAngleInput,
  output: stripeAngleValue,
  format: formatDegrees,
  apply: (value) => { state.stripeAngle = value; },
});
bindRange({
  input: noiseScaleInput,
  output: noiseScaleValue,
  format: formatPixels,
  apply: (value) => { state.noiseScale = value; },
});
bindRange({
  input: seedInput,
  output: seedValue,
  format: formatPlain,
  apply: (value) => { state.seed = value; },
});
bindRange({
  input: aoBiasInput,
  output: aoBiasValue,
  format: formatSignedFixed2,
  apply: (value) => { state.aoBias = Math.round(value * 100) / 100; },
});
bindRange({
  input: aoScaleInput,
  output: aoScaleValue,
  format: formatTimes2,
  apply: (value) => { state.aoScale = Math.round(value * 100) / 100; },
});
bindRange({
  input: aoDistanceInput,
  output: aoDistanceValue,
  format: formatTimes2,
  apply: (value) => { state.aoDistance = value; },
});
bindRange({
  input: lightmapContributionInput,
  output: lightmapContributionValue,
  format: formatPercent,
  apply: (value) => { state.lightmapContribution = value / 100; },
});
bindRange({
  input: normalStrengthInput,
  output: normalStrengthValue,
  format: formatPercent,
  apply: (value) => {
    state.normalStrength = value / 100;
    scheduleNormalAdjustedLighting();
  },
});
normalFormatSelect.addEventListener('change', () => {
  state.normalFormat = normalFormatSelect.value as NormalFormat;
  scheduleNormalAdjustedLighting();
});
generateAoButton.addEventListener('click', generateAo);
bakeLightmapButton.addEventListener('click', bakeLighting);
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  state.mode = button.dataset.mode as DitherMode;
  setActiveMode(state.mode);
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
  syncColorChip(input);
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

function pickTextureFromSlot(slot: HTMLElement): void {
  if (slot.classList.contains('disabled')) {
    showToast('Load a model to enable model texture maps.');
    return;
  }
  pendingTextureChannel = slot.dataset.texture as TextureChannelId;
  textureInput.click();
}

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
  if (slot?.dataset.texture) pickTextureFromSlot(slot);
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
  pickTextureFromSlot(slot);
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
function bindPreviewToggle(toggle: HTMLElement, setMode: (mode: PreviewMode) => void): void {
  toggle.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-preview-mode]');
    if (!button?.dataset.previewMode) return;
    setMode(button.dataset.previewMode as PreviewMode);
    applyPreviewMode();
  });
}
bindPreviewToggle(originalPreviewToggle, (mode) => { originalPreviewMode = mode; });
bindPreviewToggle(processedPreviewToggle, (mode) => { processedPreviewMode = mode; });
uvMapSelect.addEventListener('change', () => applyModelUV(uvMapSelect.value));
lodMapSelect.addEventListener('change', () => applyModelLod(Number(lodMapSelect.value)));
worldAxisSelect.addEventListener('change', () => {
  state.worldAxis = worldAxisSelect.value as WorldAxis;
  applyWorldAxis();
});
uvOverlapInput.addEventListener('change', () => {
  state.showUVOverlap = uvOverlapInput.checked;
  renderUVOverlapControl();
  refreshUVOverlap();
  render();
});
uvWireframeInput.addEventListener('change', () => {
  state.showUVWireframe = uvWireframeInput.checked;
  renderUVWireframeControl();
  render();
});
useSourceNormalsInput.addEventListener('change', () => {
  state.useSourceNormals = useSourceNormalsInput.checked;
  renderNormalControls();
  if (modelFiles.length) void setModel(modelFiles);
  else renderNormalsControl();
});
showNormalsInput.addEventListener('change', () => {
  state.showNormals = showNormalsInput.checked;
  renderNormalsViewControl();
  originalViewport?.setNormalsView(state.showNormals);
  processedViewport?.setNormalsView(state.showNormals);
});
smoothAngleInput.addEventListener('input', () => {
  state.smoothAngle = Number(smoothAngleInput.value);
  smoothAngleValue.textContent = formatDegrees(state.smoothAngle);
});
smoothAngleInput.addEventListener('change', () => {
  if (modelFiles.length && !state.useSourceNormals) void setModel(modelFiles);
});
function bindSunControl(): void {
  sunControlElements.orientWithCamera.addEventListener('click', () => {
    if (!originalViewport || originalPreviewMode !== '3d') return;
    state.sun.direction = originalViewport.getCameraForward();
    applySun();
  });
  const bindLightColor = (input: HTMLInputElement, target: LightState): void => {
    input.addEventListener('input', () => {
      target.color = input.value;
      applySun();
    });
  };
  const bindLightIntensity = (input: HTMLInputElement, target: LightState): void => {
    input.addEventListener('input', () => {
      target.intensity = Number(input.value);
      applySun();
    });
  };

  sunControlElements.enabled.addEventListener('change', () => {
    state.sun.enabled = sunControlElements.enabled.checked;
    applySun();
  });
  bindLightColor(sunControlElements.color, state.sun);
  bindLightIntensity(sunControlElements.intensity, state.sun);
  sunControlElements.ambientEnabled.addEventListener('change', () => {
    state.ambient.enabled = sunControlElements.ambientEnabled.checked;
    applySun();
  });
  bindLightColor(sunControlElements.ambientColor, state.ambient);
  bindLightIntensity(sunControlElements.ambientIntensity, state.ambient);
}

bindSunControl();
const dropZone = document.querySelector<HTMLDivElement>('#dropZone')!;
bindSlotDragState(dropZone);
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
  const safeName = safeFileName(textures.base.name.replace(/\.[^.]+$/, ''));
  const rendered = renderer.getRenderedCanvas();
  downloadCanvas(rendered, `${safeName}-dithered.png`);
  showToast(`Exported ${rendered.width} × ${rendered.height} PNG`);
});
