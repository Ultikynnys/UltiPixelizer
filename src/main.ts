import './style.css';
import { createCanvas, createSampleTexture, downloadCanvas, downloadText, drawImageToCanvas, loadImageFile, resizeNearest } from './lib/canvas';
import { openExternalLink } from './lib/tauri';
import { createCustomPalette, deleteCustomPalette, duplicatePalette, loadCustomPalettes, paletteFromImport, selectOrCreatePalette, serializeCustomPalette, updateCustomPalette, upsertCustomPalette, type CustomPalette } from './lib/customPalettes';
import type { DitherMode } from './lib/dither';
import { sampleColorAt } from './lib/eyedropper';
import { hexToRgb, hsvToRgb, palettes, rgbToHex, rgbToHsv, type Palette, type PaletteCategory } from './lib/palettes';
import { computePosterizeStats, posterizeColors, type PosterizeStats } from './lib/posterize';
import { createRenderScheduler } from './lib/renderScheduler';
import { createModelFileBundle, modelFormat, type ModelFileBundle, type WorldAxis } from './lib/modelFiles';
import { collectModelTextures, type ExtractedModelTextures } from './lib/modelTextures';
import { applyUVChannel, cloneModelScene, disposeModel, geometryUVChannels, renderModelThumbnail } from './lib/modelScene';
import { applyLodLevel, prepareModelLods } from './lib/modelLod';
import { loadModel, ModelViewport, upAxisRotation } from './lib/modelPreview';
import { computeAverageTexelDensity } from './lib/texelDensity';
import { applyConfigValues, collectConfigValues, createPreset, defaultConfigValues, parsePreset, serializePreset, type ConversionPreset } from './lib/presets';
import { lightmapMatchesBaseColor } from './lib/lightmap';
import type { NormalFormat } from './lib/normal';
import { DEFAULT_AMBIENT_INTENSITY, DEFAULT_NORMAL_STRENGTH, DEFAULT_SUN_INTENSITY } from './lib/defaults';
import { createRenderer } from './lib/render';
import { lightmapIsActive, type LightState, type PreviewMode, type PreviewViewMode, type SourceImage, type State, type TextureChannelId, type TextureSlot } from './lib/state';
import { safeFileName } from './lib/strings';
import { DEFAULT_CAMERA_DIRECTION, DEFAULT_SUN_DIRECTION, type DirectionVector } from './lib/sunDirection';
import { Mesh, MeshBasicMaterial, type Object3D } from 'three';
import exampleModelUrl from '../Example/Book.fbx?url';
import exampleBaseColorUrl from '../Example/Book_BaseColor.png?url';
import exampleNormalUrl from '../Example/Book_NormalMap.png?url';

const TEXTURE_CHANNELS: ReadonlyArray<{ id: TextureChannelId; label: string; bake?: boolean }> = [
  { id: 'base', label: 'BaseColor' },
  { id: 'ao', label: 'AO', bake: true },
  { id: 'normal', label: 'Normal' },
  { id: 'lightmap', label: 'Lightmap' },
];

// Download-arrow icon shared by the palette export card, the texture slot
// download buttons, and the Export PNG button, so the markup lives in one place.
const DOWNLOAD_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v7M4.5 6.5L7 9l2.5-2.5M1 11.5h12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Import-arrow icon for the palette import card — the inverse of download:
// the tray line stays at the bottom, but the arrowhead flips to the top of
// the shaft so the arrow points up, out of storage into the app.
const IMPORT_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 9v-7M4.5 4.5L7 2l2.5 2.5M1 11.5h12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Eyedropper (pipette) icon for the screen color-picker button in the palette
// editor — a round bulb, tube, and needle tip so it reads as a dropper (the
// previous straight-shaft glyph looked like a sword). Phosphor icons, MIT.
const EYEDROPPER_ICON_SVG = '<svg width="28" height="28" viewBox="0 0 256 256" aria-hidden="true" fill="currentColor"><path d="M224,67.3a35.79,35.79,0,0,0-11.26-25.66c-14-13.28-36.72-12.78-50.62,1.13L142.8,62.2a24,24,0,0,0-33.14.77l-9,9a16,16,0,0,0,0,22.64l2,2.06-51,51a39.75,39.75,0,0,0-10.53,38l-8,18.41A13.68,13.68,0,0,0,36,219.3a15.92,15.92,0,0,0,17.71,3.35L71.23,215a39.89,39.89,0,0,0,37.06-10.75l51-51,2.06,2.06a16,16,0,0,0,22.62,0l9-9a24,24,0,0,0,.74-33.18l19.75-19.87A35.75,35.75,0,0,0,224,67.3ZM97,193a24,24,0,0,1-24,6,8,8,0,0,0-5.55.31l-18.1,7.91L57,189.41a8,8,0,0,0,.25-5.75A23.88,23.88,0,0,1,63,159l51-51,33.94,34ZM202.13,82l-25.37,25.52a8,8,0,0,0,0,11.3l4.89,4.89a8,8,0,0,1,0,11.32l-9,9L112,83.26l9-9a8,8,0,0,1,11.31,0l4.89,4.89a8,8,0,0,0,11.33,0l24.94-25.09c7.81-7.82,20.5-8.18,28.29-.81a20,20,0,0,1,.39,28.7Z"/></svg>';

// The same pipette as a cursor image (explicit fill — a cursor can't inherit
// currentColor). Encoded at runtime so no hand-escaped SVG sits in the CSS.
const EYEDROPPER_CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256"><path fill="#e8e8e2" d="M224,67.3a35.79,35.79,0,0,0-11.26-25.66c-14-13.28-36.72-12.78-50.62,1.13L142.8,62.2a24,24,0,0,0-33.14.77l-9,9a16,16,0,0,0,0,22.64l2,2.06-51,51a39.75,39.75,0,0,0-10.53,38l-8,18.41A13.68,13.68,0,0,0,36,219.3a15.92,15.92,0,0,0,17.71,3.35L71.23,215a39.89,39.89,0,0,0,37.06-10.75l51-51,2.06,2.06a16,16,0,0,0,22.62,0l9-9a24,24,0,0,0,.74-33.18l19.75-19.87A35.75,35.75,0,0,0,224,67.3ZM97,193a24,24,0,0,1-24,6,8,8,0,0,0-5.55.31l-18.1,7.91L57,189.41a8,8,0,0,0,.25-5.75A23.88,23.88,0,0,1,63,159l51-51,33.94,34ZM202.13,82l-25.37,25.52a8,8,0,0,0,0,11.3l4.89,4.89a8,8,0,0,1,0,11.32l-9,9L112,83.26l9-9a8,8,0,0,1,11.31,0l4.89,4.89a8,8,0,0,0,11.33,0l24.94-25.09c7.81-7.82,20.5-8.18,28.29-.81a20,20,0,0,1,.39,28.7Z"/></svg>';
// Hotspot (6, 18) sits on the dropper's needle tip (≈64, 192 in the 256²
// viewBox, scaled to the 24px cursor).
const EYEDROPPER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(EYEDROPPER_CURSOR_SVG)}") 6 18, crosshair`;

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

// Posterize ramps adapt to the BaseColor texture's own tonal distribution
// (see refreshPosterizeStats) — recomputed whenever the base image changes.
const POSTERIZE_SAMPLE_MAX = 64;
let posterizeStats: PosterizeStats | null = null;
refreshPosterizeStats();
const sunOverlayMarkup = (): string => `
  <div class="sun-overlay" id="sunControl" hidden>
    <div class="sun-overlay-heading">
      <span>Lighting controls</span>
    </div>
    <button class="orient-sun-button" id="orientSunWithCamera" type="button" title="Copy the Original 3D viewport angle to the sun">Orient Sun with Camera</button>
    <div class="orientation-readout" title="World-space direction (x, y, z)">
      <div class="orientation-row"><span class="orientation-label">Sun</span><output id="sunDirectionValue">—</output></div>
      <div class="orientation-row"><span class="orientation-label">Camera</span><output id="cameraDirectionValue">—</output></div>
    </div>
    <div class="light-controls">
      <label class="light-color-control"><span>Sun color</span>${colorControl('#ffffff', 'Sun color', 'id="sunColor"')}</label>
      ${rangeControl('sunIntensity', 'Sun intensity', 0, 2, 0.01, DEFAULT_SUN_INTENSITY)}
      <div class="light-section-title"><span>Ambient</span></div>
      <label class="light-color-control"><span>Color</span>${colorControl('#ffffff', 'Ambient light color', 'id="ambientColor"')}</label>
      ${rangeControl('ambientIntensity', 'Intensity', 0, 1, 0.01, DEFAULT_AMBIENT_INTENSITY)}
      <div class="light-section-title"><span>Normals</span></div>
      ${rangeControl('normalStrength', 'Strength', 0, 1, 0.01, DEFAULT_NORMAL_STRENGTH, '1.00', 'Normal-map influence on lighting')}
    </div>
  </div>
`;

function defaultState(): State {
  // State-only fields (no serialized config equivalent) are set here; the
  // serializable settings come from the shared CONFIG_FIELDS defaults.
  const defaults = defaultConfigValues();
  const state = {} as State;
  state.paletteKey = 'desert';
  state.customColors = [];
  state.paletteFilter = 'compact';
  state.uvMap = 'uv';
  state.lodLevel = 0;
  state.sun = { direction: { ...DEFAULT_SUN_DIRECTION }, color: defaults.sunColor as string, intensity: defaults.sunIntensity as number };
  state.ambient = { color: defaults.ambientColor as string, intensity: defaults.ambientIntensity as number };
  state.worldAxis = 'blender';
  state.cameraDirection = { ...DEFAULT_CAMERA_DIRECTION };
  state.showUVOverlap = false;
  state.showUVWireframe = true;
  state.viewModeOriginal = 'flat';
  state.viewModeProcessed = 'flat';
  applyConfigValues(state, defaults);
  return state;
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
        <button class="button" id="saveButton" type="button">Save</button>
        <button class="button" id="loadButton" type="button">Load</button>
        <button class="button" id="resetButton" type="button">Reset settings</button>
        <input id="loadConfigInput" type="file" accept=".json,application/json" hidden />
      </div>
    </header>

    <main class="workspace">
      <section class="preview-column" aria-label="Texture preview">
        <div class="preview-toolbar">
          <div class="texture-ribbon" id="textureRibbon" aria-label="Texture sources">
            ${TEXTURE_CHANNELS.map((channel) => `
              <div class="texture-slot" data-texture="${channel.id}" tabindex="0" aria-label="${channel.label} texture slot">
                <span class="texture-slot-preview"><span class="texture-slot-empty-mark">+</span></span>
                <span class="texture-slot-label">+${channel.label}</span>
                <button class="icon-button texture-slot-download" data-download-texture="${channel.id}" type="button" aria-label="Download ${channel.label}" title="Download ${channel.label}">${DOWNLOAD_ICON_SVG}</button>
                <button class="icon-button texture-slot-clear" data-clear-texture="${channel.id}" type="button" aria-label="Clear ${channel.label}">×</button>
                ${channel.bake ? `<button class="icon-button texture-slot-bake" data-bake-texture="${channel.id}" type="button" aria-label="Bake ${channel.label}">Bake</button>` : ''}
                ${channel.id === 'normal' ? '<span class="texture-slot-format" role="group" aria-label="Normal map format"><button type="button" data-normal-format="opengl" title="OpenGL · +Y up">GL</button><button type="button" data-normal-format="directx" title="DirectX · −Y up">DX</button></span>' : ''}
              </div>
            `).join('')}
            <div class="texture-slot texture-slot-model" data-model-slot tabindex="0" aria-label="Model bundle slot">
              <span class="texture-slot-preview"><span class="texture-slot-empty-mark">+</span></span>
              <span class="texture-slot-label">+Model</span>
              <button class="icon-button texture-slot-clear" data-clear-model type="button" aria-label="Clear model">×</button>
            </div>
            <input id="textureInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
            <input id="modelInput" type="file" multiple accept=".fbx,.obj,.mtl,.gltf,.glb,.bin,.usdz,image/*" hidden />
          </div>
          <div class="toolbar-actions">
            <label class="uv-control" id="uvControl" hidden><span>UV map</span><select class="select" id="uvMap" aria-label="Model UV map"></select></label>
            <label class="uv-control" id="lodControl" hidden><span>LOD</span><select class="select" id="lodMap" aria-label="Model LOD level"></select></label>
          </div>
        </div>

        <div class="canvas-stage">
          <div class="comparison-grid" aria-label="Original and dithered texture comparison">
            <figure class="preview-pane original-pane">
              <figcaption><span>01</span> Original <span class="fig-dims" id="sourceDimensions">640 × 461</span><button class="fig-zoom" id="originalZoomBadge" type="button" title="Zoom level — scroll over the preview to zoom, drag to pan, double-click to reset">100%</button></figcaption>
              <div class="canvas-frame">
                <canvas id="originalCanvas" aria-label="Original texture preview"></canvas>
                <canvas class="wireframe-overlay" id="originalWireframeOverlay" aria-hidden="true" hidden></canvas>
                <div class="model-host" id="originalModelHost" hidden></div>
                ${sunOverlayMarkup()}
                <div class="preview-mode-toggle" id="originalPreviewToggle" hidden role="group" aria-label="Preview mode">
                  <button type="button" data-preview-mode="2d" class="active">2D</button>
                  <button type="button" data-preview-mode="3d">3D</button>
                </div>
                <label class="uv-overlap-control" id="uvOverlapControl" hidden title="Highlight regions where UV shells overlap">
                  <span>UV overlap</span>
                  ${toggleControl('uvOverlap', 'Show overlapping UVs')}
                </label>
                <label class="uv-overlap-control" id="uvWireframeControl" hidden title="Overlay UV island wireframes on the 2D view">
                  <span>UV islands</span>
                  ${toggleControl('uvWireframe', 'Show UV island wireframes', true)}
                </label>
                <div class="preview-view-toggle" id="originalViewToggle" hidden role="group" aria-label="View mode">
                  <button type="button" data-view="flat" class="active">Combined</button>
                  <button type="button" data-view="basecolor">BaseColor</button>
                  <button type="button" data-view="normals">Normals</button>
                  <button type="button" data-view="ao">AO</button>
                  <button type="button" data-view="lightmap">Lightmap</button>
                  <button type="button" data-view="lightmap-ao">Lightmap+AO</button>
                </div>
                <div class="preview-view-toggle world-axis-toggle" id="worldAxisToggle" hidden role="group" aria-label="World axis">
                  <button type="button" data-world-axis="blender" class="active" title="Blender · Z-up">Z-up</button>
                  <button type="button" data-world-axis="maya" title="Maya · Y-up">Y-up</button>
                </div>
              </div>
            </figure>
            <figure class="preview-pane processed-pane">
              <figcaption><span>02</span> Dithered <span class="fig-dims" id="processedDimensions">128 × 92</span><button class="fig-zoom" id="processedZoomBadge" type="button" title="Zoom level — scroll over the preview to zoom, drag to pan, double-click to reset">100%</button></figcaption>
              <div class="canvas-frame">
                <canvas id="previewCanvas" aria-label="Dithered texture preview"></canvas>
                <canvas class="wireframe-overlay" id="processedWireframeOverlay" aria-hidden="true" hidden></canvas>
                <div class="model-host" id="processedModelHost" hidden></div>
                <div class="texel-density" id="processedTexelDensity" hidden title="Average texture pixels per world unit — UV face size compared with mesh face size in world space">
                  <span>Texel density</span>
                  <output id="processedTexelDensityValue">—</output>
                </div>
                <div class="preview-mode-toggle" id="processedPreviewToggle" hidden role="group" aria-label="Preview mode">
                  <button type="button" data-preview-mode="2d" class="active">2D</button>
                  <button type="button" data-preview-mode="3d">3D</button>
                </div>
                <button class="button" id="exportButton" type="button" title="Export the dithered preview as PNG">Export PNG ${DOWNLOAD_ICON_SVG}</button>
              </div>
            </figure>
          </div>
        </div>
      </section>

      <aside class="control-column">
        <section class="panel">
          <div class="panel-heading compact"><div><p class="eyebrow">COLOR SYSTEM</p><h2>Palette library</h2></div><span class="catalog-count" id="paletteCount">${Object.keys(palettes).length} PRESETS</span></div>
          <div class="palette-filters" id="paletteFilters" role="group" aria-label="Filter palette library">
            <button class="active" type="button" data-filter="compact">Compact</button>
            <button type="button" data-filter="pixel-art">Pixel art</button>
            <button type="button" data-filter="hardware">Hardware</button>
            <button type="button" data-filter="themed">Themed</button>
            <button type="button" data-filter="extended">Extended</button>
            <button type="button" data-filter="posterize">Posterize</button>
            <button type="button" data-filter="custom">Custom</button>
          </div>
          <div class="palette-grid" id="paletteGrid"></div>
          <div class="custom-palette">
            <div class="custom-palette-title">Custom palette editor</div>
            <fieldset class="palette-editor" id="paletteEditor">
              <div class="palette-editor-fields">
                <label><span>Name</span><input id="customPaletteName" maxlength="60" placeholder="Palette name" /></label>
              </div>
              <div class="color-picker" id="colorPicker">
                <div class="color-picker-head">
                  <span class="color-picker-swatch" id="colorPickerSwatch" style="--swatch:#ffffff"></span>
                  <input id="colorPickerHex" class="color-picker-hex" maxlength="7" spellcheck="false" aria-label="Hex color" />
                </div>
                <div class="color-picker-body">
                  <div class="color-picker-field" id="colorPickerField"></div>
                  <div class="color-picker-side">
                    <div class="color-picker-hue" id="colorPickerHue"></div>
                    <button class="color-picker-button" id="colorPickerButton" type="button" title="Pick a color from the screen" aria-label="Pick a color from the screen">${EYEDROPPER_ICON_SVG}</button>
                  </div>
                </div>
              </div>
              <div id="customColors" class="custom-colors"></div>
            </fieldset>
          </div>
          <input id="importCustomPalette" type="file" accept=".json,.hex,.txt,application/json" hidden />
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><p class="eyebrow">DITHER MATRIX</p><h2>Pattern</h2></div></div>
          <div class="mode-grid" role="group" aria-label="Dithering algorithm">
            <button class="mode-button active" data-mode="floyd" type="button"><span class="pattern pattern-noise"></span><strong>Floyd–Steinberg</strong><small>Organic grain</small></button>
            <button class="mode-button" data-mode="atkinson" type="button"><span class="pattern pattern-atkinson"></span><strong>Atkinson</strong><small>Crisp contrast</small></button>
            <button class="mode-button" data-mode="ordered" type="button"><span class="pattern pattern-grid"></span><strong>Ordered 4×4</strong><small>Regular matrix</small></button>
            <button class="mode-button" data-mode="cross" type="button"><span class="pattern pattern-cross"></span><strong>Cross</strong><small>Intersecting bands</small></button>
            <button class="mode-button" data-mode="stripes" type="button"><span class="pattern pattern-stripes"></span><strong>Stripes</strong><small>Directional bands</small></button>
            <button class="mode-button" data-mode="noise" type="button"><span class="pattern pattern-random"></span><strong>Noise</strong><small>Randomized grain</small></button>
            <button class="mode-button" data-mode="checker" type="button"><span class="pattern pattern-checker"></span><strong>Checker</strong><small>Alternating grid</small></button>
            <button class="mode-button" data-mode="halftone" type="button"><span class="pattern pattern-halftone"></span><strong>Halftone</strong><small>Print-style dots</small></button>
            <button class="mode-button" data-mode="none" type="button"><span class="pattern pattern-none"></span><strong>Hard map</strong><small>No diffusion</small></button>
          </div>
          ${rangeControl('strength', 'Dither strength', 0, 100, 1, 85, '85%', 'Error diffusion amount')}
          <div class="stripe-angle-control" id="stripeAngleControl" hidden>
            ${rangeControl('stripeAngle', 'Stripe angle', 0, 135, 1, 45, '45°', 'Band direction')}
          </div>
          <div class="noise-scale-control" id="noiseScaleControl" hidden>
            ${rangeControl('noiseScale', 'Noise scale', 1, 32, 1, 1, '1 px', 'Grain size')}
            ${rangeControl('seed', 'Seed', 0, 9999, 1, 1, '1', 'Noise pattern')}
          </div>
          <div class="halftone-scale-control" id="halftoneScaleControl" hidden>
            ${rangeControl('halftoneScale', 'Dot scale', 0.5, 4, 0.1, 1, '1.00×', 'Halftone dot size')}
          </div>
        </section>

        <section class="panel adjustments">
          <div class="panel-heading compact">
            <div><p class="eyebrow">RESOLUTION + TONE</p><h2>Adjustments</h2></div>
            <output class="value-pill" id="resolutionValue">128 px</output>
          </div>
          <div class="resolution-block">
            <input class="range" id="resolution" type="range" min="24" max="2048" step="8" value="128" aria-label="Pixelization width" />
            <div class="range-labels"><span>CHUNKY</span><span>FINE</span></div>
            <div class="resolution-presets" role="group" aria-label="Resolution presets">
              <button type="button" data-resolution="64">64</button>
              <button class="active" type="button" data-resolution="128">128</button>
              <button type="button" data-resolution="256">256</button>
              <button type="button" data-resolution="512">512</button>
              <button type="button" data-resolution="1024">1024</button>
              <button type="button" data-resolution="2048">2048</button>
            </div>
          </div>
          <div id="adjustmentControls"></div>
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><p class="eyebrow">LIGHTING</p><h2>Ambient occlusion</h2></div></div>
          ${rangeControl('aoBias', 'Bias', -1, 1, 0.01, 0, '+0.00', 'Shift occlusion baseline')}
          ${rangeControl('aoPower', 'Power', 0, 16, 0.01, 1, '1.00', 'Occlusion curve exponent (1 = as baked)')}
          ${rangeControl('aoDistance', 'Distance', 0.05, 3, 0.05, 2, '2.00×', 'Ray reach for generated AO')}
        </section>

      </aside>
    </main>
    <div class="ao-bake-overlay" id="aoBakeOverlay" hidden role="status" aria-live="polite">
      <div class="ao-bake-card">
        <p class="ao-bake-title">Baking ambient occlusion</p>
        <div class="ao-bake-track" aria-hidden="true"><div class="ao-bake-fill" id="aoBakeFill"></div></div>
        <p class="ao-bake-percent" id="aoBakePercent">0%</p>
      </div>
    </div>
  </div>
`;

const previewCanvas = document.querySelector<HTMLCanvasElement>('#previewCanvas')!;
const originalCanvas = document.querySelector<HTMLCanvasElement>('#originalCanvas')!;

// 2D preview pan/zoom. The texture canvases are laid out fitted (object-fit
// contain fills the frame); zooming/panning applies a CSS transform to the
// canvas element itself, so `image-rendering: pixelated` keeps texels crisp at
// any scale and the eyedropper's canvasPixelCoords stays correct (its
// object-fit math is invariant under uniform scale). Wheel zooms anchored at
// the cursor, primary-drag pans, double-click resets to fit, two-finger pinch
// zooms on touch, and the caption badge mirrors the zoom (click resets).
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 64;

function createPreviewZoom(canvas: HTMLCanvasElement, badge: HTMLButtonElement, overlay: HTMLElement | null = null): void {
  let scale = 1;
  let panX = 0;
  let panY = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let dragging = false;
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

  function apply(): void {
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    // The UV wireframe overlay fills the same frame and is drawn in
    // untransformed frame space, so it must track the canvas exactly.
    if (overlay) {
      overlay.style.transformOrigin = '0 0';
      overlay.style.transform = canvas.style.transform;
    }
    badge.textContent = `${Math.round(scale * 100)}%`;
  }

  /** Keep the canvas covering the frame once zoomed in; center it when smaller
   * than the frame (zoom below 100%). */
  function clampPan(): void {
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    const scaledWidth = width * scale;
    const scaledHeight = height * scale;
    panX = scaledWidth <= width ? (width - scaledWidth) / 2 : clamp(panX, width - scaledWidth, 0);
    panY = scaledHeight <= height ? (height - scaledHeight) / 2 : clamp(panY, height - scaledHeight, 0);
  }

  /** Zooms so the frame-space point (cursorX, cursorY) — relative to the
   * canvas's untransformed top-left — stays under the cursor. */
  function zoomAt(cursorX: number, cursorY: number, nextScale: number): void {
    const factor = nextScale / scale;
    panX = cursorX - (cursorX - panX) * factor;
    panY = cursorY - (cursorY - panY) * factor;
    scale = nextScale;
    clampPan();
    apply();
  }

  function reset(): void {
    scale = 1;
    panX = 0;
    panY = 0;
    apply();
  }

  const interactionsBlocked = (): boolean => document.body.classList.contains('eyedropping');

  // Cursor position in frame space: the transformed rect minus the current pan
  // recovers the canvas's untransformed top-left in the viewport.
  const cursorInFrame = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - (rect.left - panX), y: clientY - (rect.top - panY) };
  };

  canvas.addEventListener('wheel', (event) => {
    if (interactionsBlocked() || canvas.hidden) return;
    // preventDefault also stops the webview's ctrl+wheel page zoom.
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(-delta * 0.002);
    const { x, y } = cursorInFrame(event.clientX, event.clientY);
    zoomAt(x, y, clamp(scale * factor, ZOOM_MIN, ZOOM_MAX));
  }, { passive: false });

  canvas.addEventListener('pointerdown', (event) => {
    if (interactionsBlocked() || canvas.hidden || event.button !== 0) return;
    // No preventDefault here: canceling pointerdown would suppress the
    // compatibility mouse events, killing double-click-to-reset.
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [first, second] = Array.from(pointers.values());
      pinchDistance = Math.hypot(first.x - second.x, first.y - second.y);
      dragging = false;
    } else if (pointers.size === 1) {
      dragging = true;
    }
  });

  // Drag moves listen on the window, not the canvas: WebView2 does not
  // reliably deliver pointermove to a captured element, so a canvas-bound
  // listener would leave drag-pan dead in the desktop app. Window-level
  // listeners (the same pattern as the color-picker drag) see every move no
  // matter where the pointer travels.
  window.addEventListener('pointermove', (event) => {
    if (interactionsBlocked() || canvas.hidden) return;
    // A pointerup was missed (button released outside the window): end the drag.
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
      endPointer(event);
      return;
    }
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);
    if (pointers.size === 2) {
      const [first, second] = Array.from(pointers.values());
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (pinchDistance > 0) {
        const { x, y } = cursorInFrame((first.x + second.x) / 2, (first.y + second.y) / 2);
        zoomAt(x, y, clamp(scale * (distance / pinchDistance), ZOOM_MIN, ZOOM_MAX));
      }
      pinchDistance = distance;
      return;
    }
    if (!dragging) return;
    panX += current.x - previous.x;
    panY += current.y - previous.y;
    clampPan();
    apply();
  });

  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) dragging = false;
  };
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('dblclick', (event) => {
    if (interactionsBlocked() || canvas.hidden) return;
    event.preventDefault();
    reset();
  });

  badge.addEventListener('click', reset);
  window.addEventListener('resize', () => {
    if (canvas.hidden) return;
    clampPan();
    apply();
  });

  apply();
}

const originalZoomBadge = document.querySelector<HTMLButtonElement>('#originalZoomBadge')!;
const processedZoomBadge = document.querySelector<HTMLButtonElement>('#processedZoomBadge')!;
const originalWireframeOverlay = document.querySelector<HTMLCanvasElement>('#originalWireframeOverlay')!;
const processedWireframeOverlay = document.querySelector<HTMLCanvasElement>('#processedWireframeOverlay')!;
createPreviewZoom(originalCanvas, originalZoomBadge, originalWireframeOverlay);
createPreviewZoom(previewCanvas, processedZoomBadge, processedWireframeOverlay);
const aoBakeOverlay = document.querySelector<HTMLDivElement>('#aoBakeOverlay')!;
const aoBakeFill = document.querySelector<HTMLDivElement>('#aoBakeFill')!;
const aoBakePercent = document.querySelector<HTMLParagraphElement>('#aoBakePercent')!;
const paletteGrid = document.querySelector<HTMLDivElement>('#paletteGrid')!;
const paletteFilters = document.querySelector<HTMLDivElement>('#paletteFilters')!;
const customPaletteSection = document.querySelector<HTMLDivElement>('.custom-palette')!;
const customColors = document.querySelector<HTMLDivElement>('#customColors')!;
const customPaletteName = document.querySelector<HTMLInputElement>('#customPaletteName')!;
const paletteEditor = document.querySelector<HTMLFieldSetElement>('#paletteEditor')!;
const colorPickerSwatch = document.querySelector<HTMLSpanElement>('#colorPickerSwatch')!;
const colorPickerHex = document.querySelector<HTMLInputElement>('#colorPickerHex')!;
const colorPickerField = document.querySelector<HTMLDivElement>('#colorPickerField')!;
const colorPickerHue = document.querySelector<HTMLDivElement>('#colorPickerHue')!;
const colorPickerButton = document.querySelector<HTMLButtonElement>('#colorPickerButton')!;
// Current picker position as [hue, saturation, value] (0-360, 0-100, 0-100).
let pickerHsv: [number, number, number] = [0, 100, 100];
// Which chip in the custom palette editor the in-app picker is editing.
let activeColorIndex = 0;
const originalModelHost = document.querySelector<HTMLDivElement>('#originalModelHost')!;
const processedModelHost = document.querySelector<HTMLDivElement>('#processedModelHost')!;
const processedTexelDensity = document.querySelector<HTMLDivElement>('#processedTexelDensity')!;
const processedTexelDensityValue = document.querySelector<HTMLOutputElement>('#processedTexelDensityValue')!;
const uvControl = document.querySelector<HTMLLabelElement>('#uvControl')!;
const uvMapSelect = document.querySelector<HTMLSelectElement>('#uvMap')!;
const lodControl = document.querySelector<HTMLLabelElement>('#lodControl')!;
const lodMapSelect = document.querySelector<HTMLSelectElement>('#lodMap')!;
const worldAxisToggle = document.querySelector<HTMLElement>('#worldAxisToggle')!;
const uvOverlapControl = document.querySelector<HTMLLabelElement>('#uvOverlapControl')!;
const uvOverlapInput = document.querySelector<HTMLInputElement>('#uvOverlap')!;
const uvWireframeControl = document.querySelector<HTMLLabelElement>('#uvWireframeControl')!;
const uvWireframeInput = document.querySelector<HTMLInputElement>('#uvWireframe')!;
const originalViewToggle = document.querySelector<HTMLDivElement>('#originalViewToggle')!;
type SunElements = {
  control: HTMLDivElement;
  orientWithCamera: HTMLButtonElement;
  color: HTMLInputElement;
  intensity: HTMLInputElement;
  intensityValue: HTMLOutputElement;
  ambientColor: HTMLInputElement;
  ambientIntensity: HTMLInputElement;
  ambientIntensityValue: HTMLOutputElement;
  normalStrength: HTMLInputElement;
  normalStrengthValue: HTMLOutputElement;
};

const sunControlElements: SunElements = {
  control: document.querySelector<HTMLDivElement>('#sunControl')!,
  orientWithCamera: document.querySelector<HTMLButtonElement>('#orientSunWithCamera')!,
  color: document.querySelector<HTMLInputElement>('#sunColor')!,
  intensity: document.querySelector<HTMLInputElement>('#sunIntensity')!,
  intensityValue: document.querySelector<HTMLOutputElement>('#sunIntensityValue')!,
  ambientColor: document.querySelector<HTMLInputElement>('#ambientColor')!,
  ambientIntensity: document.querySelector<HTMLInputElement>('#ambientIntensity')!,
  ambientIntensityValue: document.querySelector<HTMLOutputElement>('#ambientIntensityValue')!,
  normalStrength: document.querySelector<HTMLInputElement>('#normalStrength')!,
  normalStrengthValue: document.querySelector<HTMLOutputElement>('#normalStrengthValue')!,
};
// Narrow windows hide the Original pane (CSS), so the pane-independent
// controls that live on it — view mode, world axis, UV toggles, sun — move
// onto the dithered pane, and back when the window widens. Moving the DOM
// nodes keeps their event listeners and state intact; every binding holds a
// node reference, so nothing re-queries or re-binds.
const originalPaneFrame = document.querySelector<HTMLDivElement>('.original-pane .canvas-frame')!;
const processedPaneFrame = document.querySelector<HTMLDivElement>('.processed-pane .canvas-frame')!;
const sharedPaneControls: HTMLElement[] = [
  originalViewToggle,
  worldAxisToggle,
  uvOverlapControl,
  uvWireframeControl,
  sunControlElements.control,
];
const narrowLayout = window.matchMedia('(max-width: 900px)');
function relocateSharedControls(narrow: boolean): void {
  const target = narrow ? processedPaneFrame : originalPaneFrame;
  sharedPaneControls.forEach((element) => target.append(element));
}
relocateSharedControls(narrowLayout.matches);
narrowLayout.addEventListener('change', (event) => relocateSharedControls(event.matches));
const sunDirectionValue = document.querySelector<HTMLOutputElement>('#sunDirectionValue')!;const cameraDirectionValue = document.querySelector<HTMLOutputElement>('#cameraDirectionValue')!;
const stripeAngleControl = document.querySelector<HTMLDivElement>('#stripeAngleControl')!;
const stripeAngleInput = document.querySelector<HTMLInputElement>('#stripeAngle')!;
const stripeAngleValue = document.querySelector<HTMLOutputElement>('#stripeAngleValue')!;
const noiseScaleControl = document.querySelector<HTMLDivElement>('#noiseScaleControl')!;
const noiseScaleInput = document.querySelector<HTMLInputElement>('#noiseScale')!;
const noiseScaleValue = document.querySelector<HTMLOutputElement>('#noiseScaleValue')!;
const halftoneScaleControl = document.querySelector<HTMLDivElement>('#halftoneScaleControl')!;
const halftoneScaleInput = document.querySelector<HTMLInputElement>('#halftoneScale')!;
const halftoneScaleValue = document.querySelector<HTMLOutputElement>('#halftoneScaleValue')!;
const seedInput = document.querySelector<HTMLInputElement>('#seed')!;
const seedValue = document.querySelector<HTMLOutputElement>('#seedValue')!;
const loadConfigInput = document.querySelector<HTMLInputElement>('#loadConfigInput')!;
const textureRibbon = document.querySelector<HTMLDivElement>('#textureRibbon')!;
const textureInput = document.querySelector<HTMLInputElement>('#textureInput')!;
const originalPreviewToggle = document.querySelector<HTMLDivElement>('#originalPreviewToggle')!;
const processedPreviewToggle = document.querySelector<HTMLDivElement>('#processedPreviewToggle')!;
const aoBiasInput = document.querySelector<HTMLInputElement>('#aoBias')!;
const aoBiasValue = document.querySelector<HTMLOutputElement>('#aoBiasValue')!;
const aoPowerInput = document.querySelector<HTMLInputElement>('#aoPower')!;
const aoPowerValue = document.querySelector<HTMLOutputElement>('#aoPowerValue')!;
const aoDistanceInput = document.querySelector<HTMLInputElement>('#aoDistance')!;
const aoDistanceValue = document.querySelector<HTMLOutputElement>('#aoDistanceValue')!;
const strengthInput = document.querySelector<HTMLInputElement>('#strength')!;
const strengthValue = document.querySelector<HTMLOutputElement>('#strengthValue')!;
const normalFormatToggle = document.querySelector<HTMLElement>('[data-texture="normal"] .texture-slot-format')!;
let savedCustomPalettes: CustomPalette[] = [];
try {
  savedCustomPalettes = loadCustomPalettes(localStorage);
} catch (error) {
  console.error('Custom palettes could not be loaded from storage.', error);
}
let editingCustomKey: string | null = null;
let modelBundle: ModelFileBundle | null = null;
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
// Retained clone of the loaded model used for the ribbon's mesh-slot
// thumbnail — the loaded scene is disposed after the viewports take clones.
let modelThumbScene: Object3D | null = null;
let pendingTextureChannel: TextureChannelId | null = null;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function customPaletteRecord(): Record<string, CustomPalette> {
  return Object.fromEntries(savedCustomPalettes.map((palette) => [palette.key, palette]));
}

function customPaletteByKey(key: string | null): CustomPalette | undefined {
  return key === null ? undefined : savedCustomPalettes.find((palette) => palette.key === key);
}

function paletteCatalog(): Record<string, Palette> {
  const catalog = { ...palettes, ...customPaletteRecord() };
  if (posterizeStats) {
    for (const [key, palette] of Object.entries(catalog)) {
      if (palette.category === 'posterize') {
        const levels = Number(key.slice('posterize'.length));
        if (Number.isInteger(levels) && levels >= 2) {
          catalog[key] = { ...palette, colors: posterizeColors(posterizeStats, levels, palette.colors) };
        }
      }
    }
  }
  return catalog;
}

function currentPalette(): Palette {
  if (state.paletteSnapshot) return state.paletteSnapshot;
  const palette = paletteCatalog()[state.paletteKey];
  if (!palette) throw new Error(`Unknown palette key "${state.paletteKey}".`);
  return palette;
}

function currentColors(): string[] {
  return state.customColors.length > 0 ? state.customColors : currentPalette().colors;
}

/** Selects a palette key and clears any in-progress custom color draft. Shared
 * by the save / select / delete / load-preset paths so the draft reset stays
 * consistent. */
function setPaletteKey(key: string): void {
  state.paletteKey = key;
  state.customColors = [];
  state.paletteSnapshot = undefined;
}

function dimensions(): { width: number; height: number } {
  const source = textures.base.image!;
  // The pixel grid resamples the source to the requested width — smaller
  // sources upscale (nearest-neighbor in the render pipeline), so 2k output
  // is reachable regardless of the source size.
  return { width: state.resolution, height: Math.max(1, Math.round(state.resolution * source.height / source.width)) };
}

function updatePreviewBadge(width?: number, height?: number): void {
  const badge = document.querySelector('#processedDimensions')!;
  if (modelBundle) {
    const format = modelFormat(modelBundle.primary.name)?.toUpperCase();
    const dims = width && height ? ` · ${formatDimensions(width, height)}` : '';
    badge.textContent = `${format} · ${modelUVChannels.length} UV MAP${modelUVChannels.length === 1 ? '' : 'S'}${dims}`;
  } else if (width && height) {
    badge.textContent = formatDimensions(width, height);
  }
}

const formatDimensions = (width: number, height: number): string => `${width} × ${height}`;
// Texel density scales exponentially with resolution (UV area grows as the
// texel count), so the decimals adapt: whole numbers at 100+, one at 10–100,
// two below. World units are arbitrary (three.js units), hence px/u.
const formatTexelDensity = (value: number): string => `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} px/u`;

// Top-left HUD chip on the dithered preview: average texels per world unit,
// from the UV face size compared with the mesh face size in world space. The
// AO bake scene always mirrors the current UV channel and LOD level, so it is
// the measure source; the dithered output resolution sizes the texel count.
// Hidden without a model or when no face carries a usable UV.
// Memoized: density depends only on the model's UVs and the target resolution,
// so basecolor swaps (which don't touch the scene) skip the 60k-tri walk.
let texelDensityCache: { scene: Object3D | null; width: number; height: number } | null = null;
function updateTexelDensity(): void {
  if (!aoBakeScene) {
    processedTexelDensity.hidden = true;
    texelDensityCache = null;
    return;
  }
  const { width, height } = dimensions();
  if (texelDensityCache && texelDensityCache.scene === aoBakeScene && texelDensityCache.width === width && texelDensityCache.height === height) return;
  texelDensityCache = { scene: aoBakeScene, width, height };
  const density = computeAverageTexelDensity(aoBakeScene, width, height);
  if (density === null) {
    processedTexelDensity.hidden = true;
    return;
  }
  processedTexelDensity.hidden = false;
  processedTexelDensityValue.textContent = formatTexelDensity(density);
}

// The rendered mesh-slot thumbnail is a pure function of the loaded model, and
// the model doesn't change between ribbon refreshes — re-rendering it (a sync
// WebGL frame + readPixels) on every basecolor/normal/lightmap change wasted
// tens of ms for an identical picture. Invalidate on import/close only.
let modelThumbnailCanvas: HTMLCanvasElement | null = null;

// One invalidation point for every cached result derived from the AO scene's
// geometry. The bake scene (BVH + world transforms), the UV-overlap mask, and
// the texel density only change when the model, UV channel, LOD visibility, or
// world-axis rotation change — all in-place mutations that identity-keyed
// caches cannot see.
function invalidateModelCaches(): void {
  invalidateBakeScene();
  invalidateUVOverlap();
  texelDensityCache = null;
}
const formatPercent = (value: number): string => `${value}%`;
const formatDegrees = (value: number): string => `${value}°`;
const formatPixels = (value: number): string => `${value} px`;
const formatPlain = (value: number): string => String(value);
const formatSignedFixed2 = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
const formatTimes2 = (value: number): string => `${value.toFixed(2)}×`;
const formatFixed2 = (value: number): string => value.toFixed(2);
const formatSignedInt = (value: number): string => `${value > 0 ? '+' : ''}${value}`;

function renderLightmapControls(): void {
  renderViewToggle();
}

// Combined preview view enum (Combined / BaseColor / Normals / AO / Lightmap /
// Lightmap+AO): a single segmented control on the Original pane that drives
// both preview panes. Normals / AO / Lightmap / Lightmap+AO are only
// actionable while their texture slot holds an image (or the lightmap has a
// live implicit bake; Lightmap+AO needs both).
function renderViewToggle(): void {
  const aoDefined = textures.ao.image !== null;
  const normalDefined = textures.normal.image !== null;
  // The lightmap view option follows the slot: an explicit bake, or the live
  // implicit lightmap baked from the current sun/ambient.
  const lightmapDefined = lightmapIsActive(textures) || renderer.getImplicitLightmapCanvas() !== null;
  const lightmapAoDefined = aoDefined && lightmapDefined;
  if (!aoDefined && state.viewModeOriginal === 'ao') state.viewModeOriginal = 'flat';
  if (!lightmapDefined && state.viewModeOriginal === 'lightmap') state.viewModeOriginal = 'flat';
  if (!normalDefined && state.viewModeOriginal === 'normals') state.viewModeOriginal = 'flat';
  if (!lightmapAoDefined && state.viewModeOriginal === 'lightmap-ao') state.viewModeOriginal = 'flat';
  if (!aoDefined && state.viewModeProcessed === 'ao') state.viewModeProcessed = 'flat';
  if (!lightmapDefined && state.viewModeProcessed === 'lightmap') state.viewModeProcessed = 'flat';
  if (!normalDefined && state.viewModeProcessed === 'normals') state.viewModeProcessed = 'flat';
  if (!lightmapAoDefined && state.viewModeProcessed === 'lightmap-ao') state.viewModeProcessed = 'flat';
  const hidden = modelBundle === null;
  originalViewToggle.hidden = hidden;
  syncViewToggle(originalViewToggle, state.viewModeOriginal, normalDefined, aoDefined, lightmapDefined, lightmapAoDefined);
  // A view-mode fallback above (e.g. the normal map was removed) must reach the
  // 3D viewports too — they render the Normals view via setNormalsView and
  // would otherwise stay latched on the stale showcase.
  applyViewNormals();
}

function syncViewToggle(toggle: HTMLDivElement, viewMode: PreviewViewMode, normalDefined: boolean, aoDefined: boolean, lightmapDefined: boolean, lightmapAoDefined: boolean): void {
  syncActiveButton(toggle, '[data-view]', (button) => button.dataset.view === viewMode);
  for (const button of toggle.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    const view = button.dataset.view as PreviewViewMode;
    button.disabled = (view === 'normals' && !normalDefined)
      || (view === 'ao' && !aoDefined)
      || (view === 'lightmap' && !lightmapDefined)
      || (view === 'lightmap-ao' && !lightmapAoDefined);
  }
}

function applyViewNormals(): void {
  originalViewport?.setNormalsView(state.viewModeOriginal === 'normals');
  processedViewport?.setNormalsView(state.viewModeProcessed === 'normals');
}

// Pushes the current normal-map texture (with the bake's strength / DirectX
// green-flip decode) into the 3D viewports, so the Normals view showcases the
// actual map rather than the mesh's vertex normals. The original viewport gets
// the native-resolution map; the dithered viewport gets a nearest-neighbor
// pixelized copy at the target resolution — normals can't be palette-dithered,
// so pixelization is the processed analogue of the quantized base texture.
function applyViewportNormalMap(): void {
  const image = textures.normal.image;
  const strength = state.normalStrength;
  const flipY = state.normalFormat === 'directx';
  originalViewport?.setNormalMap(image, strength, flipY);
  if (processedViewport) {
    const { width, height } = dimensions();
    processedViewport.setNormalMap(image ? resizeNearest(image, width, height) : null, strength, flipY);
  }
}

function renderNormalControls(): void {
  const lightmapActive = lightmapIsActive(textures);
  syncActiveButton(normalFormatToggle, '[data-normal-format]', (button) => button.dataset.normalFormat === state.normalFormat);
  normalFormatToggle.querySelectorAll<HTMLButtonElement>('[data-normal-format]').forEach((button) => { button.disabled = lightmapActive; });
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

// Shared checkbox-row renderer: every checkbox control in the app (UV overlap,
// UV wireframe, normals source, normals view) syncs visibility + checked state
// through this so the two-line pattern stays in one place.
function syncCheckboxControl(control: HTMLElement, input: HTMLInputElement, visible: boolean, checked: boolean): void {
  control.hidden = !visible;
  input.checked = checked;
}

// Shared select-row renderer, populated from `options` with the current value
// marked selected. Used by the UV-channel and LOD-level selects.
function renderSelectControl(control: HTMLElement, select: HTMLSelectElement, options: { value: string; label: string }[], selected: string, visible: boolean): void {
  control.hidden = !visible;
  select.innerHTML = options.map((option) =>
    `<option value="${escapeHtml(option.value)}" ${option.value === selected ? 'selected' : ''}>${option.label}</option>`,
  ).join('');
}

function renderUVControl(): void {
  renderSelectControl(uvControl, uvMapSelect, modelUVChannels.map((channel, index) => ({ value: channel, label: `UV ${index + 1} · ${channel}` })), state.uvMap, modelUVChannels.length > 0);
}

function renderUVOverlapControl(): void {
  syncCheckboxControl(uvOverlapControl, uvOverlapInput, modelUVChannels.length > 0 && originalPreviewMode === '2d', state.showUVOverlap);
}

function renderUVWireframeControl(): void {
  syncCheckboxControl(uvWireframeControl, uvWireframeInput, modelUVChannels.length > 0 && originalPreviewMode === '2d', state.showUVWireframe);
}

function renderLodControl(): void {
  renderSelectControl(lodControl, lodMapSelect, modelLodLevels.map((level) => ({ value: String(level), label: `LOD ${level}` })), String(state.lodLevel), modelLodLevels.length > 1);
}

function renderWorldAxisControl(): void {
  const supportsAxis = modelBundle !== null && (modelBundle.format === 'fbx' || modelBundle.format === 'obj');
  worldAxisToggle.hidden = !supportsAxis;
  syncActiveButton(worldAxisToggle, '[data-world-axis]', (button) => button.dataset.worldAxis === state.worldAxis);
}

// Shared sync for every model-dependent control. The model load/close and reset
// paths re-render the same cluster, so the group lives here once.
function renderModelControls(): void {
  renderUVControl();
  renderUVOverlapControl();
  renderUVWireframeControl();
  renderLodControl();
  renderSunControl();
  renderOrientationReadout();
  renderWorldAxisControl();
  renderViewToggle();
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

// Shared sync for a sun/ambient light group (color picker + chip, intensity
// slider + readout). These controls feed the lighting bake — the viewports
// carry no realtime lights — so `renderSunControl` syncs both groups through
// this one place.
function syncLightControls(
  light: LightState,
  color: HTMLInputElement,
  intensity: HTMLInputElement,
  intensityValue: HTMLOutputElement,
): void {
  color.value = light.color;
  syncColorChip(color);
  intensity.value = String(light.intensity);
  intensityValue.textContent = light.intensity.toFixed(2);
}

function renderSunControl(): void {
  sunControlElements.control.hidden = modelBundle === null || (originalPreviewMode !== '3d' && processedPreviewMode !== '3d');
  sunControlElements.orientWithCamera.disabled = originalPreviewMode !== '3d' || originalViewport === null;
  syncLightControls(state.sun, sunControlElements.color, sunControlElements.intensity, sunControlElements.intensityValue);
  syncLightControls(state.ambient, sunControlElements.ambientColor, sunControlElements.ambientIntensity, sunControlElements.ambientIntensityValue);
  syncRangeValue(sunControlElements.normalStrength, sunControlElements.normalStrengthValue, state.normalStrength, formatFixed2);
}

function updatePatternControls(): void {
  stripeAngleControl.hidden = state.mode !== 'stripes';
  noiseScaleControl.hidden = state.mode !== 'noise';
  halftoneScaleControl.hidden = state.mode !== 'halftone';
}

function updateAOControls(): void {
  syncRangeValue(aoBiasInput, aoBiasValue, Math.round(state.aoBias * 100) / 100, formatSignedFixed2);
  syncRangeValue(aoPowerInput, aoPowerValue, Math.round(state.aoPower * 100) / 100, formatFixed2);
  syncRangeValue(aoDistanceInput, aoDistanceValue, state.aoDistance, formatTimes2);
  renderLightmapControls();
}

// Shared active-state sync for button groups — every data-driven toggle in the app
// (dither modes, preview modes, palette filters, resolution presets) goes through this.
function syncActiveButton(root: ParentNode | null, selector: string, isActive: (element: HTMLElement) => boolean): void {
  root?.querySelectorAll<HTMLElement>(selector).forEach((element) => element.classList.toggle('active', isActive(element)));
}

function setActiveMode(mode: DitherMode): void {
  syncActiveButton(document, '[data-mode]', (button) => button.dataset.mode === mode);
}

function renderTextureRibbon(): void {
  for (const channel of TEXTURE_CHANNELS) {
    const slotElement = document.querySelector<HTMLElement>(`[data-texture="${channel.id}"]`);
    if (!slotElement) continue;
    // The lightmap slot previews the live implicit lightmap (auto-baked from
    // the current sun/ambient) until an explicit bake is committed to it.
    const data = channel.id === 'lightmap'
      ? textures.lightmap.image ?? renderer.getImplicitLightmapCanvas()
      : textures[channel.id].image;
    const preview = slotElement.querySelector<HTMLElement>('.texture-slot-preview');
    const label = slotElement.querySelector<HTMLElement>('.texture-slot-label');
    slotElement.classList.toggle('filled', !!data);
    slotElement.classList.toggle('disabled', !modelBundle && channel.id !== 'base');
    if (preview) {
      if (data) {
        const { canvas, context } = createCanvas(40, 34);
        context?.drawImage(data, 0, 0, 40, 34);
        preview.replaceChildren(canvas);
      } else {
        preview.innerHTML = '<span class="texture-slot-empty-mark">+</span>';
      }
    }
    if (label) label.textContent = data ? channel.label : `+${channel.label}`;
  }
  const modelSlot = document.querySelector<HTMLElement>('[data-model-slot]');
  if (modelSlot) {
    const preview = modelSlot.querySelector<HTMLElement>('.texture-slot-preview');
    const label = modelSlot.querySelector<HTMLElement>('.texture-slot-label');
    modelSlot.classList.toggle('filled', !!modelBundle);
    if (label) label.textContent = modelBundle ? modelBundle.primary.name : '+Model';
    if (preview) {
      if (modelBundle && modelThumbScene) {
        // Small rendered preview of the mesh replaces the empty-slot mark.
        // Rendered once per import — the model doesn't change between ribbon
        // refreshes, so the canvas is reused instead of re-rendering a sync
        // WebGL frame (with gl.finish + readPixels) on every refresh.
        if (!modelThumbnailCanvas) modelThumbnailCanvas = renderModelThumbnail(modelThumbScene, 40);
        preview.replaceChildren(modelThumbnailCanvas);
      } else {
        preview.innerHTML = '<span class="texture-slot-empty-mark">+</span>';
      }
    }
  }
  renderViewToggle();
}

function applyModelUV(channel: string): void {
  if (channel !== state.uvMap && lightmapIsActive(textures)) clearLightmap();
  state.uvMap = channel;
  if (aoBakeScene) {
    applyUVChannel(aoBakeScene, channel);
    invalidateModelCaches();
  }
  originalViewport?.applyUV(channel);
  processedViewport?.applyUV(channel);
  refreshUVOverlap();
  updateTexelDensity();
}

function applyModelLod(level: number): void {
  if (level !== state.lodLevel && lightmapIsActive(textures)) clearLightmap();
  state.lodLevel = level;
  forEachViewport((viewport) => viewport.applyLOD(level));
  if (aoBakeScene) {
    applyLodLevel(aoBakeScene, level);
    invalidateModelCaches();
  }
  refreshUVOverlap();
  if (state.showUVOverlap) render();
  updateTexelDensity();
}

// Sun/ambient state feeds the bake only — the 3D viewports never light the model
// in realtime. The baked lightmap (explicit or implicit) is multiplied into the
// texture by the 2D pipeline, and the viewport displays it under a neutral white
// fill; routing light state to the viewports would re-light an already-lit
// texture. See ModelViewport.
function applySun(): void {
  renderSunControl();
  renderOrientationReadout();
  scheduleImplicitLightmapBake();
}

function applyWorldAxis(): void {
  forEachViewport((viewport) => viewport.setWorldAxis(state.worldAxis));
  if (aoBakeScene) {
    aoBakeScene.rotation.set(upAxisRotation(state.worldAxis), 0, 0);
    invalidateModelCaches();
  }
  refreshUVOverlap();
}

function applyPreviewMode(): void {
  const applyPane = (mode: PreviewMode, canvas: HTMLCanvasElement, host: HTMLDivElement, toggle: HTMLDivElement): void => {
    const threeD = modelBundle !== null && mode === '3d';
    host.hidden = !threeD;
    canvas.hidden = threeD;
    toggle.hidden = modelBundle === null;
    syncActiveButton(toggle, '[data-preview-mode]', (button) => button.dataset.previewMode === mode);
  };
  applyPane(originalPreviewMode, originalCanvas, originalModelHost, originalPreviewToggle);
  applyPane(processedPreviewMode, previewCanvas, processedModelHost, processedPreviewToggle);
  renderSunControl();
  renderUVOverlapControl();
  renderUVWireframeControl();
  // The wireframe overlays mirror the panes' 2D/3D visibility.
  syncWireframeOverlays();
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
  if (modelThumbScene) {
    disposeModel(modelThumbScene);
    modelThumbScene = null;
  }
  modelThumbnailCanvas = null;
  invalidateModelCaches();
  resetPreview();
  textures.lightmap.image = null;
  textures.lightmap.name = '';
  state.viewModeOriginal = 'flat';
  state.viewModeProcessed = 'flat';
  renderLightmapControls();
  originalPreviewMode = '2d';
  processedPreviewMode = '2d';
  applyPreviewMode();
  renderModelControls();
  updateTexelDensity();
}

async function setModel(files: File[]): Promise<void> {
  let bundle: ModelFileBundle | null = null;
  try {
    bundle = createModelFileBundle(files);
    const loaded = await loadModel(bundle, files, state.worldAxis);
    closeModelPreview();
    modelBundle = bundle;
    const lodPreparation = prepareModelLods(loaded.scene);
    modelLodLevels = lodPreparation.levels;
    state.lodLevel = modelLodLevels[0] ?? 0;
    modelUVChannels = geometryUVChannels(loaded.scene);
    state.uvMap = modelUVChannels[0] ?? 'uv';
    aoBakeScene = buildAOScene(loaded.scene);
    applyLodLevel(aoBakeScene, state.lodLevel);
    refreshUVWireframe();
    renderLightmapControls();
    applyExtractedModelTextures(collectModelTextures(loaded.scene), bundle.primary.name);
    const missingReferences = bundle.manager.missing;
    if (missingReferences.length) {
      const fileLabel = missingReferences.length === 1 ? 'file' : 'files';
      console.warn(`${bundle.primary.name} references ${missingReferences.length} ${fileLabel} not included with it — skipped`);
    }
    originalViewport = new ModelViewport(originalModelHost);
    processedViewport = new ModelViewport(processedModelHost);
    originalViewport.onCameraChange = renderOrientationReadout;
    for (const viewport of [originalViewport, processedViewport]) {
      viewport.setModel(cloneModelScene(loaded.scene), loaded.animations);
    }
    forEachViewport((viewport) => viewport.applyLOD(state.lodLevel));
    applyViewNormals();
    applyViewportNormalMap();
    // Keep a clone for the ribbon's mesh thumbnail — the loaded scene is
    // disposed once the viewports hold their own clones.
    modelThumbScene = cloneModelScene(loaded.scene);
    modelThumbnailCanvas = null;
    disposeModel(loaded.scene);
    originalPreviewMode = '3d';
    processedPreviewMode = '3d';
    applyPreviewMode();
    renderModelControls();
    applySun();
    if (modelUVChannels.length) applyModelUV(state.uvMap);
    renderTextureRibbon();
    render();
    updateTexelDensity();
    bundle = null;
  } catch (error) {
    if (modelBundle === bundle) closeModelPreview();
    bundle?.revoke();
    console.error('Could not load model.', error);
  }
}

/**
 * Copies textures embedded in the imported model into the base/AO/normal slots.
 * Runs after the AO bake scene is built (so normal-map lighting re-bakes work)
 * but before the loaded scene is disposed, since the pixels are copied into
 * fresh canvases that survive texture disposal.
 */
function applyExtractedModelTextures(extracted: ExtractedModelTextures, modelName: string): void {
  const stem = modelName.replace(/\.[^.]+$/, '');
  if (extracted.base) {
    textures.base.image = extracted.base;
    textures.base.name = `${stem}_BaseColor.png`;
    updateFileMeta(extracted.base.width, extracted.base.height);
    refreshUVOverlap();
    refreshPosterizeStats();
    renderPalettes();
  }
  if (extracted.normal) {
    textures.normal.image = extracted.normal;
    textures.normal.name = `${stem}_Normal.png`;
    renderNormalControls();
    scheduleNormalAdjustedLighting();
  }
  if (extracted.ao) {
    textures.ao.image = extracted.ao;
    textures.ao.name = `${stem}_AO.png`;
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
  customPaletteSection.hidden = state.paletteFilter !== 'custom';
  document.querySelector('#paletteCount')!.textContent = `${Object.keys(catalog).length} PRESETS`;
  const visiblePalettes = Object.entries(catalog).filter(([, palette]) => palette.category === state.paletteFilter);
  const customKeys = new Set(savedCustomPalettes.map((palette) => palette.key));
  paletteGrid.innerHTML = visiblePalettes.map(([key, palette]) => `
    <div class="palette-card ${key === state.paletteKey && state.customColors.length === 0 ? 'active' : ''}" data-palette="${escapeHtml(key)}" role="button" tabindex="0" aria-label="${escapeHtml(palette.name)}, ${palette.colors.length} colors">
      <span class="mini-swatches">${representativeColors(palette.colors).map((color) => `<i style="--swatch:${color}"></i>`).join('')}</span>
      <span class="palette-card-label"><span>${escapeHtml(palette.name)}</span><b>${palette.colors.length}</b><span class="palette-card-actions">
        <button type="button" class="icon-button palette-card-duplicate" data-duplicate-palette="${escapeHtml(key)}" aria-label="Duplicate ${escapeHtml(palette.name)}" title="Duplicate ${escapeHtml(palette.name)}"><svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><rect x="5" y="5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="2" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button>
        ${customKeys.has(key) ? `
          <button type="button" class="icon-button palette-card-export" data-export-palette="${escapeHtml(key)}" aria-label="Export ${escapeHtml(palette.name)}" title="Export ${escapeHtml(palette.name)}">${DOWNLOAD_ICON_SVG}</button>
          <button type="button" class="icon-button palette-card-delete" data-delete-palette="${escapeHtml(key)}" aria-label="Delete ${escapeHtml(palette.name)}">×</button>` : ''}
      </span></span>
    </div>
  `).join('') + (state.paletteFilter === 'custom' ? `
    <button type="button" class="palette-card palette-card-new" data-new-palette aria-label="Create new palette">
      <span class="palette-card-new-icon">+</span>
      <span class="palette-card-new-label">Create new palette</span>
    </button>
    <button type="button" class="palette-card palette-card-new" data-import-palette aria-label="Import palette">
      <span class="palette-card-new-icon">${IMPORT_ICON_SVG}</span>
      <span class="palette-card-new-label">Import palette</span>
    </button>
  ` : '');
  const selectedColors = currentColors();
  customColors.innerHTML = selectedColors.map((color, index) => `
    <div class="custom-color ${index === activeColorIndex ? 'active' : ''}">
      <label title="Edit ${color}">${colorControl(color, `Color ${index + 1}, ${color}`, `data-color-index="${index}"`)}</label>
      <button type="button" class="icon-button" data-remove-color="${index}" aria-label="Remove color ${index + 1}">×</button>
    </div>
  `).join('') + `
    <button type="button" class="custom-color-add" data-add-color aria-label="Add color">+</button>
  `;
  paletteEditor.disabled = !activePaletteIsCustom();
  syncColorPicker();
}

// Single slider generator — every range control in the app goes through this.
// Renders a .control-row (title + optional hint + output) above a .range input.
function rangeControl(key: string, label: string, min: number, max: number, step: number | 'any', value: number, display: string = String(value), hint = ''): string {
  return `
    <div class="control-row">
      <label for="${key}"><span><strong>${label}</strong>${hint ? `<small>${hint}</small>` : ''}</span><output id="${key}Value">${display}</output></label>
      <input class="range" id="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}" />
    </div>
  `;
}

// Single color-picker generator — visually-hidden input + live --swatch chip, matching the palette editor.
// Every color input in the app goes through this; syncColorChip keeps the chip in lockstep with the value.
function colorControl(value: string, ariaLabel: string, attrs: string = ''): string {
  return `<input class="hidden-input" type="color" value="${value}" aria-label="${ariaLabel}" ${attrs}/><span class="color-chip" style="--swatch:${value}"></span>`;
}
function syncColorChip(input: HTMLInputElement): void {
  input.nextElementSibling?.setAttribute('style', `--swatch:${input.value}`);
}

// Single toggle-switch generator — every checkbox toggle in the app goes through
// this. `wrapper` is 'label' when the switch is the whole control (AO-only /
// lightmap-only, preserving label click-to-toggle) and 'span' when nested inside
// a label row (UV / normals controls).
function toggleControl(id: string, ariaLabel: string, checked = false, wrapper: 'label' | 'span' = 'span', title = ''): string {
  const attrs = `class="toggle"${title ? ` title="${title}"` : ''}`;
  return `<${wrapper} ${attrs}><input id="${id}" type="checkbox"${checked ? ' checked' : ''} aria-label="${ariaLabel}" /></${wrapper}>`;
}

function renderAdjustments(): void {
  const controls: Array<[keyof Pick<State, 'brightness' | 'contrast' | 'saturation'>, string]> = [
    ['brightness', 'Brightness'], ['contrast', 'Contrast'], ['saturation', 'Saturation'],
  ];
  document.querySelector('#adjustmentControls')!.innerHTML = controls.map(([key, label]) =>
    rangeControl(key, label, -100, 100, 1, state[key], `${state[key] > 0 ? '+' : ''}${state[key]}`),
  ).join('');
}

function hydrateCustomDraft(name: string, colors: string[], key: string | null = null): void {
  editingCustomKey = key;
  customPaletteName.value = name;
  state.customColors = [...colors];
  state.paletteSnapshot = {
    name: name || 'Untitled Custom Palette',
    category: 'custom',
    colors: [...colors],
  };
}

function beginCustomDraft(name: string, colors: string[], key: string | null = null): void {
  hydrateCustomDraft(name, colors, key);
  renderPalettes();
  render();
}

// Hydrate the draft state WITHOUT re-rendering the palette rows: re-rendering would replace the
// <input type="color"> the user is currently editing, detaching it so the picker's trailing
// 'change' event never bubbles to the customColors listener and the edit is never persisted.
function ensureCustomDraft(): void {
  if (state.customColors.length > 0) return;
  const selectedCustom = customPaletteByKey(state.paletteKey);
  if (selectedCustom) hydrateCustomDraft(selectedCustom.name, selectedCustom.colors, selectedCustom.key);
  else hydrateCustomDraft(`${currentPalette().name} Copy`, currentPalette().colors);
}

function persistCustomDraft(): void {
  try {
    const existing = customPaletteByKey(editingCustomKey);
    const palette = existing
      ? updateCustomPalette(existing, customPaletteName.value, currentColors())
      : createCustomPalette(customPaletteName.value, currentColors(), new Date(), editingCustomKey ?? undefined);
    savedCustomPalettes = upsertCustomPalette(localStorage, palette);
    setPaletteKey(palette.key);
    hydrateEditorForSelection(palette.key, palette);
    renderPalettes();
    render();
  } catch (error) {
    console.error('Could not save custom palette.', error);
  }
}

function createNewPalette(): void {
  beginCustomDraft('New Palette', ['#000000', '#ffffff']);
  persistCustomDraft();
}

function revealPalette(key: string): void {
  state.paletteFilter = 'custom';
  syncActiveButton(paletteFilters, '[data-filter]', (button) => button.dataset.filter === state.paletteFilter);
  renderPalettes();
  requestAnimationFrame(() => {
    const card = paletteGrid.querySelector<HTMLElement>(`[data-palette="${key}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    card?.focus({ preventScroll: true });
  });
}

function duplicatePaletteByKey(key: string): void {
  const source = paletteCatalog()[key];
  // Posterize is adaptive — duplicating it copies the *generated* colors as a
  // normal custom palette, snapshotting the ramp derived from the current
  // BaseColor so it stays fixed even if the texture changes later.
  if (!source) return;
  const duplicate = duplicatePalette(source);
  beginCustomDraft(duplicate.name, duplicate.colors, duplicate.key);
  persistCustomDraft();
  if (state.paletteKey === duplicate.key) revealPalette(duplicate.key);
}

function exportPaletteByKey(key: string): void {
  try {
    const palette = customPaletteByKey(key);
    if (!palette) return;
    const safeName = safeFileName(palette.name, 'custom-palette');
    downloadText(serializeCustomPalette(palette), `${safeName}.palette.json`);
  } catch (error) {
    console.error('Could not export custom palette.', error);
  }
}

// Shared editor-field sync for the currently selected palette: picks the
// matching custom palette (if any) and hydrates the draft name, falling back
// to the catalog palette's own value.
function hydrateEditorForSelection(paletteKey: string, fallback: Palette): void {
  const selectedCustom = customPaletteByKey(paletteKey);
  editingCustomKey = selectedCustom?.key ?? null;
  customPaletteName.value = selectedCustom?.name ?? fallback.name;
}

function selectPalette(key: string): void {
  setPaletteKey(key);
  hydrateEditorForSelection(key, currentPalette());
  renderPalettes();
  render();
}

function removeCustomPalette(key: string): void {
  try {
    savedCustomPalettes = deleteCustomPalette(localStorage, key);
    if (editingCustomKey === key) editingCustomKey = null;
    if (state.paletteKey === key) {
      setPaletteKey('desert');
      customPaletteName.value = '';
    }
    renderPalettes();
    render();
  } catch (error) {
    console.error('Could not delete custom palette.', error);
  }
}

function activePaletteSnapshot() {
  const base = currentPalette();
  return {
    ...base,
    name: state.customColors.length ? `${base.name} Custom` : base.name,
    colors: [...currentColors()],
  };
}

type RangeBinding = {
  input: HTMLInputElement;
  output: HTMLElement;
  format: (value: number) => string;
  apply: (value: number) => void;
};

// Shared render-side sync for a range input + its value output — the mirror of
// `bindRange` (listener side). Every control render that writes both fields in
// lockstep goes through this.
function syncRangeValue(input: HTMLInputElement, output: HTMLElement, value: number, format: (value: number) => string): void {
  input.value = String(value);
  output.textContent = format(value);
}

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
  syncRangeValue(strengthInput, strengthValue, Math.round(state.strength * 100), formatPercent);
  syncRangeValue(stripeAngleInput, stripeAngleValue, state.stripeAngle, formatDegrees);
  syncRangeValue(noiseScaleInput, noiseScaleValue, state.noiseScale, formatPixels);
  syncRangeValue(halftoneScaleInput, halftoneScaleValue, state.halftoneScale, formatTimes2);
  syncRangeValue(seedInput, seedValue, state.seed, formatPlain);
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
  await applyPreset(parsePreset(await file.text()));
}

function currentConfig() {
  return {
    ...collectConfigValues(state),
    paletteKey: state.paletteKey,
    palette: activePaletteSnapshot(),
    uvMap: state.uvMap,
    cameraDirection: originalViewport ? originalViewport.getCameraForward() : state.cameraDirection,
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
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    console.error('Could not save settings.', error);
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
    console.error('Could not load settings.', error);
  }
}

async function applyPreset(preset: ConversionPreset): Promise<void> {
  renderScheduler.cancel();
  const paletteSelection = selectOrCreatePalette(localStorage, paletteCatalog(), preset.palette, preset.paletteKey);
  const paletteKey = paletteSelection.key;
  savedCustomPalettes = paletteSelection.customPalettes;
  applyConfigValues(state, preset as unknown as Readonly<Record<string, unknown>>);
  setPaletteKey(paletteKey);
  state.uvMap = preset.uvMap;
  const selectedPalette = paletteCatalog()[paletteKey];
  hydrateEditorForSelection(paletteKey, selectedPalette);
  syncControlsFromState();
  applyViewportNormalMap();
  applySun();
  if (modelBundle) {
    forEachViewport((viewport) => viewport.setCameraForward(state.cameraDirection));
  }
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
  wireframeOverlays: {
    original: originalWireframeOverlay,
    processed: processedWireframeOverlay,
  },
  getAOScene: () => aoBakeScene,
  forEachViewport,
  getOriginalViewport: () => originalViewport,
  getProcessedViewport: () => processedViewport,
  getOriginalPreviewMode: () => originalPreviewMode,
  getProcessedPreviewMode: () => processedPreviewMode,
  dimensions,
  currentColors,
  updatePreviewBadge,
  renderLightmapControls,
  renderNormalControls,
  renderTextureRibbon,
  applySun,
  onAoProgress: setAoBakeProgress,
});

const {
  render,
  generateAo,
  bakeLighting,
  clearLightmap,
  reengageImplicitLightmap,
  scheduleImplicitLightmapBake,
  scheduleNormalAdjustedLighting,
  refreshUVWireframe,
  refreshUVOverlap,
  invalidateBakeScene,
  invalidateUVOverlap,
  syncWireframeOverlays,
  resetPreview,
} = renderer;

// AO bakes rasterize the texture in worker bands — a centered progress card
// keeps the wait visible while bands finish. The wrapper guarantees the
// overlay hides on success AND failure.
function setAoBakeProgress(percent: number): void {
  aoBakeFill.style.width = `${percent}%`;
  aoBakePercent.textContent = `${percent}%`;
}

function showAoBakeOverlay(): void {
  setAoBakeProgress(0);
  aoBakeOverlay.hidden = false;
}

function hideAoBakeOverlay(): void {
  aoBakeOverlay.hidden = true;
}

async function generateAoWithProgress(): Promise<boolean> {
  showAoBakeOverlay();
  try {
    return await generateAo();
  } finally {
    hideAoBakeOverlay();
  }
}

// Single source of truth for which texture channels have a one-click bake and
// the action behind it — used by the slot Bake buttons and the download path.
const bakeActions: Partial<Record<TextureChannelId, () => Promise<boolean>>> = {
  ao: generateAoWithProgress,
  lightmap: bakeLighting,
};

const renderScheduler = createRenderScheduler(render);

function updateResolution(value: number, immediate = false): void {
  state.resolution = value;
  syncRangeValue(document.querySelector('#resolution') as HTMLInputElement, document.querySelector('#resolutionValue')!, value, formatPixels);
  syncActiveButton(document, '[data-resolution]', (button) => Number(button.dataset.resolution) === value);
  if (immediate) renderScheduler.flush();
  else renderScheduler.request();
  // The dithered size drives the AO/lightmap bake size, so a change re-bakes
  // the implicit lightmap at the new resolution (debounced in the scheduler).
  scheduleImplicitLightmapBake();
  // The processed viewport's normals view pixelizes the map to this size.
  applyViewportNormalMap();
  updateTexelDensity();
}

function textureLabel(channel: TextureChannelId): string {
  return TEXTURE_CHANNELS.find((entry) => entry.id === channel)?.label ?? 'Texture';
}

function updateFileMeta(width: number, height: number): void {
  document.querySelector('#sourceDimensions')!.textContent = formatDimensions(width, height);
}

/**
 * Recomputes the posterize stats from the current BaseColor texture. The
 * texture is downsampled to at most 64×64 first, so the histogram pass stays
 * cheap even for 2K sources; callers re-render the palette library and the
 * output so the adaptive ramps update live.
 */
function refreshPosterizeStats(): void {
  const image = textures.base.image;
  if (!image || image.width === 0 || image.height === 0) {
    posterizeStats = null;
    return;
  }
  const scale = Math.min(1, POSTERIZE_SAMPLE_MAX / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const { context } = drawImageToCanvas(image, width, height);
  if (!context) {
    posterizeStats = null;
    return;
  }
  posterizeStats = computePosterizeStats(context.getImageData(0, 0, width, height));
}

function clearTexture(channel: TextureChannelId): void {
  if (channel === 'base') {
    if (lightmapIsActive(textures)) clearLightmap();
    textures.base.image = sample;
    textures.base.name = 'sample-landscape.png';
    updateFileMeta(sample.width, sample.height);
    refreshUVOverlap();
    updateTexelDensity();
    refreshPosterizeStats();
    renderPalettes();
  } else if (channel === 'lightmap') {
    // The slot X is a hard remove: drop the live implicit bake too and stay
    // unlit (pure-white lightmap) until the user explicitly bakes or loads one.
    clearLightmap(true);
    return;
  } else {
    textures[channel].image = null;
    textures[channel].name = '';
    if (channel === 'ao') {
      if (state.viewModeOriginal === 'ao') state.viewModeOriginal = 'flat';
      if (state.viewModeProcessed === 'ao') state.viewModeProcessed = 'flat';
    }
    if (channel === 'normal') {
      renderNormalControls();
      scheduleNormalAdjustedLighting();
      applyViewportNormalMap();
    }
  }
  renderTextureRibbon();
  render();
}

function clearModel(): void {
  renderScheduler.cancel();
  closeModelPreview();
  const base = textures.base.image!;
  updateFileMeta(base.width, base.height);
  renderTextureRibbon();
  render();
}

async function setTexture(channel: TextureChannelId, file: File): Promise<void> {
  if (!file.type.startsWith('image/')) {
    return;
  }
  try {
    const image = await loadImageFile(file);
    renderScheduler.cancel();
    if (channel === 'base' && lightmapIsActive(textures)) clearLightmap();
    if (channel === 'lightmap') {
      const baseColor = textures.base.image!;
      if (!lightmapMatchesBaseColor(image, baseColor)) {
        throw new Error(`Lightmap must match BaseColor: expected ${baseColor.width} × ${baseColor.height}, received ${image.width} × ${image.height}.`);
      }
    }
    textures[channel].image = image;
    textures[channel].name = file.name;
    if (channel === 'base') {
      updateFileMeta(image.width, image.height);
      refreshUVOverlap();
      updateTexelDensity();
      refreshPosterizeStats();
      renderPalettes();
    }
    if (channel === 'lightmap') {
      renderLightmapControls();
      renderNormalControls();
      applySun();
    }
    if (channel === 'normal') {
      renderNormalControls();
      scheduleNormalAdjustedLighting();
      applyViewportNormalMap();
    }
    renderTextureRibbon();
    render();
  } catch (error) {
    console.error('Could not load image.', error);
  }
}

function reset(): void {
  renderScheduler.cancel();
  Object.assign(state, defaultState(), { paletteSnapshot: undefined });
  textures.lightmap.image = null;
  textures.lightmap.name = '';
  // Full reset is a fresh start: re-engage the implicit lightmap preview and
  // drop any cached render state.
  resetPreview();
  invalidateModelCaches();
  renderTextureRibbon();
  editingCustomKey = null;
  customPaletteName.value = '';
  syncControlsFromState();
  scheduleNormalAdjustedLighting();
  applySun();
  refreshUVOverlap();
  renderModelControls();
  applyViewNormals();
  applyViewportNormalMap();
  updateResolution(128, true);
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
    await setModel([baseColor, normal, model]);
  } catch (error) {
    console.error('Example assets could not be loaded; using the sample texture.', error);
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
  input: halftoneScaleInput,
  output: halftoneScaleValue,
  format: formatTimes2,
  apply: (value) => { state.halftoneScale = value; },
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
  input: aoPowerInput,
  output: aoPowerValue,
  format: formatFixed2,
  apply: (value) => { state.aoPower = Math.round(value * 100) / 100; },
});
bindRange({
  input: aoDistanceInput,
  output: aoDistanceValue,
  format: formatTimes2,
  apply: (value) => { state.aoDistance = value; },
});
normalFormatToggle.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-normal-format]');
  if (!button?.dataset.normalFormat || button.disabled) return;
  state.normalFormat = button.dataset.normalFormat as NormalFormat;
  syncActiveButton(normalFormatToggle, '[data-normal-format]', (candidate) => candidate.dataset.normalFormat === state.normalFormat);
  scheduleNormalAdjustedLighting();
  applyViewportNormalMap();
});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  state.mode = button.dataset.mode as DitherMode;
  setActiveMode(state.mode);
  updatePatternControls();
  render();
}));
paletteFilters.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (!button?.dataset.filter) return;
  state.paletteFilter = button.dataset.filter as PaletteCategory;
  syncActiveButton(paletteFilters, 'button', (item) => item === button);
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
// The native color picker is replaced by the in-app picker above the chip row:
// suppress the hidden inputs' default actions (mouse and keyboard) so the OS
// dialog never opens — the chips just select the color being edited.
customColors.addEventListener('keydown', (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[type="color"]');
  if (input && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
});
customColors.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest<HTMLButtonElement>('[data-add-color]')) {
    ensureCustomDraft();
    if (state.customColors.length >= 256) return;
    state.customColors.push('#ffffff');
    activeColorIndex = state.customColors.length - 1;
    state.paletteSnapshot = activePaletteSnapshot();
    persistCustomDraft();
    return;
  }
  const chip = target.closest<HTMLElement>('.color-chip');
  if (chip) {
    // Suppress the hidden input's default action (opening the OS picker) —
    // the in-app picker above the chips is the editor now.
    event.preventDefault();
    const index = Number((chip.previousElementSibling as HTMLInputElement | null)?.dataset.colorIndex);
    if (Number.isInteger(index)) selectActiveColor(index);
    return;
  }
  const button = target.closest<HTMLButtonElement>('[data-remove-color]');
  if (!button) return;
  ensureCustomDraft();
  if (state.customColors.length <= 2) return;
  state.customColors.splice(Number(button.dataset.removeColor), 1);
  if (activeColorIndex >= state.customColors.length) activeColorIndex = Math.max(0, state.customColors.length - 1);
  state.paletteSnapshot = activePaletteSnapshot();
  persistCustomDraft();
});
// The gradient picker edits whichever chip is active: click/drag in the
// saturation×value field or on the hue strip applies the color live;
// releasing persists. The hex field still accepts direct input.
function syncColorPicker(): void {
  const colors = currentColors();
  if (activeColorIndex >= colors.length) activeColorIndex = Math.max(0, colors.length - 1);
  syncPickerToColor(colors[activeColorIndex] ?? '#ffffff');
}

// Keep the saturation×value square tinted with the current hue. There are no
// overlay indicators (dot/line) — the field and strip themselves are the UI.
function updatePickerFieldHue(): void {
  colorPickerField.style.setProperty('--field-hue', rgbToHex(...hsvToRgb(pickerHsv[0], 100, 100)));
}

// Read a color into the picker in HSV space, carrying the last hue over when
// the color is achromatic (white/black/gray) so it isn't lost at the
// pure-white corner. Always reason in HSV — never reconstruct hue from RGB.
function syncPickerToColor(hex: string): void {
  colorPickerSwatch.style.setProperty('--swatch', hex);
  colorPickerHex.value = hex;
  const [h, s, v] = rgbToHsv(...hexToRgb(hex));
  pickerHsv = s > 0 && v > 0 ? [h, s, v] : [pickerHsv[0], s, v];
  updatePickerFieldHue();
}

function selectActiveColor(index: number): void {
  activeColorIndex = index;
  customColors.querySelectorAll('.custom-color').forEach((row, rowIndex) => row.classList.toggle('active', rowIndex === index));
  syncColorPicker();
}

function applyPickerColor(hex: string): void {
  ensureCustomDraft();
  const index = activeColorIndex;
  state.customColors[index] = hex;
  const input = customColors.querySelector<HTMLInputElement>(`input[data-color-index="${index}"]`);
  if (input) {
    input.value = hex;
    input.setAttribute('aria-label', `Color ${index + 1}, ${hex}`);
    syncColorChip(input);
  }
  syncPickerToColor(hex);
  state.paletteSnapshot = activePaletteSnapshot();
  renderScheduler.request();
}

// The gradient field is a click-and-drag saturation×value square for the
// selected hue; the strip sets the hue.
function pickFromField(clientX: number, clientY: number): void {
  const rect = colorPickerField.getBoundingClientRect();
  const sat = ((clientX - rect.left) / rect.width) * 100;
  const value = 100 - ((clientY - rect.top) / rect.height) * 100;
  applyPickerColor(rgbToHex(...hsvToRgb(pickerHsv[0], sat, value)));
}

function pickFromHue(clientY: number): void {
  const rect = colorPickerHue.getBoundingClientRect();
  pickerHsv = [((clientY - rect.top) / rect.height) * 360, pickerHsv[1], pickerHsv[2]];
  applyPickerColor(rgbToHex(...hsvToRgb(...pickerHsv)));
}

// The drag listens on window-level pointer events (no capture), so every move
// reaches the picker even when the pointer leaves the field or strip.
let pickerDrag: 'field' | 'hue' | null = null;

colorPickerField.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  pickerDrag = 'field';
  pickFromField(event.clientX, event.clientY);
});
colorPickerHue.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  pickerDrag = 'hue';
  pickFromHue(event.clientY);
});
window.addEventListener('pointermove', (event) => {
  if (!pickerDrag) return;
  if (!(event.buttons & 1)) {
    // A pointerup was missed (button released outside the window): end the drag.
    pickerDrag = null;
    persistCustomDraft();
    return;
  }
  if (pickerDrag === 'field') pickFromField(event.clientX, event.clientY);
  else pickFromHue(event.clientY);
});
window.addEventListener('pointerup', () => {
  if (!pickerDrag) return;
  pickerDrag = null;
  persistCustomDraft();
});
colorPickerHex.addEventListener('change', () => {
  const value = colorPickerHex.value.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    applyPickerColor(value.toLowerCase());
    syncColorPicker();
    persistCustomDraft();
  } else {
    syncColorPicker();
  }
});
// The button under the hue bar is an eyedropper. The native EyeDropper API
// samples anywhere on screen, but its picker takes ~1s to appear in
// Chromium/WebView2 (browser-internal startup, not fixable from JS). Instead
// we run a custom pick mode: the OS cursor itself becomes the dropper icon
// and sampling the app's own rendering is instant — exact pixels from the
// preview canvases, solid fills elsewhere. Click applies, Escape / right-click
// cancels.
let eyedropperActive = false;

function eyedropperCancel(): void {
  if (!eyedropperActive) return;
  eyedropperActive = false;
  document.body.classList.remove('eyedropping');
  document.body.style.removeProperty('--eyedropper-cursor');
  window.removeEventListener('pointerdown', eyedropperPick, true);
  window.removeEventListener('keydown', eyedropperKey);
}

function eyedropperPick(event: PointerEvent): void {
  if (event.button !== 0) {
    // Right/middle click cancels.
    eyedropperCancel();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const hex = sampleColorAt(event.clientX, event.clientY);
  eyedropperCancel();
  if (hex) applyPickerColor(hex);
}

function eyedropperKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') eyedropperCancel();
}

colorPickerButton.addEventListener('click', () => {
  if (eyedropperActive) return;
  eyedropperActive = true;
  document.body.style.setProperty('--eyedropper-cursor', EYEDROPPER_CURSOR);
  document.body.classList.add('eyedropping');
  window.addEventListener('pointerdown', eyedropperPick, true);
  window.addEventListener('keydown', eyedropperKey);
});
customPaletteName.addEventListener('change', persistCustomDraft);

const importCustomPaletteInput = document.querySelector<HTMLInputElement>('#importCustomPalette')!;
importCustomPaletteInput.addEventListener('change', async () => {
  const file = importCustomPaletteInput.files?.[0];
  if (!file) return;
  try {
    if (file.size > 100_000) throw new Error('Palette file is too large.');
    const palette = paletteFromImport(await file.text(), file.name);
    savedCustomPalettes = upsertCustomPalette(localStorage, palette);
    state.paletteKey = palette.key;
    beginCustomDraft(palette.name, palette.colors, palette.key);
  } catch (error) {
    console.error('Could not import palette.', error);
  } finally {
    importCustomPaletteInput.value = '';
  }
});

function pickTextureFromSlot(slot: HTMLElement): void {
  if (slot.classList.contains('disabled')) {
    return;
  }
  pendingTextureChannel = slot.dataset.texture as TextureChannelId;
  textureInput.click();
}

// Saves the slot's current image to disk. Loaded files are re-drawn onto a
// canvas so every slot downloads as a PNG through the shared `downloadCanvas`.
function saveSlotImage(image: SourceImage, name: string): void {
  const canvas = image instanceof HTMLCanvasElement ? image : drawImageToCanvas(image, image.width, image.height).canvas;
  downloadCanvas(canvas, name);
}

function downloadSlotImage(channel: TextureChannelId): void {
  const data = textures[channel];
  const name = `${safeFileName(textureLabel(channel))}.png`;
  if (data.image) {
    saveSlotImage(data.image, name);
    return;
  }
  // AO and lightmap can be generated in-app — bake on demand, then download.
  // The bake path reports its own failures, so a false result is a no-op.
  const baked = bakeActions[channel]?.() ?? null;
  if (!baked) return;
  void baked.then((ok) => {
    if (!ok) return;
    const image = textures[channel].image;
    if (!image) return;
    saveSlotImage(image, name);
  });
}

textureRibbon.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const downloadButton = target.closest<HTMLButtonElement>('[data-download-texture]');
  if (downloadButton?.dataset.downloadTexture) {
    downloadSlotImage(downloadButton.dataset.downloadTexture as TextureChannelId);
    return;
  }
  if (target.closest('[data-clear-model]')) {
    clearModel();
    return;
  }
  const clearButton = target.closest<HTMLButtonElement>('[data-clear-texture]');
  if (clearButton?.dataset.clearTexture) {
    clearTexture(clearButton.dataset.clearTexture as TextureChannelId);
    return;
  }
  const bakeButton = target.closest<HTMLButtonElement>('[data-bake-texture]');
  if (bakeButton?.dataset.bakeTexture) {
    bakeActions[bakeButton.dataset.bakeTexture as TextureChannelId]?.();
    return;
  }
  if (target.closest('[data-normal-format]')) return;
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
function droppedFiles(event: DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? []);
}

// Drag highlight, owned document-wide with a single "active" slot so the
// white outline always tracks the slot actually under the pointer.
// dragenter/dragover (which bubble from slot children — including the
// thumbnail canvases of already-filled slots) re-derive the hovered slot from
// event.target, and any dragenter/dragover over a non-slot area drops the
// highlight. dragleave is deliberately NOT listened to anywhere: it bubbles,
// so a document-level dragleave fires on every child-boundary crossing, and
// its relatedTarget is unreliable over GPU-composited canvases — that pair is
// what kept clearing the outline on filled slots. With no dragleave handler,
// nothing can remove the highlight while the pointer is over any part of a
// slot; it clears only when the drag moves over a non-slot area, on drop, or
// on mouseup (drag cancelled/released).
let activeDragSlot: HTMLElement | null = null;
function highlightDragSlot(slot: HTMLElement): void {
  if (activeDragSlot === slot) return;
  activeDragSlot?.classList.remove('dragging');
  activeDragSlot = slot;
  slot.classList.add('dragging');
}
function clearDragHighlight(): void {
  activeDragSlot?.classList.remove('dragging');
  activeDragSlot = null;
}
function slotUnderDrag(event: Event): HTMLElement | null {
  const target = event.target;
  return target instanceof Element ? target.closest<HTMLElement>('.texture-slot') : null;
}
// Accept the drop everywhere (capture phase): preventDefault on dragover for
// the whole document marks the window as a drop target, so the drop event
// always fires and its default action — navigating to the dropped file — is
// reliably cancelable. Without this, drops on non-slot areas fall through to
// the engine's own default, which opens the file even if `drop` is canceled.
// Disabled slots are exempt so the browser keeps its no-drop cursor on them.
document.addEventListener('dragover', (event) => {
  const slot = slotUnderDrag(event);
  if (slot && slot.classList.contains('disabled')) return;
  event.preventDefault();
}, true);

['dragenter', 'dragover'].forEach((type) => document.addEventListener(type, (event) => {
  // A drag is over the window: dim the non-drop areas (see body.drag-active).
  document.body.classList.add('drag-active');
  const slot = slotUnderDrag(event);
  if (!slot || slot.classList.contains('disabled')) {
    // Pointer over a non-slot or disabled slot: drop any stale highlight.
    clearDragHighlight();
    return;
  }
  event.preventDefault();
  highlightDragSlot(slot);
}));
// Drops are neutralized everywhere: dropping a file on any non-slot area must
// never navigate the webview to that file (the browser's default action is to
// open it). A capture-phase guard preventDefaults before anything else in the
// page can act; the bubble-phase handler below clears the drag UI state.
document.addEventListener('drop', (event) => event.preventDefault(), true);
// mouseup best-effort clears the drag state left by a drag cancelled outside
// the window (self-heals next drag).
function endDragState(): void {
  clearDragHighlight();
  document.body.classList.remove('drag-active');
}
document.addEventListener('mouseup', endDragState);
document.addEventListener('drop', (event) => {
  event.preventDefault();
  endDragState();
});

TEXTURE_CHANNELS.forEach((channel) => {
  const slot = document.querySelector<HTMLElement>(`[data-texture="${channel.id}"]`);
  if (!slot) return;
  slot.addEventListener('drop', (event) => {
    if (slot.classList.contains('disabled')) return;
    const files = droppedFiles(event);
    const image = files.find((file) => file.type.startsWith('image/'));
    if (image) void setTexture(channel.id, image);
  });
});
const modelSlot = document.querySelector<HTMLElement>('[data-model-slot]');
if (modelSlot) {
  modelSlot.addEventListener('drop', (event) => {
    const files = droppedFiles(event);
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
worldAxisToggle.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-world-axis]');
  if (!button?.dataset.worldAxis) return;
  state.worldAxis = button.dataset.worldAxis as WorldAxis;
  syncActiveButton(worldAxisToggle, '[data-world-axis]', (candidate) => candidate.dataset.worldAxis === state.worldAxis);
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
  syncWireframeOverlays();
});
function bindSunControl(): void {
  sunControlElements.orientWithCamera.addEventListener('click', () => {
    if (!originalViewport || originalPreviewMode !== '3d') return;
    state.sun.direction = originalViewport.getCameraForward();
    // Orient-with-camera always (re)generates a lightmap: re-engage the live
    // implicit bake after a slot clear, or re-bake an explicit lightmap so it
    // follows the new direction.
    if (lightmapIsActive(textures)) {
      void bakeLighting();
    } else {
      reengageImplicitLightmap();
      applySun();
    }
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

  bindLightColor(sunControlElements.color, state.sun);
  bindLightIntensity(sunControlElements.intensity, state.sun);
  bindLightColor(sunControlElements.ambientColor, state.ambient);
  bindLightIntensity(sunControlElements.ambientIntensity, state.ambient);
  // Normal-map strength is part of the lighting bake — the same path as the
  // ribbon's GL/DX toggle — so a change re-bakes the implicit lightmap and
  // live-updates the Normals-view showcase uniform (no texture rebuild).
  bindRange({
    input: sunControlElements.normalStrength,
    output: sunControlElements.normalStrengthValue,
    format: formatFixed2,
    apply: (value) => {
      state.normalStrength = Math.round(value * 100) / 100;
      scheduleNormalAdjustedLighting();
      originalViewport?.setNormalStrength(state.normalStrength);
      processedViewport?.setNormalStrength(state.normalStrength);
    },
  });
}

bindSunControl();

// Preview view enum (Combined / BaseColor / Normals / AO / Lightmap) — a single segmented
// control on the Original pane that drives both preview panes. Normals drives
// each pane's 3D viewport; AO/Lightmap swap the source in both previews.
function bindViewToggle(toggle: HTMLDivElement, getView: () => PreviewViewMode, setView: (view: PreviewViewMode) => void): void {
  toggle.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!button?.dataset.view) return;
    const view = button.dataset.view as PreviewViewMode;
    if (getView() === view) return;
    setView(view);
    applyViewMode();
  });
}
function applyViewMode(): void {
  renderViewToggle();
  applyViewNormals();
  render();
}
bindViewToggle(originalViewToggle, () => state.viewModeOriginal, (view) => {
  state.viewModeOriginal = view;
  state.viewModeProcessed = view;
});
loadConfigInput.addEventListener('change', async () => {
  const file = loadConfigInput.files?.[0];
  loadConfigInput.value = '';
  if (!file) return;
  try {
    await applyConfigFile(file);
  } catch (error) {
    console.error('Could not load settings.', error);
  }
});
document.querySelector('#saveButton')!.addEventListener('click', saveConfig);
document.querySelector('#loadButton')!.addEventListener('click', loadConfig);
document.querySelector('#resetButton')!.addEventListener('click', reset);
// Export filenames end with the current view mode, spelled for filenames:
// Combined / BaseColor / Normal / AO / Lightmap / LightmapAO — same vocabulary
// as the view toggle, minus its punctuation.
const EXPORT_VIEW_SUFFIX: Record<PreviewViewMode, string> = {
  flat: 'Combined',
  basecolor: 'BaseColor',
  normals: 'Normal',
  ao: 'AO',
  lightmap: 'Lightmap',
  'lightmap-ao': 'LightmapAO',
};
document.querySelector('#exportButton')!.addEventListener('click', () => {
  // Flush the debounced render first so the export always matches what the
  // processed pane currently shows for the selected view mode.
  renderScheduler.flush();
  // <model base name without suffix>_<view mode>.png — the model's name when a
  // model is loaded, otherwise the base texture's name (both sans extension).
  const stem = modelBundle
    ? modelBundle.primary.name.replace(/\.[^.]+$/, '')
    : textures.base.name.replace(/\.[^.]+$/, '');
  const rendered = renderer.getRenderedCanvas();
  downloadCanvas(rendered, `${safeFileName(stem)}_${EXPORT_VIEW_SUFFIX[state.viewModeProcessed]}.png`);
});

// External links (GitHub repo, Ko-fi support) use target="_blank", which the
// Tauri webview ignores — route them through the opener plugin so they open
// in the system browser; the web build falls back to a new tab.
document.addEventListener('click', (event) => {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[target="_blank"][href^="http"]');
  if (!anchor) return;
  event.preventDefault();
  void openExternalLink(anchor.href).catch((error) => console.error('Could not open link.', error));
});
