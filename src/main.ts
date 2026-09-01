import './style.css';
import { computeOutputDimensions, createCanvas, createSampleTexture, downloadCanvas, downloadText, drawImageToCanvas, loadImageFile, resampleAndPixelate, type UpscaleMethod } from './lib/canvas';
import { clamp } from './lib/math';
import { CONFIG_FOLDER, disableWebviewContextMenu, initTauriFileStore, openExternalLink, type TauriFileStore } from './lib/tauri';
import { CUSTOM_PALETTE_STORAGE_KEY, createCustomPalette, deleteCustomPalette, deleteCustomPaletteFile, duplicatePalette, filePaletteFor, isCustomPalette, loadCustomPalettes, loadCustomPalettesFromFiles, matchingPaletteKey, paletteFileName, paletteFromImport, saveCustomPaletteFile, selectOrCreatePalette, serializePaletteHex, updateCustomPalette, upsertCustomPalette, watchPalettesFolder, type CustomPalette } from './lib/customPalettes';
import type { StorageLike } from './lib/storage';
import { isWorldCapable, type DitherMode } from './lib/dither';
import { sampleColorAt } from './lib/eyedropper';
import { hexToRgb, hsvToRgb, palettes, rgbToHex, rgbToHsv, type Palette, type PaletteCategory } from './lib/palettes';
import { computePosterizeStats, posterizeColors, type PosterizeStats } from './lib/posterize';
import { createRenderScheduler } from './lib/renderScheduler';
import { createModelFileBundle, modelFormat, type ModelFileBundle } from './lib/modelFiles';
import { collectModelTextures, type ExtractedModelTextures } from './lib/modelTextures';
import { applyDisplacement, applyUVChannel, cloneModelScene, createFallbackQuadScene, disposeModel, geometryUVChannels, getFallbackQuadScene, renderModelThumbnail, type HeightSampler } from './lib/modelScene';
import { applyLodLevel, prepareModelLods } from './lib/modelLod';
import { loadModel, ModelViewport, upAxisRotation } from './lib/modelPreview';
import { computeAverageTexelDensity, computeUVStretchData } from './lib/texelDensity';
import { applyConfigValues, collectConfigValues, createPreset, defaultConfigValues, parsePreset, serializePreset, upscaleMethods, type ConversionPreset, type SavedCamera } from './lib/presets';
import { lightmapMatchesBaseColor } from './lib/lightmap';
import { imageHeightmapPixels, sampleHeightmap, type NormalFormat } from './lib/normal';
import { DEFAULT_AMBIENT_INTENSITY, DEFAULT_NORMAL_STRENGTH, DEFAULT_SUN_INTENSITY, DEFAULT_UV_STRETCH_SENSITIVITY } from './lib/defaults';
import { createRenderer } from './lib/render';
import { createPreview2D, type Preview2DApi } from './lib/preview2d';
import { lightmapIsActive, type LightState, type PreviewMode, type PreviewViewMode, type SourceImage, type State, type TextureChannelId, type TextureSlot } from './lib/state';
import { safeFileName } from './lib/strings';
import { DEFAULT_CAMERA_DIRECTION, DEFAULT_SUN_DIRECTION, type DirectionVector } from './lib/sunDirection';
import { Mesh, MeshBasicMaterial, type Object3D } from 'three';
import exampleModelUrl from '../Example/Book.fbx?url';
import exampleBaseColorUrl from '../Example/Book_BaseColor.png?url';
import exampleNormalUrl from '../Example/Book_NormalMap.png?url';
import { initDitherWasm } from './lib/wasmLinearMatch';

const TEXTURE_CHANNELS: ReadonlyArray<{ id: TextureChannelId; label: string; bake?: boolean }> = [
  { id: 'base', label: 'BaseColor' },
  { id: 'ao', label: 'AO', bake: true },
  { id: 'normal', label: 'Normal' },
  { id: 'lightmap', label: 'Lightmap' },
  { id: 'displacement', label: 'Displacement' },
];

// Pattern dropdown: one entry per dither mode in the canonical order (mirrors
// presets.ts ditherModes), carrying the display label and the CSS pattern-swatch
// class. Drives both the dropdown trigger and its option list from one place.
const DITHER_MODE_OPTIONS: ReadonlyArray<{ mode: DitherMode; label: string; pattern: string }> = [
  { mode: 'floyd', label: 'Floyd–Steinberg', pattern: 'noise' },
  { mode: 'atkinson', label: 'Atkinson', pattern: 'atkinson' },
  { mode: 'ordered', label: 'Ordered 4×4', pattern: 'grid' },
  { mode: 'cross', label: 'Cross', pattern: 'cross' },
  { mode: 'stripes', label: 'Stripes', pattern: 'stripes' },
  { mode: 'noise', label: 'Noise', pattern: 'random' },
  { mode: 'checker', label: 'Checker', pattern: 'checker' },
  { mode: 'halftone', label: 'Halftone', pattern: 'halftone' },
  { mode: 'none', label: 'None', pattern: 'none' },
];

/** Pattern swatch + label markup for a dither mode  the dropdown trigger and
 * every option row share the same inner content. */
function modeRow(mode: DitherMode): string {
  const option = DITHER_MODE_OPTIONS.find((candidate) => candidate.mode === mode);
  return option ? `<span class="pattern pattern-${option.pattern}"></span><strong>${option.label}</strong>` : '';
}

// Download-arrow icon shared by the palette export card, the texture slot
// download buttons, and the Export PNG button, so the markup lives in one place.
const DOWNLOAD_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v7M4.5 6.5L7 9l2.5-2.5M1 11.5h12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Expand-icon for the dithered preview's fullscreen toggle  four outward
// corner brackets so it reads as "make bigger" (inverse of a collapse glyph).
const FULLSCREEN_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9"/></svg>';

// Import-arrow icon for the palette import card  the inverse of download:
// the tray line stays at the bottom, but the arrowhead flips to the top of
// the shaft so the arrow points up, out of storage into the app.
const IMPORT_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 9v-7M4.5 4.5L7 2l2.5 2.5M1 11.5h12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Eyedropper (pipette) icon for the screen color-picker button in the palette
// editor  a round bulb, tube, and needle tip so it reads as a dropper (the
// previous straight-shaft glyph looked like a sword). Phosphor icons, MIT.
const EYEDROPPER_ICON_SVG = '<svg width="28" height="28" viewBox="0 0 256 256" aria-hidden="true" fill="currentColor"><path d="M224,67.3a35.79,35.79,0,0,0-11.26-25.66c-14-13.28-36.72-12.78-50.62,1.13L142.8,62.2a24,24,0,0,0-33.14.77l-9,9a16,16,0,0,0,0,22.64l2,2.06-51,51a39.75,39.75,0,0,0-10.53,38l-8,18.41A13.68,13.68,0,0,0,36,219.3a15.92,15.92,0,0,0,17.71,3.35L71.23,215a39.89,39.89,0,0,0,37.06-10.75l51-51,2.06,2.06a16,16,0,0,0,22.62,0l9-9a24,24,0,0,0,.74-33.18l19.75-19.87A35.75,35.75,0,0,0,224,67.3ZM97,193a24,24,0,0,1-24,6,8,8,0,0,0-5.55.31l-18.1,7.91L57,189.41a8,8,0,0,0,.25-5.75A23.88,23.88,0,0,1,63,159l51-51,33.94,34ZM202.13,82l-25.37,25.52a8,8,0,0,0,0,11.3l4.89,4.89a8,8,0,0,1,0,11.32l-9,9L112,83.26l9-9a8,8,0,0,1,11.31,0l4.89,4.89a8,8,0,0,0,11.33,0l24.94-25.09c7.81-7.82,20.5-8.18,28.29-.81a20,20,0,0,1,.39,28.7Z"/></svg>';

// The same pipette as a cursor image (explicit fill  a cursor can't inherit
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
  displacement: { image: null, name: '' },
};

// Posterize ramps adapt to the BaseColor texture's own tonal distribution
// (see refreshPosterizeStats)  recomputed whenever the base image changes.
const POSTERIZE_SAMPLE_MAX = 64;
let posterizeStats: PosterizeStats | null = null;
refreshPosterizeStats();
const sunOverlayMarkup = (): string => `
  <div class="sun-overlay" id="sunControl" hidden>
    <div class="sun-overlay-heading">
      <span>Lighting controls</span>
    </div>
    <button class="orient-sun-button" id="orientSunWithCamera" type="button" title="Copy the 3D viewport angle to the sun"><span class="orient-sun-spinner" aria-hidden="true"></span>Orient Sun with Camera</button>
    <div class="orientation-readout" title="World-space direction (x, y, z)">
      <div class="orientation-row"><span class="orientation-label">Sun</span><output id="sunDirectionValue"></output></div>
      <div class="orientation-row"><span class="orientation-label">Cam</span><output id="cameraDirectionValue"></output></div>
    </div>
    <div class="light-controls">
      <div class="light-group">
        <div class="light-heading">
          <span class="light-label">Sun</span>
          <span class="light-heading-end">
            <output id="sunIntensityValue" title="Click to type a value">${DEFAULT_SUN_INTENSITY.toFixed(2)}</output><input class="range-value-edit" id="sunIntensityEdit" type="number" min="0" max="2" step="0.01" value="${DEFAULT_SUN_INTENSITY}" aria-label="Sun intensity value" hidden />
            <label class="light-swatch" title="Sun color">${colorControl('#ffffff', 'Sun color', 'id="sunColor"')}</label>
          </span>
        </div>
        <input class="range" id="sunIntensity" type="range" min="0" max="2" step="0.01" value="${DEFAULT_SUN_INTENSITY}" ${rangeDefaultAttrs('sunIntensity', 0, 2)} aria-label="Sun intensity" />
      </div>
      <div class="light-group">
        <div class="light-heading">
          <span class="light-label">Ambient</span>
          <span class="light-heading-end">
            <output id="ambientIntensityValue" title="Click to type a value">${DEFAULT_AMBIENT_INTENSITY.toFixed(2)}</output><input class="range-value-edit" id="ambientIntensityEdit" type="number" min="0" max="1" step="0.01" value="${DEFAULT_AMBIENT_INTENSITY}" aria-label="Ambient intensity value" hidden />
            <label class="light-swatch" title="Ambient light color">${colorControl('#ffffff', 'Ambient light color', 'id="ambientColor"')}</label>
          </span>
        </div>
        <input class="range" id="ambientIntensity" type="range" min="0" max="1" step="0.01" value="${DEFAULT_AMBIENT_INTENSITY}" ${rangeDefaultAttrs('ambientIntensity', 0, 1)} aria-label="Ambient intensity" />
      </div>
      <div class="light-group">
        <div class="light-heading">
          <span class="light-label">Normals</span>
          <output id="normalStrengthValue" title="Click to type a value">${DEFAULT_NORMAL_STRENGTH.toFixed(2)}</output><input class="range-value-edit" id="normalStrengthEdit" type="number" min="0" max="1" step="0.01" value="${DEFAULT_NORMAL_STRENGTH}" aria-label="Normal strength value" hidden />
        </div>
        <input class="range" id="normalStrength" type="range" min="0" max="1" step="0.01" value="${DEFAULT_NORMAL_STRENGTH}" ${rangeDefaultAttrs('normalStrength', 0, 1)} aria-label="Normal strength" />
      </div>
      <div class="light-group" id="uvStretchSensitivityGroup" hidden>
        <div class="light-heading">
          <span class="light-label">UV stretch sensitivity</span>
          <output id="uvStretchSensitivityValue" title="Click to type a value">${DEFAULT_UV_STRETCH_SENSITIVITY.toFixed(2)}</output><input class="range-value-edit" id="uvStretchSensitivityEdit" type="number" min="0" max="4" step="0.05" value="${DEFAULT_UV_STRETCH_SENSITIVITY}" aria-label="UV stretch sensitivity value" hidden />
        </div>
        <input class="range" id="uvStretchSensitivity" type="range" min="0" max="4" step="0.05" value="${DEFAULT_UV_STRETCH_SENSITIVITY}" ${rangeDefaultAttrs('uvStretchSensitivity', 0, 4)} aria-label="UV stretch sensitivity" />
      </div>
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
  state.uvMap = 'uv';
  state.lodLevel = 0;
  state.sun = { direction: { ...DEFAULT_SUN_DIRECTION }, color: defaults.sunColor as string, intensity: defaults.sunIntensity as number };
  state.ambient = { color: defaults.ambientColor as string, intensity: defaults.ambientIntensity as number };
  state.worldAxis = 'blender';
  state.cameraDirection = { ...DEFAULT_CAMERA_DIRECTION };
  state.showUVOverlapOriginal = false;
  state.showUVOverlapProcessed = false;
  state.showUVWireframeOriginal = false;
  state.showUVWireframeProcessed = false;
  state.viewModeOriginal = 'flat';
  state.viewModeProcessed = 'flat';
  applyConfigValues(state, defaults);
  return state;
}

const state: State = defaultState();

app.innerHTML = `
  <div class="app-shell">
    <div id="storageNotice" class="storage-notice" hidden></div>
    <div id="wasmNotice" class="storage-notice" hidden></div>
    <div class="main-column">
    <header class="topbar">
      <div class="brand-group">
        <span class="brand" aria-label="UltiPixelizer">
          <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span>ULTI<span>PIXELIZER</span></span>
        </span>
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
                ${channel.bake ? `<button class="icon-button texture-slot-bake" data-bake-texture="${channel.id}" type="button" aria-label="Bake ${channel.label}">${channel.id === 'ao' ? '<span class="texture-slot-bake-spinner" aria-hidden="true"></span>' : ''}Bake</button>` : ''}
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
              <figcaption><span>01</span> Original <span class="fig-dims" id="sourceDimensions">640 × 461</span><button class="fig-zoom" id="originalZoomBadge" type="button" title="Zoom level  scroll over the preview to zoom, drag to pan, double-click to reset">100%</button></figcaption>
              <div class="canvas-frame">
                <canvas id="originalCanvas" aria-label="Original texture preview"></canvas>
                <canvas class="wireframe-overlay" id="originalWireframeOverlay" aria-hidden="true" hidden></canvas>
                <figure class="luminosity-histogram" id="originalLuminosityHistogram" aria-label="Original luminosity levels">
                  <figcaption>Luminosity levels</figcaption>
                  <canvas aria-hidden="true"></canvas>
                  <div class="luminosity-axis" aria-hidden="true">
                    <div class="luminosity-axis-rail"></div>
                    <div class="luminosity-axis-labels"><span>0</span><span>64</span><span>128</span><span>192</span><span>255</span></div>
                  </div>
                </figure>
                <div class="model-host" id="originalModelHost" hidden></div>
                ${sunOverlayMarkup()}
                <div class="preview-mode-toggle" id="originalPreviewToggle" role="group" aria-label="Preview mode">
                  <button type="button" data-preview-mode="2d" class="active">2D</button>
                  <button type="button" data-preview-mode="3d">3D</button>
                </div>
                <label class="uv-overlap-control" id="repeatTextureControl" hidden title="Tile the texture 3×3 in the 2D view to reveal seams at the tile boundaries">
                  <span>Image repeat</span>
                  ${toggleControl('repeatTexture', 'Show the texture repeated to reveal seams')}
                </label>
                <label class="uv-overlap-control" id="uvOverlapControl" hidden title="Highlight regions where UV shells overlap">
                  <span>UV overlap</span>
                  ${toggleControl('uvOverlap', 'Show overlapping UVs')}
                </label>
                <label class="uv-overlap-control" id="uvWireframeControl" hidden title="Overlay UV island wireframes on the 2D view">
                  <span>UV islands</span>
                  ${toggleControl('uvWireframe', 'Show UV island wireframes', true)}
                </label>
                <div class="preview-view-toggle" id="originalViewToggle" role="group" aria-label="View mode">
                  <button type="button" data-view="flat" class="active">Combined</button>
                  <button type="button" data-view="basecolor">BaseColor</button>
                  <button type="button" data-view="normals">Normals</button>
                  <button type="button" data-view="ao">AO</button>
                  <button type="button" data-view="lightmap">Lightmap</button>
                  <button type="button" data-view="lightmap-ao">Lightmap+AO</button>
                  <button type="button" data-view="uv-stretch" title="Compare each UV face area with its world-space face area">UV Stretch</button>
                  <button type="button" data-view="directionality" title="A 16-wave sawtooth over the V (Y) UV coordinate, showing UV directionality across the surface">Directionality</button>
                  <button type="button" data-view="texel-variance" title="Color each face by its texel density vs the model-wide average (red below, blue above)">Texel Variance</button>
                </div>
                <div class="viewport-control-stack">
                  <label class="uv-overlap-control" id="navigationToggle" hidden title="Left-drag camera action. On: pan moves the camera sideways. Off: orbit rotates around the target. The middle button always zooms.">
                    <span>Alt controls</span>
                    ${toggleControl('navigationPan', 'Pan the camera on left-drag (off: orbit)')}
                  </label>
                  <label class="uv-overlap-control" id="worldAxisToggle" hidden title="Up axis for FBX/OBJ models. On: Y-up (Maya). Off: Z-up (Blender).">
                    <span>Y-Up</span>
                    ${toggleControl('worldAxisYUp', 'Use Y-up as the model up axis (off: Z-up)')}
                  </label>
                  <label class="uv-overlap-control" id="floorGridToggle" hidden title="Show a transparent floor scale reference in both 3D views. Divisions are 10 cm and repeat to 5 m from the camera.">
                    <span>10 cm grid</span>
                    ${toggleControl('showFloorGrid', 'Show the 10 cm floor grid in both 3D views')}
                  </label>
                </div>
              </div>
            </figure>
            <figure class="preview-pane processed-pane">
              <figcaption><span>02</span> Dithered <span class="fig-dims" id="processedDimensions">128 × 92</span><button class="fig-zoom" id="processedZoomBadge" type="button" title="Zoom level  scroll over the preview to zoom, drag to pan, double-click to reset">100%</button></figcaption>
              <div class="canvas-frame">
                <canvas id="previewCanvas" aria-label="Dithered texture preview"></canvas>
                <canvas class="wireframe-overlay" id="processedWireframeOverlay" aria-hidden="true" hidden></canvas>
                <figure class="luminosity-histogram" id="processedLuminosityHistogram" aria-label="Dithered luminosity levels">
                  <figcaption>Luminosity levels</figcaption>
                  <canvas aria-hidden="true"></canvas>
                  <div class="luminosity-axis" aria-hidden="true">
                    <div class="luminosity-axis-rail"></div>
                    <div class="luminosity-axis-labels"><span>0</span><span>64</span><span>128</span><span>192</span><span>255</span></div>
                  </div>
                </figure>
                <div class="model-host" id="processedModelHost" hidden></div>
                <div class="texel-density" id="processedTexelDensity" hidden title="Texels per world unit  summed UV triangle area, including stacking and UVs outside 0–1, compared with mapped world-space area">
                  <span>Texel density</span>
                  <output id="processedTexelDensityValue"></output>
                </div>
                <button class="fullscreen-toggle" id="processedFullscreenToggle" type="button" title="Expand the dithered preview to fill the whole stage" aria-pressed="false">${FULLSCREEN_ICON_SVG}</button>
                <div class="preview-mode-toggle" id="processedPreviewToggle" role="group" aria-label="Preview mode">
                  <button type="button" data-preview-mode="2d" class="active">2D</button>
                  <button type="button" data-preview-mode="3d">3D</button>
                </div>
                <label class="uv-overlap-control" id="processedRepeatTextureControl" hidden title="Tile the texture 3×3 in the 2D view to reveal seams at the tile boundaries">
                  <span>Image repeat</span>
                  ${toggleControl('processedRepeatTexture', 'Show the texture repeated to reveal seams')}
                </label>
                <label class="uv-overlap-control" id="processedUVOverlapControl" hidden title="Highlight regions where UV shells overlap">
                  <span>UV overlap</span>
                  ${toggleControl('processedUVOverlap', 'Show overlapping UVs')}
                </label>
                <label class="uv-overlap-control" id="processedUVWireframeControl" hidden title="Overlay UV island wireframes on the 2D view">
                  <span>UV islands</span>
                  ${toggleControl('processedUVWireframe', 'Show UV island wireframes', true)}
                </label>
                <button class="button" id="exportButton" type="button" title="Export the dithered preview as PNG">Export PNG ${DOWNLOAD_ICON_SVG}</button>
              </div>
            </figure>
          </div>
        </div>
      </section>
    </main>
    </div>

    <aside class="control-column">
        <section class="panel">
          <div class="panel-heading compact"><div><h2>Palette library</h2></div><span class="catalog-count" id="paletteCount">${Object.keys(palettes).length} PRESETS</span></div>
          <div class="palette-filters" id="paletteFilters" role="group" aria-label="Filter palette library">
            <button class="active" type="button" data-filter="compact">Compact</button>
            <button type="button" data-filter="pixel-art">Pixel art</button>
            <button type="button" data-filter="hardware">Hardware</button>
            <button type="button" data-filter="themed">Themed</button>
            <button type="button" data-filter="extended">Extended</button>
            <button type="button" data-filter="posterize">Posterize</button>
            <button type="button" data-filter="custom">Custom</button>
            <button type="button" data-filter="search">Search</button>
          </div>
          <div class="palette-search" id="paletteSearchControl" hidden>
            <input class="palette-search-input" id="paletteSearchInput" type="search" placeholder="Search palettes by name" aria-label="Search palettes by name" />
            <button type="button" class="palette-sort-toggle" id="paletteSortToggle" title="Sort order: name A-Z, fewest colors first, most colors first. Click to cycle.">A–Z</button>
          </div>
          <div class="palette-grid" id="paletteGrid"></div>
          <div class="custom-palette collapsed">
            <button type="button" class="custom-palette-toggle" id="paletteEditorToggle" aria-expanded="false" aria-controls="paletteEditor">
              <span>Palette Editor</span><span class="custom-palette-chevron" aria-hidden="true"></span>
            </button>
            <fieldset class="palette-editor" id="paletteEditor">
              <div class="color-picker" id="colorPicker">
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
          <input id="importCustomPalette" type="file" accept=".hex,.txt,text/plain" hidden />
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><h2>Pattern</h2></div></div>
          <div class="mode-dropdown" id="modeDropdown">
            <button type="button" class="mode-select" id="modeSelect" aria-haspopup="listbox" aria-expanded="false" aria-controls="modeOptions">
              ${modeRow(state.mode)}<span class="mode-chevron" aria-hidden="true"></span>
            </button>
            <div class="mode-dropdown-list" id="modeOptions" role="group" aria-label="Dithering algorithm">
              ${DITHER_MODE_OPTIONS.map((option) => `<button class="mode-button${option.mode === state.mode ? ' active' : ''}" data-mode="${option.mode}" type="button">${modeRow(option.mode)}</button>`).join('')}
            </div>
          </div>
          <div class="pattern-space-toggle" id="patternSpaceToggle" role="group" aria-label="Pattern space" hidden>
            <button type="button" data-pattern-space="uv" class="active">UV</button>
            <button type="button" data-pattern-space="world">World</button>
          </div>
          ${rangeControl('strength', 'Dither strength', 0, 100, 1, 85, '85%', 'Error diffusion amount')}
          <div class="stripe-angle-control" id="stripeAngleControl" hidden>
            ${rangeControl('stripeAngle', 'Stripe angle', 0, 135, 1, 45, '45°', 'Band direction')}
          </div>
          <div class="noise-control" id="noiseControl" hidden>
            ${rangeControl('seed', 'Seed', 0, 9999, 1, 1, '1', 'Noise pattern')}
          </div>
          <div class="worldspace-scale-control" id="worldspaceScaleControl" hidden>
            ${rangeControl('worldspaceScale', 'World scale', 64, 2048, 1, 64, '64 cells/unit', 'Pattern cells per world unit')}
          </div>
          <div class="uv-scale-control" id="uvScaleControl" hidden>
            ${rangeControl('uvScale', 'UV scale', 0.25, 8, 0.25, 1, '1 cells/px', 'Pattern cells per pixel')}
          </div>
        </section>

        <section class="panel adjustments">
          <div class="panel-heading compact">
            <div><h2>Adjustments</h2></div>
          </div>
          <div class="pixelation-row">
            <div class="pixelation-control" id="pixelationControl"></div>
            <select class="select upscale-select" id="upscale" title="How the pixelated image is upscaled back to full resolution. Nearest: crisp blocks. Bilinear: smoothed." aria-label="Upscale method">${upscaleMethods.map((method) => `<option value="${method}">${method[0].toUpperCase()}${method.slice(1)}</option>`).join('')}</select>
          </div>
          <div class="resolution-block">
            <div id="resolutionControl"></div>
            <div class="range-labels"><span>CHUNKY</span><span>FINE</span></div>
            <div class="resolution-presets" role="group" aria-label="Resolution presets">
              <button type="button" data-resolution="64">64</button>
              <button class="active" type="button" data-resolution="128">128</button>
              <button type="button" data-resolution="256">256</button>
              <button type="button" data-resolution="512">512</button>
              <button type="button" data-resolution="1024">1024</button>
            </div>
          </div>
          <div id="adjustmentControls"></div>
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><h2>Ambient occlusion</h2></div></div>
          ${rangeControl('aoBias', 'Bias', -1, 1, 0.01, 0, '+0.00')}
          ${rangeControl('aoPower', 'Power', 0, 16, 0.01, 1, '1.00')}
          ${rangeControl('aoDistance', 'Distance', 0.05, 3, 0.05, 2, '2.00×')}
        </section>

        <section class="panel" id="quadPanel" hidden>
          <div class="panel-heading compact"><div><h2>Fallback plane</h2></div></div>
          ${rangeControl('quadTessellation', 'Tessellation', 2, 128, 1, 16, '16 × 16', 'Subdivisions for the fallback quad')}
          <label class="control-row quad-grid-row"><span><strong>3×3 grid</strong><small>Middle tile baked  neighbors cast shadows</small></span>${toggleControl('quadGrid', 'Show the quad as a 3×3 grid')}</label>
          ${rangeControl('displacementStrength', 'Displacement', 0, 0.2, 0.005, 0.15, '0.15', 'Heightmap push amount')}
          <label class="control-row quad-grid-row"><span><strong>Flip displacement</strong><small>Invert the heightmap  1 − height</small></span>${toggleControl('displacementFlip', 'Invert the displacement heightmap')}</label>
        </section>

        <section class="panel">
          <div class="panel-heading compact"><div><h2>Changelogs</h2></div></div>
          <button class="button changelog-fetch" id="changelogFetchButton" type="button">Fetch changelogs</button>
          <div class="changelog-list" id="changelogList"></div>
        </section>

    </aside>
  </div>
`;

const previewCanvas = document.querySelector<HTMLCanvasElement>('#previewCanvas')!;
const originalCanvas = document.querySelector<HTMLCanvasElement>('#originalCanvas')!;
const originalLuminosityHistogram = document.querySelector<HTMLElement>('#originalLuminosityHistogram')!;
const processedLuminosityHistogram = document.querySelector<HTMLElement>('#processedLuminosityHistogram')!;
const originalLuminosityCanvas = originalLuminosityHistogram.querySelector('canvas')!;
const processedLuminosityCanvas = processedLuminosityHistogram.querySelector('canvas')!;

// 2D preview pan/zoom lives in lib/preview2d.ts; each pane gets its own
// preview so zoom/pan state stays independent. The wireframe overlay tracks
// the canvas transform so the UV islands stay glued to the texture at any
// zoom.
const originalZoomBadge = document.querySelector<HTMLButtonElement>('#originalZoomBadge')!;
const originalWireframeOverlay = document.querySelector<HTMLCanvasElement>('#originalWireframeOverlay')!;
const processedWireframeOverlay = document.querySelector<HTMLCanvasElement>('#processedWireframeOverlay')!;
const processedZoomBadge = document.querySelector<HTMLButtonElement>('#processedZoomBadge')!;
const originalPreview2D = createPreview2D({ canvas: originalCanvas, frame: originalCanvas.parentElement!, badge: originalZoomBadge, overlay: originalWireframeOverlay });
const processedPreview2D = createPreview2D({ canvas: previewCanvas, frame: previewCanvas.parentElement!, badge: processedZoomBadge, overlay: processedWireframeOverlay });
const paletteGrid = document.querySelector<HTMLDivElement>('#paletteGrid')!;
const paletteFilters = document.querySelector<HTMLDivElement>('#paletteFilters')!;
const paletteSearchControl = document.querySelector<HTMLDivElement>('#paletteSearchControl')!;
const paletteSearchInput = document.querySelector<HTMLInputElement>('#paletteSearchInput')!;
const paletteSortToggle = document.querySelector<HTMLButtonElement>('#paletteSortToggle')!;
const modeDropdown = document.querySelector<HTMLDivElement>('#modeDropdown')!;
const modeSelect = document.querySelector<HTMLButtonElement>('#modeSelect')!;
const patternSpaceToggle = document.querySelector<HTMLDivElement>('#patternSpaceToggle')!;
const upscaleSelect = document.querySelector<HTMLSelectElement>('#upscale')!;
const customPaletteSection = document.querySelector<HTMLDivElement>('.custom-palette')!;
const paletteEditorToggle = document.querySelector<HTMLButtonElement>('#paletteEditorToggle')!;
const customColors = document.querySelector<HTMLDivElement>('#customColors')!;
const paletteEditor = document.querySelector<HTMLFieldSetElement>('#paletteEditor')!;
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
const worldAxisYUpInput = document.querySelector<HTMLInputElement>('#worldAxisYUp')!;
// Camera controls are pinned to the Original pane's 3D view and apply globally
// across both viewports.
const navigationToggle = document.querySelector<HTMLElement>('#navigationToggle')!;
const floorGridToggle = document.querySelector<HTMLElement>('#floorGridToggle')!;
const uvOverlapControl = document.querySelector<HTMLLabelElement>('#uvOverlapControl')!;
const uvOverlapInput = document.querySelector<HTMLInputElement>('#uvOverlap')!;
const repeatTextureControl = document.querySelector<HTMLLabelElement>('#repeatTextureControl')!;
const repeatTextureInput = document.querySelector<HTMLInputElement>('#repeatTexture')!;
const uvWireframeControl = document.querySelector<HTMLLabelElement>('#uvWireframeControl')!;
const uvWireframeInput = document.querySelector<HTMLInputElement>('#uvWireframe')!;
const processedRepeatTextureControl = document.querySelector<HTMLLabelElement>('#processedRepeatTextureControl')!;
const processedRepeatTextureInput = document.querySelector<HTMLInputElement>('#processedRepeatTexture')!;
const processedUVOverlapControl = document.querySelector<HTMLLabelElement>('#processedUVOverlapControl')!;
const processedUVOverlapInput = document.querySelector<HTMLInputElement>('#processedUVOverlap')!;
const processedUVWireframeControl = document.querySelector<HTMLLabelElement>('#processedUVWireframeControl')!;
const processedUVWireframeInput = document.querySelector<HTMLInputElement>('#processedUVWireframe')!;
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
  uvStretchSensitivityGroup: HTMLDivElement;
  uvStretchSensitivity: HTMLInputElement;
  uvStretchSensitivityValue: HTMLOutputElement;
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
  uvStretchSensitivityGroup: document.querySelector<HTMLDivElement>('#uvStretchSensitivityGroup')!,
  uvStretchSensitivity: document.querySelector<HTMLInputElement>('#uvStretchSensitivity')!,
  uvStretchSensitivityValue: document.querySelector<HTMLOutputElement>('#uvStretchSensitivityValue')!,
};
// Narrow windows hide the Original pane (CSS), so the pane-independent
// controls that live on it (view mode, UV toggles, and the full lighting
// panel) move onto the dithered pane, and back when the window widens.
// Moving the DOM nodes keeps their event listeners and state intact; every
// binding holds a node reference, so nothing re-queries or re-binds.
const originalPaneFrame = document.querySelector<HTMLDivElement>('.original-pane .canvas-frame')!;
const processedPaneFrame = document.querySelector<HTMLDivElement>('.processed-pane .canvas-frame')!;
const sharedPaneControls: HTMLElement[] = [
  originalViewToggle,
  uvOverlapControl,
  uvWireframeControl,
  sunControlElements.control,
];
const narrowLayout = window.matchMedia('(max-width: 1100px)');
function relocateSharedControls(narrow: boolean): void {
  const target = narrow ? processedPaneFrame : originalPaneFrame;
  sharedPaneControls.forEach((element) => target.append(element));
}
relocateSharedControls(narrowLayout.matches);
narrowLayout.addEventListener('change', (event) => {
  relocateSharedControls(event.matches);
  applyPreviewMode();
  if (!event.matches) render();
});

// Fullscreen toggle on the dithered preview: enters true OS-level fullscreen
// via the Fullscreen API  the dithered canvas-frame takes over the whole
// screen, not just the app's canvas stage. Because the frame fills the screen,
// its overlay controls are hidden by the `:fullscreen` CSS rules; the only
// control left is this toggle, so the user can exit. The pane-independent
// shared controls (view mode, UV toggles, lighting) relocate onto the dithered
// pane while fullscreen hides the Original pane, and move back on exit.
const processedFullscreenToggle = document.querySelector<HTMLButtonElement>('#processedFullscreenToggle')!;
const isPreviewFullscreen = (): boolean => document.fullscreenElement === processedPaneFrame;
function syncPreviewFullscreen(): void {
  const active = isPreviewFullscreen();
  processedFullscreenToggle.setAttribute('aria-pressed', String(active));
  processedFullscreenToggle.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
  relocateSharedControls(active || narrowLayout.matches);
  applyPreviewMode();
}
document.addEventListener('fullscreenchange', syncPreviewFullscreen);
processedFullscreenToggle.addEventListener('click', () => {
  if (isPreviewFullscreen()) void document.exitFullscreen();
  else void processedPaneFrame.requestFullscreen();
});
const sunDirectionValue = document.querySelector<HTMLOutputElement>('#sunDirectionValue')!;const cameraDirectionValue = document.querySelector<HTMLOutputElement>('#cameraDirectionValue')!;
const stripeAngleControl = document.querySelector<HTMLDivElement>('#stripeAngleControl')!;
const stripeAngleInput = document.querySelector<HTMLInputElement>('#stripeAngle')!;
const stripeAngleValue = document.querySelector<HTMLOutputElement>('#stripeAngleValue')!;
const noiseControl = document.querySelector<HTMLDivElement>('#noiseControl')!;
const worldspaceScaleControl = document.querySelector<HTMLDivElement>('#worldspaceScaleControl')!;
const worldspaceScaleInput = document.querySelector<HTMLInputElement>('#worldspaceScale')!;
const worldspaceScaleValue = document.querySelector<HTMLOutputElement>('#worldspaceScaleValue')!;
const uvScaleControl = document.querySelector<HTMLDivElement>('#uvScaleControl')!;
const uvScaleInput = document.querySelector<HTMLInputElement>('#uvScale')!;
const uvScaleValue = document.querySelector<HTMLOutputElement>('#uvScaleValue')!;
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
const quadPanel = document.querySelector<HTMLElement>('#quadPanel')!;
const quadTessellationInput = document.querySelector<HTMLInputElement>('#quadTessellation')!;
const quadTessellationValue = document.querySelector<HTMLOutputElement>('#quadTessellationValue')!;
const quadGridInput = document.querySelector<HTMLInputElement>('#quadGrid')!;
const displacementStrengthInput = document.querySelector<HTMLInputElement>('#displacementStrength')!;
const displacementStrengthValue = document.querySelector<HTMLOutputElement>('#displacementStrengthValue')!;
const displacementFlipInput = document.querySelector<HTMLInputElement>('#displacementFlip')!;
const strengthInput = document.querySelector<HTMLInputElement>('#strength')!;
const strengthValue = document.querySelector<HTMLOutputElement>('#strengthValue')!;
const normalFormatToggle = document.querySelector<HTMLElement>('[data-texture="normal"] .texture-slot-format')!;
const storageNotice = document.querySelector<HTMLElement>('#storageNotice')!;
const wasmNotice = document.querySelector<HTMLElement>('#wasmNotice')!;
let savedCustomPalettes: CustomPalette[] = [];
// The palette library's backing store: localStorage in the web build. On
// desktop each palette is its own `.hex` file in the install folder, managed
// through `tauriStore` (loaded by bootDesktopStorage).
let appStorage: StorageLike = localStorage;
// Set once desktop storage initializes; drives the settings auto-save and the
// per-palette .hex file writes.
let tauriStore: TauriFileStore | null = null;
try {
  savedCustomPalettes = loadCustomPalettes(appStorage);
} catch (error) {
  console.error('Custom palettes could not be loaded from storage.', error);
  // Blocked storage (private mode, disabled storage) breaks every palette
  // save for the session  say so loudly instead of failing silently.
  if (error instanceof Error && error.message.includes('Reading stored data')) {
    showStorageNotice('Browser storage is unavailable (private mode or storage disabled). Palettes will not persist after this session.');
  }
}
let editingCustomKey: string | null = null;
// The current draft's palette name lives here  the editable name field moved
// onto the palette card, so there's no separate editor input anymore.
let draftName = '';
let modelBundle: ModelFileBundle | null = null;
let originalPreviewMode: PreviewMode = '2d';
let processedPreviewMode: PreviewMode = '2d';
let originalViewport: ModelViewport | null = null;
let processedViewport: ModelViewport | null = null;

function forEachViewport(callback: (viewport: ModelViewport) => void): void {
  if (originalViewport) callback(originalViewport);
  if (processedViewport) callback(processedViewport);
}

/** Creates the two 3D viewports once, at boot  they live for the app's
 * lifetime. Without a model they hold the fallback flat quad (facing up), so
 * the 2D/3D toggle stays live in the no-model state; setModel swaps the real
 * model in, closeModelPreview swaps the quad back. */
function ensureViewports(): void {
  if (!originalViewport) {
    originalViewport = new ModelViewport(originalModelHost);
    originalViewport.onCameraChange = renderOrientationReadout;
    originalViewport.setModel(createFallbackQuadScene(), []);
  }
  if (!processedViewport) {
    processedViewport = new ModelViewport(processedModelHost);
    processedViewport.setModel(createFallbackQuadScene(), []);
  }
  forEachViewport((viewport) => {
    viewport.setNavigationDragMode(state.navigationPan);
    viewport.setFloorGrid(state.showFloorGrid);
  });
}

// Fallback-quad configuration  persisted with the other settings: the quad
// is the implicit model when none is loaded, so its tessellation, grid and
// displacement parameters are saved (and restored) like any other setting.
// The repeat-texture diagnostic below is view state (not a conversion
// parameter) and stays module-level.
// Image-repeat diagnostic: tiles the texture 3×3 in the 2D panes so seams at
// tile boundaries show. Fallback-quad view only, module-level  not
// persisted. Each pane tiles independently.
let repeatTextureOriginal = false;
let repeatTextureProcessed = false;

function displacementSampler(): HeightSampler | null {
  const image = textures.displacement.image;
  if (!image) return null;
  const source = imageHeightmapPixels(image);
  // The flip inverts the heightmap (1 − height). Applied at this single
  // sampler so every consumer  both viewports and the bake quad  reads the
  // flipped map, and no consumer needs to know about it.
  return (u, v) => {
    const height = sampleHeightmap(source, u, v);
    return state.displacementFlip ? 1 - height : height;
  };
}

/** Rebuilds both viewport quads (tessellation + grid) and applies displacement. */
function installViewportQuads(): void {
  forEachViewport((viewport) => viewport.setModel(createFallbackQuadScene(state.quadTessellation, state.quadGrid), []));
  const sampler = displacementSampler();
  forEachViewport((viewport) => viewport.applyDisplacement(sampler, state.displacementStrength));
}

// Persistent bake quad  the middle tile alone outside grid mode, the full
// 3×3 grid in grid mode (the neighbors are occluder-only: they cast shadows
// on the middle tile's bake but never rasterize into it). Memoized by
// (tessellation, grid) via getFallbackQuadScene  re-selecting a previously
// visited combo reuses the same scene instance, so the bake-scene cache hits
// without re-collecting the mesh. Rebuilt only when tessellation or grid
// changes; displacement applies in place so strength drags don't reallocate
// geometry (and its pristine-base cache) per event.
let bakeFallbackQuad: Object3D = getFallbackQuadScene(1, false);

// Displacement inputs at the last bake-scene invalidation. The collected bake
// scene is a snapshot of the installed quad's geometry, so it goes stale only
// when the quad instance changes (new geometry) or the displacement inputs
// change (world positions move); a refresh that changes neither (a boot
// re-install, a grid toggle back and forth, a redundant strength call) skips
// the invalidation and the next bake reuses the cached collection.
let bakeQuadDisplacement: { image: unknown; flip: boolean; strength: number } = { image: null, flip: false, strength: 0 };

/** Refreshes every fallback-quad consumer after a quad-view setting changed.
 * In grid mode the bake quad is the full 3×3 grid  `collectBakeScene` marks
 * the neighbors occluder-only, so they shadow the middle tile's bake without
 * rasterizing over its texture. `rebuildViewport` replaces the viewport quads
 * (tessellation / grid changes, camera refits); otherwise the displacement is
 * applied in place so strength drags don't jump the camera. `keepCamera`
 * snapshots and restores both viewport cameras around the swap  the grid
 * toggle changes the scene extent but must not move the view.
 * Quad-view tweaks are visualization adjustments and never start a lightmap
 * bake. The bake scene cache is still invalidated here, so the next Orient Sun
 * with Camera bake collects the updated geometry fresh. */
function refreshFallbackQuads(rebuildViewport: boolean, keepCamera = false): void {
  // Quad-view settings are a no-op while a model is loaded: tessellation,
  // grid and displacement exist only for the fallback plane, and applying
  // them here would displace or outright replace the model's own meshes in
  // the viewports and the bake scene.
  if (modelBundle) return;
  let quadInstanceChanged = false;
  if (rebuildViewport) {
    // Memoized by (tessellation, grid): re-selecting a previously visited
    // combo returns the same scene instance (see getFallbackQuadScene).
    const nextQuad = getFallbackQuadScene(state.quadTessellation, state.quadGrid);
    if (nextQuad !== bakeFallbackQuad) {
      bakeFallbackQuad = nextQuad;
      quadInstanceChanged = true;
    }
  }
  const sampler = displacementSampler();
  applyDisplacement(bakeFallbackQuad, sampler, state.displacementStrength);
  renderer.setFallbackQuad(bakeFallbackQuad);
  // The bake scene cache is keyed by scene identity + the geometry it was
  // collected with. It goes stale only when the installed quad's instance
  // changed (new geometry) or the displacement inputs changed (world
  // positions moved)  a refresh that changes neither (boot re-installs, grid
  // toggles back and forth, redundant strength calls) skips the invalidation,
  // so the next bake reuses the cached collection of the tessellated mesh.
  const displacementChanged = bakeQuadDisplacement.image !== textures.displacement.image
    || bakeQuadDisplacement.flip !== state.displacementFlip
    || bakeQuadDisplacement.strength !== state.displacementStrength;
  bakeQuadDisplacement = { image: textures.displacement.image, flip: state.displacementFlip, strength: state.displacementStrength };
  if (quadInstanceChanged || displacementChanged) renderer.invalidateBakeScene();
  if (rebuildViewport) {
    // The grid toggle changes the scene extent (1 tile ↔ 9), so the rebuild's
    // refit would zoom the camera in or out  snapshot both viewport cameras
    // and restore them after the swap instead.
    const snapshots = keepCamera
      ? [originalViewport?.captureCamera() ?? null, processedViewport?.captureCamera() ?? null]
      : null;
    installViewportQuads();
    // The swap installed fresh quads whose materials carry no map  re-apply
    // the last rendered frames synchronously so the viewport never shows
    // white while waiting for the next (debounced) pipeline render.
    applyViewportImages();
    if (snapshots) {
      if (originalViewport && snapshots[0]) originalViewport.restoreCamera(snapshots[0]);
      if (processedViewport && snapshots[1]) processedViewport.restoreCamera(snapshots[1]);
      // The rebuild's refit fired the camera-change listener with the fit
      // camera  re-sync the readout with the restored view.
      renderOrientationReadout();
    }
  } else {
    forEachViewport((viewport) => viewport.applyDisplacement(sampler, state.displacementStrength));
  }
}

/** Re-applies displacement in place after the map or strength changed.
 * Displacement is a fallback-plane-only feature  the ribbon slot is disabled
 * while a model is loaded, and `refreshFallbackQuads` (where the no-op guard
 * lives) skips everything while a model is loaded, so a mid-model clear or
 * strength change only updates dormant quad state. Closing the model rebuilds
 * the quads fresh (`refreshFallbackQuads(true)`), so nothing stale survives. */
function applyDisplacementChange(): void {
  refreshFallbackQuads(false);
}

function renderQuadControl(): void {
  quadPanel.hidden = modelBundle !== null;
  syncRangeValue(quadTessellationInput, quadTessellationValue, state.quadTessellation, (value) => `${value} × ${value}`);
  quadGridInput.checked = state.quadGrid;
  syncRangeValue(displacementStrengthInput, displacementStrengthValue, state.displacementStrength, formatFixed2);
  displacementFlipInput.checked = state.displacementFlip;
}
let modelUVChannels: string[] = [];
let modelLodLevels: number[] = [];
let aoBakeScene: Object3D | null = null;
// Retained clone of the loaded model used for the ribbon's mesh-slot
// thumbnail  the loaded scene is disposed after the viewports take clones.
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
  // The pixel grid resamples the source to the requested width  smaller
  // sources upscale (nearest-neighbor in the render pipeline), so 2k output
  // is reachable regardless of the source size.
  return computeOutputDimensions(state.resolution, textures.base.image!);
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
// Linear density follows the square root of UV texel area over world area, so
// the decimals adapt: whole numbers at 100+, one at 10–100, two below. World
// units are arbitrary (three.js units), hence px/u.
const formatTexelDensity = (value: number): string => `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} px/u`;

// Top-left HUD chip on the dithered preview: square root of summed UV triangle
// texel area divided by the corresponding mapped world-space surface area. The
// AO bake scene always mirrors the current UV channel and LOD level, so it is
// the measure source; the dithered output resolution sizes the texel count.
// Without a model the chip shows a plane message  the fallback quad spans
// the full UV square, so every texel covers the same world area. Hidden only
// when a loaded model has no face carrying a usable UV.
// Memoized: density depends only on the model's UVs and the target resolution,
// so basecolor swaps (which don't touch the scene) skip the 60k-tri walk.
let texelDensityCache: { scene: Object3D | null; width: number; height: number } | null = null;
let uvStretchAvailabilityCache: { scene: Object3D; available: boolean } | null = null;
function uvStretchIsAvailable(): boolean {
  if (!aoBakeScene) return false;
  if (uvStretchAvailabilityCache?.scene === aoBakeScene) return uvStretchAvailabilityCache.available;
  const available = computeUVStretchData(aoBakeScene) !== null;
  uvStretchAvailabilityCache = { scene: aoBakeScene, available };
  return available;
}
function updateTexelDensity(): void {
  if (!aoBakeScene) {
    // The fallback plane maps the whole UV square onto the whole quad, so
    // every texel covers the same world area  a per-face average is
    // meaningless. Show a plane-specific message instead of hiding the chip.
    processedTexelDensity.hidden = false;
    processedTexelDensityValue.textContent = 'Full UV';
    processedTexelDensity.title = 'The fallback plane spans the full UV square  uniform texel density, no islands to average';
    texelDensityCache = null;
    return;
  }
  processedTexelDensity.title = 'Texels per world unit  summed UV triangle area, including stacking and UVs outside 0–1, compared with mapped world-space area';
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
// the model doesn't change between ribbon refreshes  re-rendering it (a sync
// WebGL frame + readPixels) on every basecolor/normal/lightmap change wasted
// tens of ms for an identical picture. Invalidate on import/close only.
let modelThumbnailCanvas: HTMLCanvasElement | null = null;

// One invalidation point for every cached result derived from the AO scene's
// geometry. The bake scene (BVH + world transforms), the UV-overlap mask, and
// the texel density only change when the model, UV channel, LOD visibility, or
// world-axis rotation change  all in-place mutations that identity-keyed
// caches cannot see.
function invalidateModelCaches(): void {
  invalidateBakeScene();
  invalidateUVOverlap();
  invalidateUVStretch();
  texelDensityCache = null;
  uvStretchAvailabilityCache = null;
}
const formatPercent = (value: number): string => `${value}%`;
const formatDegrees = (value: number): string => `${value}°`;
const formatPixels = (value: number): string => `${value} px`;
const formatCellsPerUnit = (value: number): string => `${value} cells/unit`;
const formatCellsPerPixel = (value: number): string => `${value} cells/px`;
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
// actionable while their texture slot holds an image. Legacy in-memory
// lightmap state is accepted until reset; Lightmap+AO needs both channels.
function renderViewToggle(): void {
  const aoDefined = textures.ao.image !== null;
  const normalDefined = textures.normal.image !== null;
  // New lightmaps come from Orient Sun with Camera, import, or the implicit
  // re-bake on sun/ambient/normal changes.
  const lightmapDefined = lightmapIsActive(textures) || renderer.getImplicitLightmapCanvas() !== null;
  const lightmapAoDefined = aoDefined && lightmapDefined;
  const uvStretchDefined = uvStretchIsAvailable();
  // The Directionality and Texel Variance views color each surface by its UV
  // V coordinate / per-face density, so like UV Stretch they need a model
  // carrying usable UVs.
  const directionalityDefined = uvStretchIsAvailable();
  const texelVarianceDefined = uvStretchIsAvailable();
  if (!uvStretchDefined && state.viewModeOriginal === 'uv-stretch') state.viewModeOriginal = 'flat';
  if (!uvStretchDefined && state.viewModeProcessed === 'uv-stretch') state.viewModeProcessed = 'flat';
  if (!directionalityDefined && state.viewModeOriginal === 'directionality') state.viewModeOriginal = 'flat';
  if (!directionalityDefined && state.viewModeProcessed === 'directionality') state.viewModeProcessed = 'flat';
  if (!texelVarianceDefined && state.viewModeOriginal === 'texel-variance') state.viewModeOriginal = 'flat';
  if (!texelVarianceDefined && state.viewModeProcessed === 'texel-variance') state.viewModeProcessed = 'flat';
  if (!aoDefined && state.viewModeOriginal === 'ao') state.viewModeOriginal = 'flat';
  if (!lightmapDefined && state.viewModeOriginal === 'lightmap') state.viewModeOriginal = 'flat';
  if (!normalDefined && state.viewModeOriginal === 'normals') state.viewModeOriginal = 'flat';
  if (!lightmapAoDefined && state.viewModeOriginal === 'lightmap-ao') state.viewModeOriginal = 'flat';
  if (!aoDefined && state.viewModeProcessed === 'ao') state.viewModeProcessed = 'flat';
  if (!lightmapDefined && state.viewModeProcessed === 'lightmap') state.viewModeProcessed = 'flat';
  if (!normalDefined && state.viewModeProcessed === 'normals') state.viewModeProcessed = 'flat';
  if (!lightmapAoDefined && state.viewModeProcessed === 'lightmap-ao') state.viewModeProcessed = 'flat';
  // Always visible: the view modes are texture-slot driven (base / normals /
  // AO / lightmap / lightmap+AO), so they apply to the fallback quad's panes
  // and viewports exactly as they do to a loaded model. The per-button
  // `disabled` states below already handle missing sources.
  originalViewToggle.hidden = false;
  syncViewToggle(originalViewToggle, state.viewModeOriginal, normalDefined, aoDefined, lightmapDefined, lightmapAoDefined, uvStretchDefined, directionalityDefined, texelVarianceDefined);
  // A view-mode fallback above (e.g. the normal map was removed) must reach the
  // 3D viewports too  they render the Normals view via setNormalsView and
  // would otherwise stay latched on the stale showcase.
  applyViewNormals();
  applyViewDirectionality();
}

function syncViewToggle(toggle: HTMLDivElement, viewMode: PreviewViewMode, normalDefined: boolean, aoDefined: boolean, lightmapDefined: boolean, lightmapAoDefined: boolean, uvStretchDefined: boolean, directionalityDefined: boolean, texelVarianceDefined: boolean): void {
  syncActiveButton(toggle, '[data-view]', (button) => button.dataset.view === viewMode);
  for (const button of toggle.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    const view = button.dataset.view as PreviewViewMode;
    button.disabled = (view === 'normals' && !normalDefined)
      || (view === 'ao' && !aoDefined)
      || (view === 'lightmap' && !lightmapDefined)
      || (view === 'lightmap-ao' && !lightmapAoDefined)
      || (view === 'uv-stretch' && !uvStretchDefined)
      || (view === 'directionality' && !directionalityDefined)
      || (view === 'texel-variance' && !texelVarianceDefined);
  }
}

function applyViewNormals(): void {
  originalViewport?.setNormalsView(state.viewModeOriginal === 'normals');
  processedViewport?.setNormalsView(state.viewModeProcessed === 'normals');
}

function applyViewDirectionality(): void {
  originalViewport?.setDirectionalityView(state.viewModeOriginal === 'directionality');
  processedViewport?.setDirectionalityView(state.viewModeProcessed === 'directionality');
}

// Pushes the current normal-map texture (with the bake's strength / DirectX
// green-flip decode) into the 3D viewports, so the Normals view showcases the
// actual map rather than the mesh's vertex normals. The original viewport gets
// the native-resolution map; the dithered viewport gets a nearest-neighbor
// copy at the target resolution with the pixelation amount applied 
// normals can't be palette-dithered, so downscale/upscale pixelization is the
// processed analogue of the quantized base texture.
function applyViewportNormalMap(): void {
  const image = textures.normal.image;
  const strength = state.normalStrength;
  const flipY = state.normalFormat === 'directx';
  originalViewport?.setNormalMap(image, strength, flipY);
  if (processedViewport) {
    const { width, height } = dimensions();
    // The processed viewport's Normals view follows the pixelation amount:
    // downscale/upscale applies on top of the target-resolution resample,
    // mirroring the processed 2D normals inspection and the dithered base.
    processedViewport.setNormalMap(image ? resampleAndPixelate(image, width, height, state.pixelation, state.upscale) : null, strength, flipY);
  }
}

function renderNormalControls(): void {
  // GL/DX is always live: flipping the format re-bakes the lightmap with the
  // new decode (see the normalFormatToggle click handler), so a committed
  // lightmap must never lock the buttons.
  syncActiveButton(normalFormatToggle, '[data-normal-format]', (button) => button.dataset.normalFormat === state.normalFormat);
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
  syncCheckboxControl(uvOverlapControl, uvOverlapInput, modelUVChannels.length > 0 && originalPreviewMode === '2d', state.showUVOverlapOriginal);
  syncCheckboxControl(processedUVOverlapControl, processedUVOverlapInput, modelUVChannels.length > 0 && processedPreviewMode === '2d', state.showUVOverlapProcessed);
}

// Image-repeat is a fallback-quad diagnostic  hidden while a model is loaded
// and outside the panes' 2D views. Each pane toggles independently.
function renderRepeatControl(): void {
  syncCheckboxControl(repeatTextureControl, repeatTextureInput, modelBundle === null && originalPreviewMode === '2d', repeatTextureOriginal);
  syncCheckboxControl(processedRepeatTextureControl, processedRepeatTextureInput, modelBundle === null && processedPreviewMode === '2d', repeatTextureProcessed);
}

function renderUVWireframeControl(): void {
  syncCheckboxControl(uvWireframeControl, uvWireframeInput, modelUVChannels.length > 0 && originalPreviewMode === '2d', state.showUVWireframeOriginal);
  syncCheckboxControl(processedUVWireframeControl, processedUVWireframeInput, modelUVChannels.length > 0 && processedPreviewMode === '2d', state.showUVWireframeProcessed);
}

function renderLodControl(): void {
  renderSelectControl(lodControl, lodMapSelect, modelLodLevels.map((level) => ({ value: String(level), label: `LOD ${level}` })), String(state.lodLevel), modelLodLevels.length > 1);
}

function renderWorldAxisControl(): void {
  // Y-up is a 3D-view concept (mirrors the Alt-controls pill) and only
  // applies to FBX/OBJ models: Blender/Z-up is the default, Maya/Y-up is on.
  const supportsAxis = modelBundle !== null && (modelBundle.format === 'fbx' || modelBundle.format === 'obj');
  syncCheckboxControl(worldAxisToggle, worldAxisYUpInput, supportsAxis && originalPreviewMode === '3d', state.worldAxis === 'maya');
}

// Shared sync for every model-dependent control. The model load/close and reset
// paths re-render the same cluster, so the group lives here once.
function renderModelControls(): void {
  renderUVControl();
  renderUVOverlapControl();
  renderUVWireframeControl();
  renderRepeatControl();
  renderLodControl();
  renderSunControl();
  renderOrientationReadout();
  renderWorldAxisControl();
  renderViewToggle();
}

function formatDirection(vector: DirectionVector): string {
  return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
}

// The viewport that feeds "Orient Sun with Camera": the Original pane's camera
// at wide widths; in the constrained single-pane layout the Original pane is
// hidden, so the dithered pane's camera is the one the user actually sees.
function orientCameraViewport(): ModelViewport | null {
  return narrowLayout.matches ? processedViewport : originalViewport;
}
function orientCameraPreviewMode(): PreviewMode {
  return narrowLayout.matches ? processedPreviewMode : originalPreviewMode;
}

function renderOrientationReadout(): void {
  const viewport = orientCameraViewport();
  sunDirectionValue.textContent = formatDirection(state.sun.direction);
  cameraDirectionValue.textContent = viewport ? formatDirection(viewport.getCameraForward()) : '';
}

// Shared sync for a sun/ambient light group (color picker + chip, intensity
// slider + readout). These controls feed the lighting bake  the viewports
// carry no realtime lights  so `renderSunControl` syncs both groups through
// this one place.
function syncLightControls(
  light: LightState,
  color: HTMLInputElement,
  intensity: HTMLInputElement,
  intensityValue: HTMLOutputElement,
): void {
  color.value = light.color;
  syncColorChip(color);
  // Guard against a non-finite intensity ever reaching the range input  a
  // range input given an invalid value can freeze its thumb at an endpoint.
  const value = Number.isFinite(light.intensity) ? light.intensity : 0;
  intensity.value = String(value);
  intensityValue.textContent = value.toFixed(2);
  // Mirror the raw value into the click-to-edit number field so opening it
  // after any programmatic change shows the live value, not a stale one.
  const edit = document.querySelector<HTMLInputElement>(`#${intensityValue.id.replace(/Value$/, '')}Edit`);
  if (edit) edit.value = String(value);
}

// Lightmap bakes  Orient Sun with Camera's explicit re-bake and the implicit
// re-bakes from sun/ambient slider moves and normal-map slot edits  can on a
// heavy grid take long enough that a second trigger would start a redundant
// bake. While one runs the button is held disabled with a throbber (see
// .orient-sun-button.busy); the flag clears when the latest bake settles.
let orientSunBusy = false;
function setOrientSunBusy(busy: boolean): void {
  orientSunBusy = busy;
  renderSunControl();
}

// Every lightmap bake funnels through here, so the throbber always shows while
// a lightmap is being calculated. bakeLighting aborts superseded jobs, so a
// sequence guard keeps the button busy until the newest bake settles: an
// aborted bake's finally must not drop the throbber while its replacement is
// still running.
let lightmapBakeSeq = 0;
function runLightmapBake(): void {
  // An explicit bake (Orient Sun with Camera) runs with the current state, so
  // drop any pending debounced implicit bake first: otherwise a slider release
  // right before this would fire ~200ms later, abort this bake, and re-run the
  // whole pipeline redundantly, doubling the main-thread freeze.
  cancelImplicitLightmapBake();
  const seq = ++lightmapBakeSeq;
  setOrientSunBusy(true);
  void bakeLighting().finally(() => {
    if (seq === lightmapBakeSeq) setOrientSunBusy(false);
  });
}

// Sun/ambient sliders schedule the bake on release ('change'), not per drag
// move, so a drag never starts a mid-drag bake. The 200ms debounce coalesces
// rapid successive triggers (consecutive slider commits, slot mutations)
// into one bake. While the lightmap slot was explicitly cleared (X) the
// scheduler stays quiet  lighting remains absent until Orient Sun with
// Camera, a loaded lightmap, or a reset re-engages it (see
// renderer.isLightmapCleared).
let implicitBakeTimer = 0;
function scheduleImplicitLightmapBake(): void {
  if (renderer.isLightmapCleared()) return;
  if (implicitBakeTimer) window.clearTimeout(implicitBakeTimer);
  implicitBakeTimer = window.setTimeout(() => {
    implicitBakeTimer = 0;
    // Orient Sun with Camera may still be re-baking on the main thread. Don't
    // start a redundant bake on top of it; re-queue so the change still lands
    // after the orient bake settles instead of being dropped (which would leave
    // the preview stale). 200ms polling is safe while busy clears quickly.
    if (orientSunBusy) {
      scheduleImplicitLightmapBake();
      return;
    }
    runLightmapBake();
  }, 200);
}

function cancelImplicitLightmapBake(): void {
  if (implicitBakeTimer) window.clearTimeout(implicitBakeTimer);
  implicitBakeTimer = 0;
}

function renderSunControl(): void {
  // Hidden only when a model is loaded and neither pane shows the 3D view.
  // Without a model the bake scene falls back to the flat quad (see the bake
  // layer), so the lighting controls stay live to drive that bake.
  sunControlElements.control.hidden = modelBundle !== null && originalPreviewMode !== '3d' && processedPreviewMode !== '3d';
  sunControlElements.orientWithCamera.disabled = orientSunBusy || orientCameraPreviewMode() !== '3d' || orientCameraViewport() === null;
  sunControlElements.orientWithCamera.classList.toggle('busy', orientSunBusy);
  syncLightControls(state.sun, sunControlElements.color, sunControlElements.intensity, sunControlElements.intensityValue);
  syncLightControls(state.ambient, sunControlElements.ambientColor, sunControlElements.ambientIntensity, sunControlElements.ambientIntensityValue);
  syncRangeValue(sunControlElements.normalStrength, sunControlElements.normalStrengthValue, state.normalStrength, formatFixed2);
  // The UV-stretch sensitivity slider belongs to the stretch heatmap, so it is
  // shown only while either pane inspects the UV-stretch view.
  sunControlElements.uvStretchSensitivityGroup.hidden = state.viewModeOriginal !== 'uv-stretch' && state.viewModeProcessed !== 'uv-stretch';
  syncRangeValue(sunControlElements.uvStretchSensitivity, sunControlElements.uvStretchSensitivityValue, state.uvStretchSensitivity, formatFixed2);
  renderNavigationControl();
}

function renderNavigationControl(): void {
  const toggle = document.querySelector<HTMLInputElement>('#navigationPan')!;
  toggle.checked = state.navigationPan;
  // Preset loads and resets re-sync the checkbox; the viewports follow the
  // same value so the drag mode always matches the saved setting.
  forEachViewport((viewport) => viewport.setNavigationDragMode(state.navigationPan));
}
document.querySelector<HTMLInputElement>('#navigationPan')!.addEventListener('change', (event) => {
  state.navigationPan = (event.target as HTMLInputElement).checked;
  forEachViewport((viewport) => viewport.setNavigationDragMode(state.navigationPan));
  scheduleSettingsSave();
});

function renderFloorGridControl(): void {
  const toggle = document.querySelector<HTMLInputElement>('#showFloorGrid')!;
  toggle.checked = state.showFloorGrid;
  forEachViewport((viewport) => viewport.setFloorGrid(state.showFloorGrid));
}
document.querySelector<HTMLInputElement>('#showFloorGrid')!.addEventListener('change', (event) => {
  state.showFloorGrid = (event.target as HTMLInputElement).checked;
  forEachViewport((viewport) => viewport.setFloorGrid(state.showFloorGrid));
  scheduleSettingsSave();
});

function updatePatternControls(): void {
  stripeAngleControl.hidden = state.mode !== 'stripes';
  noiseControl.hidden = state.mode !== 'noise';
  const worldCapable = isWorldCapable(state.mode);
  patternSpaceToggle.hidden = !worldCapable;
  worldspaceScaleControl.hidden = !(worldCapable && state.patternSpace === 'world');
  uvScaleControl.hidden = !(worldCapable && state.patternSpace === 'uv');
}

function updateAOControls(): void {
  syncRangeValue(aoBiasInput, aoBiasValue, Math.round(state.aoBias * 100) / 100, formatSignedFixed2);
  syncRangeValue(aoPowerInput, aoPowerValue, Math.round(state.aoPower * 100) / 100, formatFixed2);
  syncRangeValue(aoDistanceInput, aoDistanceValue, state.aoDistance, formatTimes2);
  renderLightmapControls();
}

// Shared active-state sync for button groups  every data-driven toggle in the app
// (dither modes, preview modes, palette filters, resolution presets) goes through this.
function syncActiveButton(root: ParentNode | null, selector: string, isActive: (element: HTMLElement) => boolean): void {
  root?.querySelectorAll<HTMLElement>(selector).forEach((element) => element.classList.toggle('active', isActive(element)));
}

function setActiveMode(mode: DitherMode): void {
  syncActiveButton(document, '[data-mode]', (button) => button.dataset.mode === mode);
  // The dropdown trigger mirrors the selection, so the closed control always
  // reads as the current pattern (icon + label + chevron).
  modeSelect.innerHTML = `${modeRow(mode)}<span class="mode-chevron" aria-hidden="true"></span>`;
}

/** Closes the pattern dropdown without changing the selection. */
function closeModeDropdown(): void {
  modeDropdown.classList.remove('open');
  modeSelect.setAttribute('aria-expanded', 'false');
}

function renderTextureRibbon(): void {
  for (const channel of TEXTURE_CHANNELS) {
    const slotElement = document.querySelector<HTMLElement>(`[data-texture="${channel.id}"]`);
    if (!slotElement) continue;
    // The slot previews the committed lightmap, or any legacy in-memory
    // preview until reset. New lightmaps come from Orient Sun with Camera,
    // import, or the implicit re-bake on sun/ambient/normal changes.
    const data = channel.id === 'lightmap'
      ? textures.lightmap.image ?? renderer.getImplicitLightmapCanvas()
      : textures[channel.id].image;
    const preview = slotElement.querySelector<HTMLElement>('.texture-slot-preview');
    const label = slotElement.querySelector<HTMLElement>('.texture-slot-label');
    // Displacement is a fallback-plane-only feature  hide the slot entirely
    // while a model is loaded (models are never displaced) so it can't be
    // mistaken for a usable-but-locked slot. With no model it behaves like
    // the rest: the fallback quad's bakes consume every slot, so nothing is
    // ever grayed out in the no-model state.
    if (channel.id === 'displacement') {
      slotElement.hidden = modelBundle !== null;
      if (modelBundle !== null) continue;
    }
    slotElement.classList.toggle('filled', !!data);
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
        // Rendered once per import  the model doesn't change between ribbon
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
  if (state.showUVOverlapOriginal || state.showUVOverlapProcessed) render();
  updateTexelDensity();
}

// Sun/ambient state feeds the bake only  the 3D viewports never light the model
// in realtime. The baked lightmap (explicit or implicit) is multiplied into the
// texture by the 2D pipeline, and the viewport displays it under a neutral white
// fill; routing light state to the viewports would re-light an already-lit
// texture. See ModelViewport.
function applySun(): void {
  renderSunControl();
  renderOrientationReadout();
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
  const applyPane = (mode: PreviewMode, canvas: HTMLCanvasElement, host: HTMLDivElement, toggle: HTMLDivElement, badge: HTMLButtonElement): void => {
    const threeD = mode === '3d';
    host.hidden = !threeD;
    canvas.hidden = threeD;
    // The zoom badge is a 2D-only control  pan/zoom live on the texture
    // canvas, so a stale "100%" must not sit over the 3D view.
    badge.hidden = threeD;
    // The 2D/3D toggle is always visible  it switches between the flat
    // texture canvas and the 3D viewport, which holds either the loaded
    // model or the fallback quad when no model is present.
    toggle.hidden = false;
    syncActiveButton(toggle, '[data-preview-mode]', (button) => button.dataset.previewMode === mode);
  };
  applyPane(originalPreviewMode, originalCanvas, originalModelHost, originalPreviewToggle, originalZoomBadge);
  applyPane(processedPreviewMode, previewCanvas, processedModelHost, processedPreviewToggle, processedZoomBadge);
  const showHistograms = !narrowLayout.matches;
  originalLuminosityHistogram.hidden = !showHistograms || originalPreviewMode !== '2d';
  processedLuminosityHistogram.hidden = !showHistograms || processedPreviewMode !== '2d';
  // Shared viewport controls live on the Original pane and affect both 3D views.
  navigationToggle.hidden = originalPreviewMode !== '3d';
  // The floor grid toggle lives in the Original pane's control stack, so it
  // only shows while that pane is in 3D  never in the 2D texture view.
  floorGridToggle.hidden = originalPreviewMode !== '3d';
  renderFloorGridControl();
  renderWorldAxisControl();
  renderSunControl();
  renderQuadControl();
  renderUVOverlapControl();
  renderUVWireframeControl();
  renderRepeatControl();
  // The wireframe overlays mirror the panes' 2D/3D visibility.
  syncWireframeOverlays();
}

function closeModelPreview(): void {
  modelBundle?.revoke();
  // The model is gone from this point on  the quad rebuild below must run
  // with `modelBundle` cleared, since quad-view settings are a no-op while a
  // model is loaded (they must never touch non-fallback meshes).
  modelBundle = null;
  // The viewports stay alive for the app's lifetime  rebuild the configured
  // fallback quad (tessellation / grid / displacement) so the 2D/3D toggle
  // keeps working without a model, and rebuild the persistent bake quad so a
  // displacement change made while the model was loaded (e.g. a slot clear)
  // can't leave stale geometry behind.
  refreshFallbackQuads(true);
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
  // The fallback quad is the no-model default  clear the panes into the 3D
  // view so the flat quad is what remains after removing a model, instead of
  // dropping back to the 2D canvas.
  originalPreviewMode = '3d';
  processedPreviewMode = '3d';
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
      console.warn(`${bundle.primary.name} references ${missingReferences.length} ${fileLabel} not included with it  skipped`);
    }
    ensureViewports();
    forEachViewport((viewport) => viewport.setModel(cloneModelScene(loaded.scene), loaded.animations));
    forEachViewport((viewport) => viewport.applyLOD(state.lodLevel));
    applyViewNormals();
    applyViewportNormalMap();
    // Displacement is a fallback-plane-only feature  a map set before loading
    // the model stays in state and re-applies to the quad when the model is
    // closed, but the model itself is never displaced.
    // Keep a clone for the ribbon's mesh thumbnail  the loaded scene is
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
    // A model-carried normal map lands in the slot  re-bake the lightmap
    // with the existing sun angle.
    scheduleImplicitLightmapBake();
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

// Search-category view state  persisted with the settings (CONFIG_FIELDS) so
// the last filter, query, and sort survive app and browser restarts. The sort
// toggle cycles name A–Z → fewest colors first → most colors first.

function renderPalettes(): void {
  const catalog = paletteCatalog();
  const searching = state.paletteFilter === 'search';
  // The active chip always mirrors state.paletteFilter  restored settings,
  // revealPalette, and clicks all land here.
  syncActiveButton(paletteFilters, '[data-filter]', (button) => button.dataset.filter === state.paletteFilter);
  customPaletteSection.hidden = state.paletteFilter !== 'custom';
  paletteSearchControl.hidden = !searching;
  document.querySelector('#paletteCount')!.textContent = `${Object.keys(catalog).length} PRESETS`;
  let visiblePalettes = Object.entries(catalog).filter(([, palette]) => searching || palette.category === state.paletteFilter);
  if (searching) {
    paletteSortToggle.textContent = state.paletteSearchSort === 'name' ? 'A–Z' : state.paletteSearchSort === 'fewest' ? 'Fewest first' : 'Most first';
    const query = state.paletteSearchQuery.trim().toLowerCase();
    if (query) visiblePalettes = visiblePalettes.filter(([, palette]) => palette.name.toLowerCase().includes(query));
    visiblePalettes.sort(([aKey, a], [bKey, b]) => {
      const byName = a.name.localeCompare(b.name) || aKey.localeCompare(bKey);
      if (state.paletteSearchSort === 'fewest') return a.colors.length - b.colors.length || byName;
      if (state.paletteSearchSort === 'most') return b.colors.length - a.colors.length || byName;
      return byName;
    });
  }
  const customKeys = new Set(savedCustomPalettes.map((palette) => palette.key));
  paletteGrid.innerHTML = visiblePalettes.map(([key, palette]) => `
    <div class="palette-card ${key === state.paletteKey && state.customColors.length === 0 ? 'active' : ''}" data-palette="${escapeHtml(key)}" role="button" tabindex="0" aria-label="${escapeHtml(palette.name)}, ${palette.colors.length} colors">
      <span class="mini-swatches">${representativeColors(palette.colors).map((color) => `<i style="--swatch:${color}"></i>`).join('')}</span>
      <span class="palette-card-label">${customKeys.has(key) ? `<input class="palette-card-name" value="${escapeHtml(palette.name)}" maxlength="60" aria-label="Rename palette" data-rename-palette="${escapeHtml(key)}" />` : `<span>${escapeHtml(palette.name)}</span>`}<b>${palette.colors.length}</b><span class="palette-card-actions">
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

function sliderDefaultValue(key: string): number {
  const value = defaultConfigValues()[key as keyof ReturnType<typeof defaultConfigValues>];
  if (typeof value !== 'number') throw new Error(`Range control ${key} has no numeric default.`);
  // Strength is stored as 0–1 but displayed by its slider as 0–100.
  return key === 'strength' ? value * 100 : value;
}

function rangeDefaultAttrs(key: string, min: number, max: number): string {
  const value = sliderDefaultValue(key);
  const position = ((value - min) / (max - min)) * 100;
  return `data-default="${value}" style="--default-position:${position}%" title="Double-click to reset to ${value}"`;
}

// Single slider generator  every range control in the app goes through this.
// Renders a .control-row (title + optional hint + output) above a .range input.
function rangeControl(key: string, label: string, min: number, max: number, step: number | 'any', value: number, display: string = String(value), hint = ''): string {
  return `
    <div class="control-row">
      <label for="${key}"><span><strong>${label}</strong>${hint ? `<small>${hint}</small>` : ''}</span><output id="${key}Value" title="Click to type a value">${display}</output><input class="range-value-edit" id="${key}Edit" type="number" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label} value" hidden /></label>
      <input class="range" id="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" ${rangeDefaultAttrs(key, min, max)} aria-label="${label}" />
    </div>
  `;
}

// Single color-picker generator  visually-hidden input + live --swatch chip, matching the palette editor.
// Every color input in the app goes through this; syncColorChip keeps the chip in lockstep with the value.
function colorControl(value: string, ariaLabel: string, attrs: string = ''): string {
  return `<input class="hidden-input" type="color" value="${value}" aria-label="${ariaLabel}" ${attrs}/><span class="color-chip" style="--swatch:${value}"></span>`;
}
function syncColorChip(input: HTMLInputElement): void {
  input.nextElementSibling?.setAttribute('style', `--swatch:${input.value}`);
}

// Single toggle-switch generator  every checkbox toggle in the app goes through
// this. `wrapper` is 'label' when the switch is the whole control (AO-only /
// lightmap-only, preserving label click-to-toggle) and 'span' when nested inside
// a label row (UV / normals controls).
function toggleControl(id: string, ariaLabel: string, checked = false, wrapper: 'label' | 'span' = 'span', title = ''): string {
  const attrs = `class="toggle"${title ? ` title="${title}"` : ''}`;
  return `<${wrapper} ${attrs}><input id="${id}" type="checkbox"${checked ? ' checked' : ''} aria-label="${ariaLabel}" /></${wrapper}>`;
}

function renderAdjustments(): void {
  // The pixel grid controls lead the panel: the pixelization slider sits above
  // the resolution block, with the tone adjustments below it. Both grid
  // controls go through the same rangeControl generator as every other slider
  // (same label / output / click-to-edit markup), so they stay DRY with them.
  // The pixelization control uses a bespoke layout instead of rangeControl:
  // the label line spans the full row so the percentage right-aligns with the
  // upscale dropdown's edge, with the slider + dropdown on the line below.
  // The ids match rangeControl's, so the slider bindings and click-to-edit
  // keep working unchanged.
  document.querySelector('#pixelationControl')!.innerHTML = `
    <label for="pixelation"><span><strong>Pixelation</strong></span><output id="pixelationValue" title="Click to type a value">${formatPercent(state.pixelation)}</output><input class="range-value-edit" id="pixelationEdit" type="number" min="0" max="80" step="1" value="${state.pixelation}" aria-label="Pixelation value" hidden /></label>
    <input class="range" id="pixelation" type="range" min="0" max="80" step="1" value="${state.pixelation}" ${rangeDefaultAttrs('pixelation', 0, 80)} aria-label="Pixelation" />
  `;
  upscaleSelect.value = state.upscale;
  document.querySelector('#resolutionControl')!.innerHTML = rangeControl('resolution', 'Resolution', 24, 1024, 8, state.resolution, formatPixels(state.resolution));
  const controls: Array<[keyof Pick<State, 'brightness' | 'contrast' | 'saturation'>, string]> = [
    ['brightness', 'Brightness'], ['contrast', 'Contrast'], ['saturation', 'Saturation'],
  ];
  document.querySelector('#adjustmentControls')!.innerHTML = controls.map(([key, label]) =>
    rangeControl(key, label, -100, 100, 1, state[key], `${state[key] > 0 ? '+' : ''}${state[key]}`),
  ).join('');
}

function hydrateCustomDraft(name: string, colors: string[], key: string | null = null): void {
  editingCustomKey = key;
  draftName = name;
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
      ? updateCustomPalette(existing, draftName, currentColors())
      : createCustomPalette(draftName, currentColors(), new Date(), editingCustomKey ?? undefined);
    if (tauriStore) {
      // Desktop: one .hex file per palette  the file name IS the palette
      // name. Renaming deletes the old file; identity (key) follows the name.
      const filePalette = persistPaletteFile(palette, existing?.name);
      commitPaletteSelection(filePalette.key, filePalette);
    } else {
      persistCustomPaletteWeb(palette);
      commitPaletteSelection(palette.key, palette);
    }
  } catch (error) {
    console.error('Could not save custom palette.', error);
  }
}

// Serializes palette file writes so a quick rename/delete/edit can't
// interleave on disk: each operation runs only after the previous one
// completes, keeping the folder converged with the in-memory library.
let paletteFileQueue: Promise<void> = Promise.resolve();

/** Queues one palette file operation (write/delete); failures are logged and
 * the queue keeps running, like the web build's localStorage writes. */
function enqueuePaletteFileWrite(operation: () => Promise<void>): void {
  paletteFileQueue = paletteFileQueue.then(operation).catch((error) => {
    console.error('Could not save palette file.', error);
  });
}

/** Desktop: replaces the palette's file (removing the old one when renamed)
 * and updates the in-memory library synchronously. The new file is written
 * before the old one is deleted, so a crash can only leave a stale duplicate
 * (harmless on next boot), never lose the palette. */
function persistPaletteFile(palette: CustomPalette, previousName?: string): CustomPalette {
  const filePalette = filePaletteFor(palette);
  savedCustomPalettes = savedCustomPalettes
    .filter((entry) => entry.key !== filePalette.key && entry.name !== filePalette.name && entry.name !== previousName)
    .concat(filePalette);
  enqueuePaletteFileWrite(async () => {
    await saveCustomPaletteFile(tauriStore!, filePalette);
    if (previousName && previousName !== filePalette.name) {
      await deleteCustomPaletteFile(tauriStore!, previousName);
    }
  });
  return filePalette;
}

function commitPaletteSelection(key: string, palette: CustomPalette): void {
  setPaletteKey(key);
  hydrateEditorForSelection(key, palette);
  renderPalettes();
  render();
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
  // Posterize is adaptive  duplicating it copies the *generated* colors as a
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
    // The .hex file is named after the palette  importing it back derives
    // the palette name from the file name.
    downloadText(serializePaletteHex(palette), paletteFileName(palette.name), 'text/plain');
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
  draftName = selectedCustom?.name ?? fallback.name;
}

function selectPalette(key: string): void {
  setPaletteKey(key);
  hydrateEditorForSelection(key, currentPalette());
  renderPalettes();
  render();
}

paletteEditorToggle.addEventListener('click', () => {
  const collapsed = customPaletteSection.classList.toggle('collapsed');
  paletteEditorToggle.setAttribute('aria-expanded', String(!collapsed));
});

function removeCustomPalette(key: string): void {
  try {
    if (tauriStore) {
      const palette = customPaletteByKey(key);
      savedCustomPalettes = savedCustomPalettes.filter((entry) => entry.key !== key);
      if (palette) {
        // Queued behind pending writes so a delete can't be undone by an
        // earlier edit still landing on disk.
        enqueuePaletteFileWrite(async () => {
          await deleteCustomPaletteFile(tauriStore!, palette.name);
        });
      }
    } else {
      savedCustomPalettes = deleteCustomPalette(appStorage, key);
    }
    if (editingCustomKey === key) editingCustomKey = null;
    if (state.paletteKey === key) {
      setPaletteKey('desert');
      draftName = '';
    }
    renderPalettes();
    render();
  } catch (error) {
    console.error('Could not delete custom palette.', error);
  }
}

/** Applies a palette-library reload from disk: manual `.hex` file drops,
 * edits or removals in the palettes folder (see watchPalettesFolder). When
 * the active palette's file was removed, fall back like removeCustomPalette
 * does; otherwise the grid re-renders in place. */
function applyPaletteLibraryReload(palettes: CustomPalette[]): void {
  const activeWasCustom = customPaletteByKey(state.paletteKey) !== undefined;
  savedCustomPalettes = palettes;
  if (activeWasCustom && customPaletteByKey(state.paletteKey) === undefined) {
    setPaletteKey('desert');
    draftName = '';
    editingCustomKey = null;
    render();
  }
  renderPalettes();
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
  /** Trailing debounce for the apply  the readout updates live while the
   * value changes, but the (possibly heavy) apply runs once at rest. Used by
   * the quad-tessellation slider, which rebuilds geometry per change. */
  debounce?: number;
  /** Release-only apply: the readout updates live while the value changes,
   * but the apply (and render) waits for the change event on release. Used by
   * the dither-parameter sliders, whose full re-dither is expensive. */
  live?: boolean;
};

// Shared render-side sync for a range input + its value output  the mirror of
// `bindRange` (listener side). Every control render that writes both fields in
// lockstep goes through this.
function syncRangeValue(input: HTMLInputElement, output: HTMLElement, value: number, format: (value: number) => string): void {
  input.value = String(value);
  output.textContent = format(value);
  // The click-to-edit number field mirrors the raw value, so opening it after
  // any programmatic change shows the live value, not a stale one.
  const edit = document.querySelector<HTMLInputElement>(`#${output.id.replace(/Value$/, '')}Edit`);
  if (edit) edit.value = String(value);
}

/** Double-click-to-reset: restores the slider to its `data-default` value by
 * dispatching synthetic input+change events, so whichever binding owns the
 * slider applies the reset through its own handlers. Shared by every slider
 * type (dither/AO via bindRange, lighting via bindLightIntensity). */
function bindRangeReset(input: HTMLInputElement): void {
  input.addEventListener('dblclick', (event) => {
    event.preventDefault();
    const defaultValue = input.dataset.default;
    if (defaultValue === undefined) throw new Error(`Range control ${input.id} has no default value.`);
    input.value = defaultValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function bindRange({ input, output, format, apply, debounce, live = true }: RangeBinding): void {
  let timer = 0;
  const sync = (value: number): void => {
    apply(value);
    output.textContent = format(value);
    renderScheduler.request();
  };
  input.addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    if (!live) {
      // Release-only sliders (the dither parameters): the readout keeps pace
      // with the drag, but the heavy apply waits for the change event.
      output.textContent = format(value);
    } else if (debounce) {
      // The readout keeps pace with the drag; the apply fires once at rest.
      output.textContent = format(value);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = 0; apply(value); renderScheduler.request(); }, debounce);
    } else {
      sync(value);
    }
  });
  bindRangeReset(input);
  input.addEventListener('change', () => {
    // Release flushes a still-pending debounced apply with the final value.
    if (debounce && timer) {
      window.clearTimeout(timer);
      timer = 0;
      apply(input.valueAsNumber);
      renderScheduler.request();
    }
    if (!live) apply(input.valueAsNumber);
    renderScheduler.flush();
  });
  // Direct numeric entry  every generated slider gets click-to-edit for free.
  bindRangeValueEdit(input, output, apply, format);
}

/** Direct numeric entry for a generated slider: clicking the formatted value
 * swaps it for a number input pre-filled with the raw value; Enter/blur
 * commits (clamped to the slider's min/max and snapped to its step), Esc
 * cancels and restores the readout. The edit input id is derived from the
 * output's `${key}Value` id, so every rangeControl slider gains this without
 * extra wiring. */
function bindRangeValueEdit(input: HTMLInputElement, output: HTMLElement, apply: (value: number) => void, format: (value: number) => string): void {
  const edit = document.querySelector<HTMLInputElement>(`#${output.id.replace(/Value$/, '')}Edit`);
  if (!edit) return;
  const commit = (): void => {
    // 'change' and 'blur' both fire when the input loses focus  the hidden
    // flag makes the second arrival a no-op.
    if (edit.hidden) return;
    edit.hidden = true;
    output.hidden = false;
    const min = edit.min !== '' ? Number(edit.min) : -Infinity;
    const max = edit.max !== '' ? Number(edit.max) : Infinity;
    const step = edit.step !== '' && edit.step !== 'any' ? Number(edit.step) : 0;
    let value = Number(edit.value);
    if (!Number.isFinite(value)) value = input.valueAsNumber;
    value = clamp(value, min, max);
    if (step > 0) value = Number((Math.round(value / step) * step).toFixed(6));
    input.value = String(value);
    apply(value);
    output.textContent = format(value);
    renderScheduler.request();
  };
  output.addEventListener('click', (event) => {
    // Disabled sliders (e.g. the world-space noise scale lock) are read-only.
    if (input.disabled) return;
    // preventDefault stops the wrapping <label for> from forwarding the click
    // to the range input  the edit field takes focus instead.
    event.preventDefault();
    edit.value = String(input.valueAsNumber);
    edit.hidden = false;
    output.hidden = true;
    edit.focus();
    edit.select();
  });
  edit.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      edit.hidden = true;
      output.hidden = false;
      edit.value = String(input.valueAsNumber);
    }
  });
  edit.addEventListener('blur', commit);
  edit.addEventListener('change', commit);
}

function syncControlsFromState(): void {
  syncRangeValue(strengthInput, strengthValue, Math.round(state.strength * 100), formatPercent);
  syncRangeValue(stripeAngleInput, stripeAngleValue, state.stripeAngle, formatDegrees);
  syncRangeValue(worldspaceScaleInput, worldspaceScaleValue, state.worldspaceScale, formatCellsPerUnit);
  syncRangeValue(uvScaleInput, uvScaleValue, state.uvScale, formatCellsPerPixel);
  syncActiveButton(patternSpaceToggle, '[data-pattern-space]', (button) => button.dataset.patternSpace === state.patternSpace);
  syncRangeValue(seedInput, seedValue, state.seed, formatPlain);
  setActiveMode(state.mode);
  updatePatternControls();
  updateAOControls();
  renderSunControl();
  renderNormalControls();
  renderAdjustments();
  bindAdjustmentEvents();
  renderPalettes();
  paletteSearchInput.value = state.paletteSearchQuery;
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

/** Captures an orbit viewport's camera as a serializable view: world position
 * plus the orbit target  together they determine both the camera angle and
 * its position (the up axis is fixed, so the quaternion is implied). */
function savedCameraOf(viewport: ModelViewport | null | undefined): SavedCamera | undefined {
  if (!viewport) return undefined;
  const snapshot = viewport.captureCamera();
  return {
    position: { x: snapshot.position.x, y: snapshot.position.y, z: snapshot.position.z },
    target: { x: snapshot.target.x, y: snapshot.target.y, z: snapshot.target.z },
  };
}

function currentConfig() {
  return {
    ...collectConfigValues(state),
    paletteKey: state.paletteKey,
    palette: activePaletteSnapshot(),
    originalCamera: savedCameraOf(originalViewport),
    processedCamera: savedCameraOf(processedViewport),
  };
}

async function saveConfig(): Promise<void> {
  const content = serializeConfig();
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: CONFIG_FILE_NAME, types: [CONFIG_FILE_TYPE] });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // user cancelled
      // The system dialog can be blocked even where the API exists
      // (NotAllowedError / SecurityError in restricted or embedded contexts):
      // fall back to the plain download so the browser keeps working.
      console.warn('The system save dialog could not be used; downloading the settings file instead.', error);
    }
  }
  await downloadText(content, CONFIG_FILE_NAME);
}

async function loadConfig(): Promise<void> {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [CONFIG_FILE_TYPE], multiple: false });
      await applyConfigFile(await handle.getFile());
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // user cancelled
      // Same fallback as saveConfig: a blocked picker drops back to the
      // plain hidden file input so loading keeps working.
      console.warn('The system file picker could not be used; falling back to the plain file input.', error);
    }
  }
  loadConfigInput.click();
}

async function applyPreset(preset: ConversionPreset): Promise<void> {
  renderScheduler.cancel();
  let paletteSelection: { key: string; customPalettes: CustomPalette[]; created: boolean };
  if (tauriStore) {
    // Desktop: embedded palettes persist as .hex files named after the palette.
    const match = matchingPaletteKey(paletteCatalog(), preset.palette.colors, preset.paletteKey);
    if (match) {
      paletteSelection = { key: match, customPalettes: savedCustomPalettes, created: false };
    } else {
      const filePalette = persistPaletteFile(createCustomPalette(preset.palette.name.slice(0, 60), preset.palette.colors));
      paletteSelection = { key: filePalette.key, customPalettes: savedCustomPalettes, created: true };
    }
  } else {
    paletteSelection = selectOrCreatePalette(appStorage, paletteCatalog(), preset.palette, preset.paletteKey);
  }
  const paletteKey = paletteSelection.key;
  savedCustomPalettes = paletteSelection.customPalettes;
  applyConfigValues(state, preset as unknown as Readonly<Record<string, unknown>>);
  setPaletteKey(paletteKey);
  const selectedPalette = paletteCatalog()[paletteKey];
  hydrateEditorForSelection(paletteKey, selectedPalette);
  syncControlsFromState();
  applyViewportNormalMap();
  applySun();
  updateResolution(preset.resolution, true);
  // The UV-channel selection is model-specific (like LOD and the model up
  // axis) and intentionally not part of the saved settings  it is left
  // untouched when a settings file loads.
  // The fallback quad is the implicit model when none is loaded: sync its
  // panel and rebuild the installed quad with the loaded settings (both are
  // no-ops while a model is loaded).
  renderQuadControl();
  refreshFallbackQuads(true, true);
  // Saved orbit-camera views (angle + position) for both viewports, restored
  // only when the file carries them  files saved before camera capture
  // existed leave the current view alone.
  if (preset.originalCamera && originalViewport) {
    originalViewport.restoreCameraView(preset.originalCamera.position, preset.originalCamera.target);
  }
  if (preset.processedCamera && processedViewport) {
    processedViewport.restoreCameraView(preset.processedCamera.position, preset.processedCamera.target);
  }
}

const renderer = createRenderer({
  state,
  textures,
  previewCanvas,
  originalCanvas,
  luminosityHistograms: {
    original: originalLuminosityCanvas,
    processed: processedLuminosityCanvas,
  },
  showLuminosityHistograms: () => !narrowLayout.matches,
  wireframeOverlays: {
    original: originalWireframeOverlay,
    processed: processedWireframeOverlay,
  },
  getAOScene: () => aoBakeScene,
  getBakeSurface: () => aoBakeScene ?? bakeFallbackQuad,
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
  repeatTextureOriginal: () => repeatTextureOriginal,
  repeatTextureProcessed: () => repeatTextureProcessed,
});

const {
  render: renderPipeline,
  applyViewportImages,
  generateAo,
  bakeLighting,
  clearLightmap,
  refreshUVWireframe,
  refreshUVOverlap,
  invalidateBakeScene,
  invalidateUVOverlap,
  invalidateUVStretch,
  syncWireframeOverlays,
  resetPreview,
} = renderer;

// Every state change funnels through `render` (sync) or the render scheduler
// (debounced, wrapping the same function), so this single wrapper catches all
// of them. A debounced settings auto-save piggybacks on it  the config file
// on desktop, localStorage in the web build (Save/Load stays for sharing).
function render(): void {
  renderPipeline();
  scheduleSettingsSave();
}

// AO bakes rasterize the texture in worker bands  the AO slot's Bake button
// holds a gray-out + throbber while the bands finish (same treatment as Orient
// Sun with Camera), so the workspace stays clickable. The disabled button also
// blocks a redundant second bake; the flag clears when the bake settles, on
// success AND failure.
function setAoBakeBusy(busy: boolean): void {
  const button = document.querySelector<HTMLButtonElement>('[data-bake-texture="ao"]');
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('busy', busy);
}

async function generateAoWithProgress(): Promise<boolean> {
  setAoBakeBusy(true);
  try {
    return await generateAo();
  } finally {
    setAoBakeBusy(false);
  }
}

// AO can be generated from its texture slot. The lightmap slot has no Bake
// button: lightmaps come from Orient Sun with Camera, import, or the implicit
// re-bake on sun/ambient/normal changes.
const bakeActions: Partial<Record<TextureChannelId, () => Promise<boolean>>> = {
  ao: generateAoWithProgress,
};

const renderScheduler = createRenderScheduler(render);

function updateResolution(value: number, immediate = false): void {
  state.resolution = value;
  syncRangeValue(document.querySelector('#resolution') as HTMLInputElement, document.querySelector('#resolutionValue')!, value, formatPixels);
  syncActiveButton(document, '[data-resolution]', (button) => Number(button.dataset.resolution) === value);
  if (immediate) renderScheduler.flush();
  else renderScheduler.request();
  // Resolution changes only resample the existing lighting map. Baking is an
  // explicit or lighting-input action, never a side effect of output sizing.
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
    // The slot X is a hard remove: stay unlit until Orient Sun with Camera
    // explicitly bakes again, the user loads a lightmap, or a reset. The
    // implicit scheduler stays quiet while lightmapCleared is set, so a slider
    // move does not resurrect it; cancel any pending debounce so one that
    // fired before the X cannot override the clear.
    clearLightmap(true);
    cancelImplicitLightmapBake();
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
      applyViewportNormalMap();
      // The lightmap samples the slot's map  removing it re-bakes with the
      // existing sun angle.
      scheduleImplicitLightmapBake();
    }
    if (channel === 'displacement') applyDisplacementChange();
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
      applyViewportNormalMap();
      // The lightmap samples the slot's map  adding or replacing it re-bakes
      // with the existing sun angle.
      scheduleImplicitLightmapBake();
    }
    if (channel === 'displacement') applyDisplacementChange();
    renderTextureRibbon();
    render();
  } catch (error) {
    console.error('Could not load image.', error);
  }
}

function reset(): void {
  renderScheduler.cancel();
  cancelImplicitLightmapBake();
  Object.assign(state, defaultState(), { paletteSnapshot: undefined });
  textures.lightmap.image = null;
  textures.lightmap.name = '';
  // Full reset drops cached render and legacy lightmap preview state.
  resetPreview();
  invalidateModelCaches();
  renderTextureRibbon();
  editingCustomKey = null;
  draftName = '';
  syncControlsFromState();
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

  const pixelationInput = document.querySelector<HTMLInputElement>('#pixelation');
  const pixelationOutput = document.querySelector<HTMLElement>('#pixelationValue');
  if (pixelationInput && pixelationOutput) {
    bindRange({
      input: pixelationInput,
      output: pixelationOutput,
      format: formatPercent,
      // 0% is off; higher values downscale the source more before the
      // nearest-neighbor upscale back to full resolution. Snap any typed
      // decimal and keep the viewport normals map in sync with the amount.
      apply: (value) => {
        state.pixelation = Math.max(0, Math.min(80, Math.round(value)));
        applyViewportNormalMap();
      },
    });
  }

  // The resolution slider, value output and click-to-edit are regenerated by
  // renderAdjustments on every sync, so they are re-bound here (like the
  // adjustment sliders above) instead of once at module scope  a module-scope
  // binding would be detached by the next regeneration.
  const resolutionInput = document.querySelector<HTMLInputElement>('#resolution');
  const resolutionOutput = document.querySelector<HTMLElement>('#resolutionValue');
  if (resolutionInput && resolutionOutput) {
    bindRange({
      input: resolutionInput,
      output: resolutionOutput,
      format: formatPixels,
      apply: (value) => updateResolution(value),
    });
    bindRangeValueEdit(resolutionInput, resolutionOutput, updateResolution, formatPixels);
  }
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

// ---------------------------------------------------------------------------
// Desktop install-folder persistence: settings auto-save + palette store
// ---------------------------------------------------------------------------

const SETTINGS_FILE = `${CONFIG_FOLDER}/settings.json`;
/** Web build: settings auto-save lives in localStorage (the settings payload
 * embeds the full palette and camera views, so it can exceed cookie limits). */
const SETTINGS_STORAGE_KEY = 'ultipixelizer-settings';
const SETTINGS_SAVE_DELAY = 800;
let settingsSaveTimer = 0;

function showStorageNotice(message: string): void {
  storageNotice.textContent = message;
  storageNotice.hidden = false;
}

/** Boot-time banner for a missing or broken WASM palette scan. The seamless
 * dither still runs, but on the byte-identical JS linear scan, which at 256
 * colors and 1k costs seconds per render. That regression must never pass
 * silently: `npm run build:wasm` produces the artifact, and the predev hook
 * builds it on demand, so this banner only appears in genuinely broken setups. */
function showWasmNotice(message: string): void {
  wasmNotice.textContent = message;
  wasmNotice.hidden = false;
}

/** Web build: saves a palette to localStorage; when storage is full or
 * blocked it stays in the in-memory library for the session and the existing
 * notice says so loudly, instead of the save failing silently. The palette
 * works now, it just won't survive a reload. Desktop writes go through the
 * file queue and never reach here. */
function persistCustomPaletteWeb(palette: CustomPalette): void {
  try {
    savedCustomPalettes = upsertCustomPalette(appStorage, palette);
  } catch (error) {
    console.error('Could not save custom palette.', error);
    showStorageNotice('Palettes could not be saved: browser storage is full or blocked. They will not persist after this session.');
    const index = savedCustomPalettes.findIndex((existing) => existing.key === palette.key);
    if (index >= 0) savedCustomPalettes[index] = palette;
    else savedCustomPalettes.push(palette);
  }
}

/** Trailing debounce: settings save ~800ms after the last change. Runs on
 * desktop (config file) and in the web build (localStorage). */
function scheduleSettingsSave(): void {
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = 0;
    void persistSettings();
  }, SETTINGS_SAVE_DELAY);
}

async function persistSettings(): Promise<void> {
  const content = serializeConfig();
  if (tauriStore) {
    try {
      await tauriStore.write(SETTINGS_FILE, content);
    } catch (error) {
      console.error('Could not save settings.', error);
    }
    return;
  }
  try {
    appStorage.setItem(SETTINGS_STORAGE_KEY, content);
  } catch (error) {
    // The settings stay live for the session; the notice says they won't
    // survive a reload instead of the save failing silently.
    console.error('Could not save settings.', error);
    showStorageNotice('Settings could not be saved: browser storage is full or blocked.');
  }
}

/** Moves palettes from the webview's localStorage (pre-file-store versions)
 * into the palettes folder once, then drops the old copy. Idempotent: skipped
 * when the folder already holds palettes. */
async function migrateLocalStoragePalettes(): Promise<number> {
  const legacy = loadCustomPalettes(localStorage);
  if (legacy.length === 0 || savedCustomPalettes.length > 0) return 0;
  for (const palette of legacy) await saveCustomPaletteFile(tauriStore!, palette);
  localStorage.removeItem(CUSTOM_PALETTE_STORAGE_KEY);
  return legacy.length;
}

/** One-time migration from the pre-folder layout (flat files at the data
 * root): `settings.json` moves into `config/`, and the single
 * `custom-palettes.json` array is split into per-palette `.hex` files. */
async function migrateLegacyDataFiles(store: TauriFileStore): Promise<void> {
  const legacySettings = await store.preload('settings.json');
  if (legacySettings !== null) {
    await store.write(SETTINGS_FILE, legacySettings);
    await store.remove('settings.json');
  }
  const legacyPalettes = await store.preload('custom-palettes.json');
  if (legacyPalettes === null) return;
  try {
    const parsed: unknown = JSON.parse(legacyPalettes);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!isCustomPalette(entry)) continue;
      await saveCustomPaletteFile(store, entry);
    }
    await store.remove('custom-palettes.json');
  } catch {
    // Not our format  leave the file for manual inspection.
  }
}

async function restoreSettings(): Promise<void> {
  try {
    const raw = tauriStore ? await tauriStore.preload(SETTINGS_FILE) : appStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) await applyPreset(parsePreset(raw));
  } catch (error) {
    console.error('Could not restore settings.', error);
  }
}

/** Desktop boot: load the palette library from the palettes folder (one .hex
 * file per palette), migrate any legacy flat files and localStorage palettes,
 * and restore the last-saved settings. Falls back (loudly) to the per-user
 * app-data dir when the installation folder isn't writable  Program Files
 * MSI installs, macOS bundles, AppImage. */
async function bootDesktopStorage(): Promise<void> {
  const store = await initTauriFileStore();
  if (!store) {
    // Web build keeps localStorage: restore the last-saved settings.
    await restoreSettings();
    return;
  }
  tauriStore = store;
  if (store.location !== 'install') {
    showStorageNotice(
      `The installation folder is not writable on this system (Program Files, app bundle or AppImage install). Settings and palettes are stored in ${store.dir} instead.`,
    );
  }
  try {
    await migrateLegacyDataFiles(store);
    savedCustomPalettes = await loadCustomPalettesFromFiles(store);
    const migrated = await migrateLocalStoragePalettes();
    if (migrated > 0) savedCustomPalettes = await loadCustomPalettesFromFiles(store);
    renderPalettes();
    console.info(`Palette library stored in ${store.dir}${migrated > 0 ? ` (${migrated} migrated from browser storage)` : ''}.`);
  } catch (error) {
    console.error('Custom palettes could not be loaded from the data store.', error);
  }
  await restoreSettings();
  // Live watch: `.hex` files dropped into the palettes folder from the OS
  // file manager appear in the library without an app restart (see
  // applyPaletteLibraryReload). Restored settings are applied first so the
  // watcher's baseline reflects the restored library.
  watchPalettesFolder(store, applyPaletteLibraryReload);
}

syncControlsFromState();
ensureViewports();
// Install the configured fallback quad (tessellation / grid / displacement)
// into the bake layer and the viewports before the first render.
refreshFallbackQuads(true);
renderTextureRibbon();
applyPreviewMode();
render();
// The texel-density HUD shows its plane message in the no-model state  it
// must run at boot, before the example model (if it loads) replaces it.
updateTexelDensity();
// Desktop: the webview's native browser context menu (Back/Refresh/Save
// As/Print) has no place in an app window  suppress it (the web build keeps
// the browser's own menu). Registered before boot so no right-click can slip
// through while desktop storage initializes.
disableWebviewContextMenu();
// Desktop: install-folder persistence  the palette library reloads from the
// data files, legacy palettes migrate, and the last-saved settings restore
// (web build: no-op). Kicked off before the example assets so the restored
// config is usually applied before the example model finishes loading.
// Load the f64 SIMD palette scan (WASM) in the background so the seamless
// dither can use it instead of the JS linear scan once it's ready. The dither
// falls back to the byte-identical JS scan until the module is ready, but a
// load failure is a real performance regression (seconds per render at 256
// colors / 1k), so it surfaces as a persistent banner instead of passing
// silently. `npm run build:wasm` (or the predev hook) produces the artifact.
void initDitherWasm().then((active) => {
  if (!active) {
    showWasmNotice('WASM palette scan unavailable; the slower JS scan is in use. Build it with `npm run build:wasm` (requires the Rust toolchain), then reload.');
  }
});
void bootDesktopStorage();
void loadExampleAssets();

// The resolution preset chips are static (never regenerated), so they bind
// once here; the slider, value output and click-to-edit are re-bound on every
// sync inside bindAdjustmentEvents, after renderAdjustments regenerates them.
document.querySelectorAll<HTMLButtonElement>('[data-resolution]').forEach((button) => button.addEventListener('click', () => updateResolution(Number(button.dataset.resolution), true)));
bindRange({
  input: strengthInput,
  output: strengthValue,
  format: formatPercent,
  live: false,
  apply: (value) => { state.strength = value / 100; },
});
bindRange({
  input: stripeAngleInput,
  output: stripeAngleValue,
  format: formatDegrees,
  live: false,
  apply: (value) => { state.stripeAngle = value; },
});
bindRange({
  input: worldspaceScaleInput,
  output: worldspaceScaleValue,
  format: formatCellsPerUnit,
  live: false,
  apply: (value) => { state.worldspaceScale = value; },
});
bindRange({
  input: uvScaleInput,
  output: uvScaleValue,
  format: formatCellsPerPixel,
  live: false,
  apply: (value) => { state.uvScale = value; },
});
bindRange({
  input: seedInput,
  output: seedValue,
  format: formatPlain,
  live: false,
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
  input: quadTessellationInput,
  output: quadTessellationValue,
  format: (value) => `${value} × ${value}`,
  apply: (value) => {
    state.quadTessellation = value;
    // Tessellation changes the vertex count and  with a displacement map 
    // the geometry bounds, so a refit would nudge the camera; keep it put.
    refreshFallbackQuads(true, true);
  },
  debounce: 150,
});
quadGridInput.addEventListener('change', () => {
  state.quadGrid = quadGridInput.checked;
  // The grid changes the scene extent (1 tile ↔ 9)  keep the camera put.
  // refreshFallbackQuads re-applies the current texture to the swapped quads
  // synchronously (applyViewportImages), so no render is needed here. The
  // quad settings are persisted, so the debounced settings save still fires.
  refreshFallbackQuads(true, true);
  scheduleSettingsSave();
});
displacementFlipInput.addEventListener('change', () => {
  state.displacementFlip = displacementFlipInput.checked;
  // In-place displacement re-apply  flipping inverts the surface but not its
  // extent, so no camera refit (same as the strength slider). Persist the
  // change without re-rendering the pipeline (see the grid toggle).
  applyDisplacementChange();
  scheduleSettingsSave();
});
bindRange({
  input: displacementStrengthInput,
  output: displacementStrengthValue,
  format: formatFixed2,
  // At high tessellation (e.g. 128×128) a single apply re-runs the full
  // displacement pass  per-vertex height sampling, normal recompute, sphere
  // refit  across the bake quad and both viewports, so applying on every
  // input event janks the drag. Debounce like the tessellation slider: the
  // readout tracks live, the mesh catches up at rest.
  debounce: 150,
  apply: (value) => {
    state.displacementStrength = value;
    applyDisplacementChange();
  },
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
  // GL/DX flips how the map decodes into the bake, so the lightmap re-bakes
  // with the existing sun angle.
  scheduleImplicitLightmapBake();
  applyViewportNormalMap();
});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  state.mode = button.dataset.mode as DitherMode;
  setActiveMode(state.mode);
  updatePatternControls();
  closeModeDropdown();
  render();
}));
// The UV/World toggle switches coordinate-pattern modes between image-space
// sampling and triplanar world-space projection; it only shows for pattern modes.
document.querySelectorAll<HTMLButtonElement>('[data-pattern-space]').forEach((button) => button.addEventListener('click', () => {
  state.patternSpace = button.dataset.patternSpace as 'uv' | 'world';
  syncActiveButton(patternSpaceToggle, '[data-pattern-space]', (candidate) => candidate.dataset.patternSpace === state.patternSpace);
  updatePatternControls();
  render();
}));
// The trigger toggles the dropdown; picking an option applies it and closes
// (above). Outside clicks and Escape close without changing the selection.
modeSelect.addEventListener('click', () => {
  const open = modeDropdown.classList.toggle('open');
  modeSelect.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (event) => {
  if (!modeDropdown.contains(event.target as Node)) closeModeDropdown();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modeDropdown.classList.contains('open')) {
    closeModeDropdown();
    modeSelect.focus();
  }
});
// The upscale method is the pixelization slider's sibling: switching it
// re-syncs the processed viewport normals map and re-renders the 2D panes.
upscaleSelect.addEventListener('change', () => {
  state.upscale = upscaleSelect.value as UpscaleMethod;
  applyViewportNormalMap();
  render();
});
paletteFilters.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (!button?.dataset.filter) return;
  state.paletteFilter = button.dataset.filter as PaletteCategory;
  renderPalettes();
  scheduleSettingsSave();
});
paletteSearchInput.addEventListener('input', () => {
  state.paletteSearchQuery = paletteSearchInput.value;
  renderPalettes();
  scheduleSettingsSave();
});
paletteSortToggle.addEventListener('click', () => {
  state.paletteSearchSort = state.paletteSearchSort === 'name' ? 'fewest' : state.paletteSearchSort === 'fewest' ? 'most' : 'name';
  renderPalettes();
  scheduleSettingsSave();
});
paletteGrid.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('.palette-card-name')) return;
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
  if (target.closest('.palette-card-name')) {
    // Rename fields handle their own keys: Enter commits, Space types.
    if (event.key === 'Enter') target.blur();
    return;
  }
  const card = target.closest<HTMLElement>('[data-palette]');
  if (!card?.dataset.palette || target.closest('button')) return;
  event.preventDefault();
  selectPalette(card.dataset.palette);
});
// Custom palettes rename directly on their card: the name is an inline input
// that commits on Enter/blur.
paletteGrid.addEventListener('change', (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('.palette-card-name');
  const key = input?.dataset.renamePalette;
  if (!key) return;
  const palette = customPaletteByKey(key);
  if (!palette) return;
  const name = input.value.trim() || palette.name;
  if (name === palette.name) {
    input.value = palette.name;
    return;
  }
  const updated = updateCustomPalette(palette, name, palette.colors);
  if (tauriStore) {
    // Renaming renames the palette's .hex file: identity follows the name.
    const filePalette = persistPaletteFile(updated, palette.name);
    if (editingCustomKey === key) editingCustomKey = filePalette.key;
    if (state.paletteKey === key) draftName = filePalette.name;
  } else {
    persistCustomPaletteWeb(updated);
    if (state.paletteKey === key) draftName = name;
  }
  renderPalettes();
  render();
});
// The native color picker is replaced by the in-app picker above the chip row:
// suppress the hidden inputs' default actions (mouse and keyboard) so the OS
// dialog never opens  the chips just select the color being edited.
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
    // Suppress the hidden input's default action (opening the OS picker) 
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
// overlay indicators (dot/line)  the field and strip themselves are the UI.
function updatePickerFieldHue(): void {
  colorPickerField.style.setProperty('--field-hue', rgbToHex(...hsvToRgb(pickerHsv[0], 100, 100)));
}

// Read a color into the picker in HSV space, carrying the last hue over when
// the color is achromatic (white/black/gray) so it isn't lost at the
// pure-white corner. Always reason in HSV  never reconstruct hue from RGB.
function syncPickerToColor(hex: string): void {
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
// The button under the hue bar is an eyedropper. The native EyeDropper API
// samples anywhere on screen, but its picker takes ~1s to appear in
// Chromium/WebView2 (browser-internal startup, not fixable from JS). Instead
// we run a custom pick mode: the OS cursor itself becomes the dropper icon
// and sampling the app's own rendering is instant  exact pixels from the
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

/** Samples a 2D preview canvas under the cursor using the preview's
 * transform-aware mapping. The generic eyedropper assumes an untransformed
 * object-fit canvas, which drifts once the preview is zoomed/panned. */
function sample2DPreviewColor(element: Element | null, clientX: number, clientY: number): string | null {
  let canvas: HTMLCanvasElement;
  let preview: Preview2DApi;
  if (element === originalCanvas) {
    canvas = originalCanvas;
    preview = originalPreview2D;
  } else if (element === previewCanvas) {
    canvas = previewCanvas;
    preview = processedPreview2D;
  } else {
    return null;
  }
  const coords = preview.toCanvasPixel(clientX, clientY);
  if (!coords) return null;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const [r, g, b, a] = context.getImageData(coords.x, coords.y, 1, 1).data;
  if (a === 0) return null;
  return rgbToHex(r, g, b);
}

function eyedropperPick(event: PointerEvent): void {
  if (event.button !== 0) {
    // Right/middle click cancels.
    eyedropperCancel();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const hex = sample2DPreviewColor(element, event.clientX, event.clientY) ?? sampleColorAt(event.clientX, event.clientY);
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

const importCustomPaletteInput = document.querySelector<HTMLInputElement>('#importCustomPalette')!;
importCustomPaletteInput.addEventListener('change', async () => {
  const file = importCustomPaletteInput.files?.[0];
  if (!file) return;
  try {
    if (file.size > 100_000) throw new Error('Palette file is too large.');
    const palette = paletteFromImport(await file.text(), file.name);
    if (tauriStore) {
      // Imported palettes persist as .hex files named after the palette.
      const filePalette = persistPaletteFile(palette);
      state.paletteKey = filePalette.key;
      beginCustomDraft(filePalette.name, filePalette.colors, filePalette.key);
    } else {
      persistCustomPaletteWeb(palette);
      state.paletteKey = palette.key;
      beginCustomDraft(palette.name, palette.colors, palette.key);
    }
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
  // AO and lightmap can be generated in-app  bake on demand, then download.
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
// dragenter/dragover (which bubble from slot children  including the
// thumbnail canvases of already-filled slots) re-derive the hovered slot from
// event.target, and any dragenter/dragover over a non-slot area drops the
// highlight. dragleave is deliberately NOT listened to anywhere: it bubbles,
// so a document-level dragleave fires on every child-boundary crossing, and
// its relatedTarget is unreliable over GPU-composited canvases  that pair is
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
// always fires and its default action  navigating to the dropped file  is
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
    const mode = button.dataset.previewMode as PreviewMode;
    setMode(mode);
    applyPreviewMode();
    // A pane can change while hidden in 3D. Re-entering 2D must refresh its
    // bitmap and luminosity histogram immediately instead of exposing stale UI.
    if (mode === '2d') renderScheduler.flush();
  });
}
bindPreviewToggle(originalPreviewToggle, (mode) => { originalPreviewMode = mode; });
bindPreviewToggle(processedPreviewToggle, (mode) => { processedPreviewMode = mode; });
uvMapSelect.addEventListener('change', () => applyModelUV(uvMapSelect.value));
lodMapSelect.addEventListener('change', () => applyModelLod(Number(lodMapSelect.value)));
worldAxisYUpInput.addEventListener('change', () => {
  state.worldAxis = worldAxisYUpInput.checked ? 'maya' : 'blender';
  applyWorldAxis();
});
// The 2D-view toggles are per-pane: each pane's control writes only its own
// state, so toggling the Original pane never touches the Dithered pane's
// overlay (and vice versa).
uvOverlapInput.addEventListener('change', () => {
  state.showUVOverlapOriginal = uvOverlapInput.checked;
  renderUVOverlapControl();
  refreshUVOverlap();
  render();
});
processedUVOverlapInput.addEventListener('change', () => {
  state.showUVOverlapProcessed = processedUVOverlapInput.checked;
  renderUVOverlapControl();
  refreshUVOverlap();
  render();
});
repeatTextureInput.addEventListener('change', () => {
  repeatTextureOriginal = repeatTextureInput.checked;
  renderRepeatControl();
  render();
});
processedRepeatTextureInput.addEventListener('change', () => {
  repeatTextureProcessed = processedRepeatTextureInput.checked;
  renderRepeatControl();
  render();
});
uvWireframeInput.addEventListener('change', () => {
  state.showUVWireframeOriginal = uvWireframeInput.checked;
  renderUVWireframeControl();
  render();
  syncWireframeOverlays();
});
processedUVWireframeInput.addEventListener('change', () => {
  state.showUVWireframeProcessed = processedUVWireframeInput.checked;
  renderUVWireframeControl();
  render();
  syncWireframeOverlays();
});
function bindSunControl(): void {
  sunControlElements.orientWithCamera.addEventListener('click', () => {
    const viewport = orientCameraViewport();
    if (!viewport || orientCameraPreviewMode() !== '3d' || orientSunBusy) return;
    state.sun.direction = viewport.getCameraForward();
    // Orient Sun with Camera is the only action that changes the sun angle.
    // Sun/ambient sliders and normal-map slot edits re-bake with the existing
    // direction via scheduleImplicitLightmapBake.
    applySun();
    runLightmapBake();
  });
  const bindLightColor = (input: HTMLInputElement, target: LightState): void => {
    input.addEventListener('input', () => {
      target.color = input.value;
      applySun();
    });
    // The bake runs only when the picker commits: 'input' fires continuously
    // while the user drags, and a bake per move freezes the UI on heavy grids
    // (scene collection and normal prep run on the main thread). 'change'
    // fires on release with the final value.
    // Re-engaging on commit means a deliberate color change un-sticks the
    // sliders even after the lightmap slot's X silenced the scheduler.
    input.addEventListener('change', () => {
      renderer.reengageLighting();
      scheduleImplicitLightmapBake();
    });
  };
  const bindLightIntensity = (input: HTMLInputElement, output: HTMLOutputElement, target: LightState): void => {
    // Shared commit for both the slider drag and the click-to-edit value field.
    const applyIntensity = (value: number): void => {
      target.intensity = value;
      applySun();
    };
    // The bake is release-triggered, not per-drag-move (see bindLightColor).
    // Re-engage on release so the sliders always re-light after an X.
    const commitBake = (): void => {
      renderer.reengageLighting();
      scheduleImplicitLightmapBake();
    };
    input.addEventListener('input', () => {
      // Clamp to the slider's min/max and drop NaN before it reaches state:
      // an out-of-range or invalid value written into a range input can lock
      // its thumb, so never let one through.
      const min = input.min !== '' ? Number(input.min) : -Infinity;
      const max = input.max !== '' ? Number(input.max) : Infinity;
      const value = clamp(Number(input.value), min, max);
      if (!Number.isFinite(value)) return;
      applyIntensity(value);
    });
    input.addEventListener('change', commitBake);
    bindRangeReset(input);
    // Direct numeric entry, same click-to-edit as every other slider.
    bindRangeValueEdit(input, output, (value) => {
      applyIntensity(value);
      commitBake();
    }, formatFixed2);
  };

  bindLightColor(sunControlElements.color, state.sun);
  bindLightIntensity(sunControlElements.intensity, sunControlElements.intensityValue, state.sun);
  bindLightColor(sunControlElements.ambientColor, state.ambient);
  bindLightIntensity(sunControlElements.ambientIntensity, sunControlElements.ambientIntensityValue, state.ambient);
  // Normal-map strength updates the Normals-view showcase immediately. It is
  // consumed by lighting only on the next Orient Sun with Camera bake.
  bindRange({
    input: sunControlElements.normalStrength,
    output: sunControlElements.normalStrengthValue,
    format: formatFixed2,
    apply: (value) => {
      state.normalStrength = Math.round(value * 100) / 100;
      originalViewport?.setNormalStrength(state.normalStrength);
      processedViewport?.setNormalStrength(state.normalStrength);
    },
  });
  // UV-stretch heatmap sensitivity  a display-only gain, consumed on the next
  // render when the stretch view recomputes its per-face colors.
  bindRange({
    input: sunControlElements.uvStretchSensitivity,
    output: sunControlElements.uvStretchSensitivityValue,
    format: formatFixed2,
    apply: (value) => {
      state.uvStretchSensitivity = Math.round(value * 100) / 100;
    },
  });
}

bindSunControl();

// Preview view enum (Combined / BaseColor / Normals / AO / Lightmap)  a single segmented
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
  applyViewDirectionality();
  // The per-face color overlay serves both UV Stretch and Texel Variance; keep
  // it installed while either is active, and clear it otherwise.
  const overlayActiveOriginal = state.viewModeOriginal === 'uv-stretch' || state.viewModeOriginal === 'texel-variance';
  const overlayActiveProcessed = state.viewModeProcessed === 'uv-stretch' || state.viewModeProcessed === 'texel-variance';
  if (!overlayActiveOriginal) originalViewport?.setUVStretch(null);
  if (!overlayActiveProcessed) processedViewport?.setUVStretch(null);
  // Show/hide the UV-stretch sensitivity slider within the lighting controls.
  renderSunControl();
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
// Combined / BaseColor / Normal / AO / Lightmap / LightmapAO  same vocabulary
// as the view toggle, minus its punctuation.
const EXPORT_VIEW_SUFFIX: Record<PreviewViewMode, string> = {
  flat: 'Combined',
  basecolor: 'BaseColor',
  normals: 'Normal',
  ao: 'AO',
  lightmap: 'Lightmap',
  'lightmap-ao': 'LightmapAO',
  'uv-stretch': 'UVStretch',
  directionality: 'Directionality',
  'texel-variance': 'TexelVariance',
};
document.querySelector('#exportButton')!.addEventListener('click', async () => {
  // Flush the debounced render first so the export always matches what the
  // processed pane currently shows for the selected view mode. The render may
  // dither on the GPU, so await it before reading the canvas back.
  await renderScheduler.flush();
  // <model base name without suffix>_<view mode>.png  the model's name when a
  // model is loaded, otherwise the base texture's name (both sans extension).
  const stem = modelBundle
    ? modelBundle.primary.name.replace(/\.[^.]+$/, '')
    : textures.base.name.replace(/\.[^.]+$/, '');
  const rendered = renderer.getRenderedCanvas();
  downloadCanvas(rendered, `${safeFileName(stem)}_${EXPORT_VIEW_SUFFIX[state.viewModeProcessed]}.png`);
});

// External links (GitHub repo, Ko-fi support) use target="_blank", which the
// Tauri webview ignores  route them through the opener plugin so they open
// in the system browser; the web build falls back to a new tab.
document.addEventListener('click', (event) => {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[target="_blank"][href^="http"]');
  if (!anchor) return;
  event.preventDefault();
  void openExternalLink(anchor.href).catch((error) => console.error('Could not open link.', error));
});

// ── Changelogs panel ─────────────────────────────────────────────────────
// Fetches the GitHub release history (the pipeline versions releases by git
// tag, e.g. v2.6.2) and renders one collapsible changelog per version, newest
// first. Each version's body lists the commit subjects that shipped in it.
// Commits newer than the newest release tag (unreleased work) form a top group.
const changelogFetchButton = document.querySelector<HTMLButtonElement>('#changelogFetchButton')!;
const changelogList = document.querySelector<HTMLDivElement>('#changelogList')!;
const CHANGELOG_REPO = 'Ultikynnys/UltiPixelizer';

interface ChangelogCommit {
  message: string;
  url: string;
}

interface ChangelogVersion {
  version: string;
  commits: ChangelogCommit[];
}

/** The first line of a commit message is the changelog subject. */
function changelogSubject(message: string): string {
  return message.split('\n')[0].trim();
}

async function fetchChangelogs(): Promise<void> {
  changelogFetchButton.disabled = true;
  changelogList.textContent = 'Loading release history…';
  try {
    const [tagsResponse, commitsResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${CHANGELOG_REPO}/tags?per_page=100`),
      fetch(`https://api.github.com/repos/${CHANGELOG_REPO}/commits?per_page=100`),
    ]);
    if (!tagsResponse.ok || !commitsResponse.ok) {
      throw new Error(`GitHub API ${Math.max(tagsResponse.status, commitsResponse.status)}`);
    }
    const tags = await tagsResponse.json() as Array<{ name: string; commit: { sha: string } }>;
    const commits = await commitsResponse.json() as Array<{ sha: string; html_url: string; commit: { message: string } }>;

    // Each version is a git tag pointing at a commit. Walking the commit log
    // newest→oldest, a tagged commit begins (and older commits join) that
    // version; commits newer than the newest tag land in an Unreleased group.
    const versionBySha = new Map<string, string>();
    for (const tag of tags) versionBySha.set(tag.commit.sha, tag.name);

    const unreleased: ChangelogVersion = { version: 'Unreleased', commits: [] };
    const released: ChangelogVersion[] = [];
    let current: ChangelogVersion = unreleased;
    for (const item of commits) {
      const version = versionBySha.get(item.sha);
      if (version) {
        current = { version, commits: [] };
        released.push(current);
      }
      current.commits.push({ message: item.commit.message, url: item.html_url });
    }
    const versions = unreleased.commits.length ? [unreleased, ...released] : released;

    renderChangelogs(versions);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    changelogList.textContent = `Could not fetch changelogs (${reason}). Check your connection and try again.`;
  } finally {
    changelogFetchButton.disabled = false;
  }
}

function renderChangelogs(versions: ChangelogVersion[]): void {
  changelogList.innerHTML = versions.map((group) => `
    <div class="changelog-version">
      <button class="changelog-toggle" type="button" aria-expanded="false">
        <span class="changelog-chevron"></span>
        <span class="changelog-version-name">${escapeHtml(group.version)}</span>
        <span class="changelog-count">${group.commits.length} commit${group.commits.length === 1 ? '' : 's'}</span>
      </button>
      <div class="changelog-body" hidden>
        <ul class="changelog-commits">
          ${group.commits.map((commit) => `
            <li class="changelog-commit">
              <a href="${escapeHtml(commit.url)}" target="_blank" rel="noopener">${escapeHtml(changelogSubject(commit.message))}</a>
            </li>`).join('')}
        </ul>
      </div>
    </div>`).join('');
}

changelogFetchButton.addEventListener('click', () => void fetchChangelogs());

// Chevron rows toggle their commit list. Delegated so re-renders stay wired.
changelogList.addEventListener('click', (event) => {
  const toggle = (event.target as HTMLElement).closest<HTMLButtonElement>('.changelog-toggle');
  if (!toggle) return;
  const group = toggle.parentElement!;
  const body = group.querySelector<HTMLDivElement>('.changelog-body');
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!expanded));
  group.classList.toggle('open', !expanded);
  if (body) body.hidden = expanded;
});
