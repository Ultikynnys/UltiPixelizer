import { describe, expect, it } from 'vitest';
import { palettes } from '../src/lib/palettes';
import {
  applyConfigValues,
  collectConfigValues,
  createPreset,
  defaultConfigValues,
  isConversionPreset,
  parsePreset,
  serializePreset,
  type ConversionConfig,
} from '../src/lib/presets';
import type { State } from '../src/lib/state';
import { DEFAULT_CAMERA_DIRECTION, DEFAULT_SUN_DIRECTION } from '../src/lib/sunDirection';

const config: ConversionConfig = {
  resolution: 128,
  mode: 'checker',
  strength: 0.75,
  brightness: 12,
  contrast: -8,
  saturation: 25,
  pixelation: 1,
  upscale: 'nearest',
  quadTessellation: 64,
  quadGrid: true,
  displacementStrength: 0.18,
  displacementFlip: true,
  showUVWireframeOriginal: false,
  showUVWireframeProcessed: true,
  navigationPan: false,
  showFloorGrid: true,
  paletteFilter: 'search',
  paletteSearchQuery: 'pico',
  paletteSearchSort: 'fewest',
  originalCamera: { position: { x: 2, y: 3, z: 4 }, target: { x: 0, y: 0.5, z: 0 } },
  processedCamera: { position: { x: -2, y: 1.5, z: -3 }, target: { x: 0, y: 0, z: 0 } },
  paletteKey: 'pico8',
  palette: palettes.pico8,
  stripeAngle: 45,
  patternSpace: 'uv',
  uvScale: 1,
  worldspaceScale: 64,
  seed: 1,
  aoBias: 0,
  aoPower: 1,
  aoDistance: 2,
  sunColor: '#ffd8a8',
  sunIntensity: 0.9,
  ambientColor: '#8fb4ff',
  ambientIntensity: 0.6,
  normalStrength: 0.6,
  normalFormat: 'opengl',
  uvStretchSensitivity: 1.5,
  sunDirection: { x: -0.5, y: -0.7071067811865476, z: -0.5 },
};

describe('conversion presets', () => {
  it('captures and round-trips every setting and complete palette metadata', () => {
    const preset = createPreset('My Texture', 'Full conversion setup', config, new Date('2026-01-02T03:04:05Z'));
    const parsed = parsePreset(serializePreset(preset));
    expect(parsed).toEqual(preset);
    expect(parsed.palette.colors).toEqual(palettes.pico8.colors);
    expect(parsed.palette.name).toBe('PICO-8');
    expect('uvMap' in parsed).toBe(false); // UV selection is model-specific, never saved
    expect(parsed.originalCamera).toEqual({ position: { x: 2, y: 3, z: 4 }, target: { x: 0, y: 0.5, z: 0 } });
    expect(parsed.processedCamera).toEqual({ position: { x: -2, y: 1.5, z: -3 }, target: { x: 0, y: 0, z: 0 } });
    expect(parsed.id).toBe('1767323045000-my-texture');
  });

  it('strips the removed uvMap field from legacy preset files', () => {
    const legacy = JSON.parse(serializePreset(createPreset('Legacy', '', config))) as Record<string, unknown>;
    legacy.uvMap = 'uv2'; // v7 and earlier stored the model-specific UV selection
    const parsed = parsePreset(JSON.stringify(legacy));
    expect(parsed.name).toBe('Legacy');
    expect('uvMap' in parsed).toBe(false);
  });

  it('migrates presets saved before seed selection existed', () => {
    const oldPreset = createPreset('Legacy', '', config);
    const { seed: _removed, ...legacy } = oldPreset;
    expect(parsePreset(JSON.stringify(legacy)).seed).toBe(1);
  });

  it('clamps displacement strength saved above the 0.2 cap', () => {
    const legacy = createPreset('Legacy displacement', '', config);
    const parsed = parsePreset(JSON.stringify({ ...legacy, displacementStrength: 0.5 }));
    expect(parsed.displacementStrength).toBe(0.2);
  });

  it('clamps pixelation saved above the 80% cap', () => {
    const legacy = createPreset('Legacy pixelation', '', config);
    const parsed = parsePreset(JSON.stringify({ ...legacy, pixelation: 95 }));
    expect(parsed.pixelation).toBe(80);
  });

  it('clamps worldspace scale below 1 and preserves valid legacy values', () => {
    const legacy = createPreset('Legacy worldspace', '', config);
    expect(parsePreset(JSON.stringify({ ...legacy, worldspaceScale: 0.5 })).worldspaceScale).toBe(1);
    expect(parsePreset(JSON.stringify({ ...legacy, worldspaceScale: 4 })).worldspaceScale).toBe(4);
  });

  it('folds the legacy worldspace mode into the world pattern-space toggle', () => {
    const legacy = createPreset('Legacy worldspace mode', '', config);
    const parsed = parsePreset(JSON.stringify({ ...legacy, mode: 'worldspace' }));
    expect(parsed.mode).toBe('ordered');
    expect(parsed.patternSpace).toBe('world');
  });

  it('backfills the palette-library filter/query/sort into presets saved before they existed', () => {
    const current = createPreset('Legacy palette UI', '', config);
    const { paletteFilter: _filter, paletteSearchQuery: _query, paletteSearchSort: _sort, ...legacy } = current;
    const parsed = parsePreset(JSON.stringify(legacy));
    expect(parsed.paletteFilter).toBe('compact');
    expect(parsed.paletteSearchQuery).toBe('');
    expect(parsed.paletteSearchSort).toBe('name');
  });

  it('backfills disabled UV Islands overlays into settings saved before they persisted', () => {
    const current = createPreset('Legacy UV Islands', '', config);
    const { showUVWireframeOriginal: _original, showUVWireframeProcessed: _processed, ...legacy } = current;
    const parsed = parsePreset(JSON.stringify(legacy));
    expect(parsed.showUVWireframeOriginal).toBe(false);
    expect(parsed.showUVWireframeProcessed).toBe(false);
  });

  it('migrates presets saved before AO bias/power existed', () => {
    const oldPreset = createPreset('Legacy', '', config);
    const { aoBias: _bias, aoPower: _power, ...legacy } = oldPreset;
    const parsed = parsePreset(JSON.stringify({ ...legacy, version: 1, aoIntensity: 0.6 }));
    expect(parsed.aoPower).toBe(0.6);
    expect(parsed.aoBias).toBe(0);
    expect('aoIntensity' in parsed).toBe(false);
    expect('aoScale' in parsed).toBe(false);
  });

  it('migrates presets saved before configurable lighting existed', () => {
    const current = createPreset('Legacy lighting', '', config);
    const { sunColor: _sunColor, sunIntensity: _sunIntensity, ambientColor: _ambientColor, ambientIntensity: _ambientIntensity, ...legacy } = current;
    const parsed = parsePreset(JSON.stringify({ ...legacy, version: 2 }));
    expect(parsed.sunColor).toBe('#ffffff');
    expect(parsed.sunIntensity).toBe(1);
    expect(parsed.ambientColor).toBe('#ffffff');
    expect(parsed.ambientIntensity).toBe(0.2);
  });

  it('rejects empty names, malformed JSON, invalid exports, and unsupported settings', () => {
    expect(() => createPreset('  ', '', config)).toThrow('Preset name is required');
    expect(() => parsePreset('{broken')).toThrow('not valid JSON');
    expect(() => parsePreset(JSON.stringify({ version: 99 }))).toThrow('invalid or unsupported');
    expect(() => serializePreset({} as never)).toThrow('invalid preset');
    expect(isConversionPreset(null)).toBe(false);
  });

  it('accepts stripe angles up to 135 degrees', () => {
    const base = createPreset('Boundary', '', config);
    expect(isConversionPreset({ ...base, stripeAngle: 0 })).toBe(true);
    expect(isConversionPreset({ ...base, stripeAngle: 135 })).toBe(true);
    expect(isConversionPreset({ ...base, stripeAngle: 136 })).toBe(false);
  });

  it('accepts pixelation percentages from 0 to 80', () => {
    const base = createPreset('Boundary', '', config);
    expect(isConversionPreset({ ...base, pixelation: 0 })).toBe(true);
    expect(isConversionPreset({ ...base, pixelation: 80 })).toBe(true);
    expect(isConversionPreset({ ...base, pixelation: 81 })).toBe(false);
    expect(isConversionPreset({ ...base, pixelation: -1 })).toBe(false);
  });

  it('clamps legacy UV scales and validates the new range', () => {
    const current = createPreset('UV scale', '', { ...config, uvScale: 1 });
    expect(parsePreset(JSON.stringify({ ...current, uvScale: 0.04 })).uvScale).toBe(0.05);
    expect(parsePreset(JSON.stringify({ ...current, uvScale: 0.25 })).uvScale).toBe(0.25);
    expect(isConversionPreset({ ...current, uvScale: 0.05 })).toBe(true);
    expect(isConversionPreset({ ...current, uvScale: 0.1 })).toBe(true);
    expect(isConversionPreset({ ...current, uvScale: 8 })).toBe(true);
    expect(isConversionPreset({ ...current, uvScale: 0.04 })).toBe(false);
    expect(isConversionPreset({ ...current, uvScale: 8.01 })).toBe(false);
  });

  it('backfills and validates worldspace scale', () => {
    const current = createPreset('Worldspace', '', { ...config, mode: 'ordered', patternSpace: 'world', worldspaceScale: 128 });
    const { worldspaceScale: _removed, ...legacy } = current;
    expect(parsePreset(JSON.stringify(legacy)).worldspaceScale).toBe(64);
    expect(isConversionPreset({ ...current, worldspaceScale: 1 })).toBe(true);
    expect(isConversionPreset({ ...current, worldspaceScale: 2048 })).toBe(true);
    expect(isConversionPreset({ ...current, worldspaceScale: 0.99 })).toBe(false);
    expect(isConversionPreset({ ...current, worldspaceScale: 2049 })).toBe(false);
  });

  it('validates lighting colors and intensity bounds', () => {
    const base = createPreset('Lighting', '', config);
    expect(isConversionPreset({ ...base, ambientIntensity: 0 })).toBe(true);
    expect(isConversionPreset({ ...base, sunColor: 'white' })).toBe(false);
    expect(isConversionPreset({ ...base, sunIntensity: 2 })).toBe(true);
    expect(isConversionPreset({ ...base, sunIntensity: 10.1 })).toBe(false);
    expect(isConversionPreset({ ...base, ambientIntensity: -0.1 })).toBe(false);
  });

  it('tolerates the removed lightmap contribution key in legacy presets', () => {
    const current = createPreset('Legacy contribution', '', config);
    // Old preset files may still carry the removed lightmap-contribution
    // setting; validation only checks known fields, so they keep loading (the
    // key is simply ignored from here on).
    expect(isConversionPreset({ ...current, lightmapContribution: 0.5 })).toBe(true);
    expect(parsePreset(JSON.stringify({ ...current, lightmapContribution: 0.5 })).resolution).toBe(128);
  });

  it('migrates presets saved before normal mapping existed', () => {
    const current = createPreset('Legacy normals', '', config);
    const { normalStrength: _strength, normalFormat: _format, ...legacy } = current;
    const parsed = parsePreset(JSON.stringify(legacy));
    expect(parsed.normalStrength).toBe(1);
    expect(parsed.normalFormat).toBe('opengl');
  });

  it('backfills the UV stretch sensitivity default into settings saved before it existed', () => {
    const current = createPreset('Legacy stretch sensitivity', '', config);
    const { uvStretchSensitivity: _sensitivity, ...legacy } = current;
    expect(parsePreset(JSON.stringify(legacy)).uvStretchSensitivity).toBe(1);
  });

  it('round-trips and validates the UV stretch sensitivity setting', () => {
    const current = createPreset('Stretch sensitivity', '', config);
    // Save carries the value; load restores it exactly.
    const parsed = parsePreset(serializePreset(current));
    expect(parsed.uvStretchSensitivity).toBe(config.uvStretchSensitivity);
    // Bounds: allowed 0..4, rejected outside that range.
    expect(isConversionPreset({ ...current, uvStretchSensitivity: 0 })).toBe(true);
    expect(isConversionPreset({ ...current, uvStretchSensitivity: 4 })).toBe(true);
    expect(isConversionPreset({ ...current, uvStretchSensitivity: 4.01 })).toBe(false);
    expect(isConversionPreset({ ...current, uvStretchSensitivity: -0.1 })).toBe(false);
  });

  it('tolerates the removed bake resolution key in legacy presets', () => {
    const current = createPreset('Legacy bake res', '', config);
    // Old preset files may still carry the removed bake-resolution setting;
    // validation only checks known fields, so they keep loading (the key is
    // simply ignored from here on).
    expect(isConversionPreset({ ...current, bakeResolution: 64 })).toBe(true);
    expect(parsePreset(JSON.stringify({ ...current, bakeResolution: 64 })).resolution).toBe(128);
  });

  it('renames legacy diagonal and vertical dither modes to stripes', () => {
    const current = createPreset('Legacy modes', '', config);
    const { mode: _removed, ...legacy } = current;
    expect(parsePreset(JSON.stringify({ ...legacy, mode: 'diagonal' })).mode).toBe('stripes');
    expect(parsePreset(JSON.stringify({ ...legacy, mode: 'vertical' })).mode).toBe('stripes');
    expect(parsePreset(JSON.stringify({ ...legacy, mode: 'vertical' })).stripeAngle).toBe(0);
  });

  it('validates normal strength and format bounds', () => {
    const base = createPreset('Normals', '', config);
    expect(isConversionPreset({ ...base, normalStrength: 0 })).toBe(true);
    expect(isConversionPreset({ ...base, normalStrength: 1 })).toBe(true);
    expect(isConversionPreset({ ...base, normalStrength: 1.01 })).toBe(false);
    expect(isConversionPreset({ ...base, normalFormat: 'directx' })).toBe(true);
    expect(isConversionPreset({ ...base, normalFormat: 'vulkan' })).toBe(false);
  });

  it('validates saved camera views (angle + position)', () => {
    const base = createPreset('Cameras', '', config);
    expect(isConversionPreset({
      ...base,
      originalCamera: { position: { x: 1, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } },
      processedCamera: { position: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 0, z: 0 } },
    })).toBe(true);
    // Missing axis, missing target, and zero-length vectors are all rejected.
    expect(isConversionPreset({ ...base, originalCamera: { position: { x: 1 }, target: { x: 0, y: 0, z: 0 } } })).toBe(false);
    expect(isConversionPreset({ ...base, originalCamera: { position: { x: 1, y: 0, z: 0 } } })).toBe(false);
    expect(isConversionPreset({ ...base, processedCamera: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } } })).toBe(false);
  });

  it('migrates presets saved before sun direction existed', () => {
    const current = createPreset('Legacy', '', config);
    const { sunDirection: _sunDirection, ...legacy } = current;
    const parsed = parsePreset(JSON.stringify(legacy));
    expect(parsed.sunDirection).toEqual(DEFAULT_SUN_DIRECTION);
  });

  it('strips the removed cameraDirection field from legacy preset files', () => {
    const legacy = JSON.parse(serializePreset(createPreset('Legacy', '', config))) as Record<string, unknown>;
    legacy.cameraDirection = DEFAULT_CAMERA_DIRECTION; // v7 and earlier stored the view angle
    const parsed = parsePreset(JSON.stringify(legacy));
    expect(parsed.name).toBe('Legacy');
    expect('cameraDirection' in parsed).toBe(false);
  });

  it('accepts settings files saved before camera capture existed (no camera fields)', () => {
    const current = createPreset('Legacy', '', config);
    const { originalCamera: _original, processedCamera: _processed, ...legacy } = current;
    const parsed = parsePreset(JSON.stringify(legacy));
    expect(parsed.originalCamera).toBeUndefined();
    expect(parsed.processedCamera).toBeUndefined();
  });

  it('folds a disabled sun or ambient into zero intensity when migrating v5 presets', () => {
    const current = createPreset('Legacy toggles', '', config);
    const disabled = {
      ...current,
      version: 5,
      sunEnabled: false,
      ambientEnabled: false,
      sunIntensity: 0.8,
      ambientIntensity: 0.5,
    };
    const parsed = parsePreset(JSON.stringify(disabled));
    expect(parsed.sunIntensity).toBe(0);
    expect(parsed.ambientIntensity).toBe(0);
    expect('sunEnabled' in parsed).toBe(false);
    expect('ambientEnabled' in parsed).toBe(false);
  });

});

describe('shared settings schema (CONFIG_FIELDS)', () => {
  /** A State carrying only the serializable settings; the rest is irrelevant here. */
  function stateFixture(): State {
    return {
      resolution: 128,
      mode: 'checker',
      strength: 0.75,
      brightness: 12,
      contrast: -8,
      saturation: 25,
      pixelation: 1,
      upscale: 'nearest',
      quadTessellation: 16,
      quadGrid: false,
      displacementStrength: 0.15,
      displacementFlip: false,
      showUVWireframeOriginal: false,
      showUVWireframeProcessed: true,
      navigationPan: false,
      paletteFilter: 'search',
      paletteSearchQuery: 'pico',
      paletteSearchSort: 'fewest',
      stripeAngle: 45,
      seed: 1,
      aoBias: 0,
      aoPower: 1,
      aoDistance: 2,
      sun: { color: '#ffd8a8', intensity: 0.9, direction: { x: -0.5, y: -0.7071067811865476, z: -0.5 } },
      ambient: { color: '#8fb4ff', intensity: 0.6 },
      normalStrength: 0.6,
      normalFormat: 'opengl',
      uvStretchSensitivity: 1.5,
      cameraDirection: { x: 0, y: 0, z: -1 },
      showFloorGrid: true,
    } as State;
  }

  it('derives initial defaults for every serializable setting', () => {
    const defaults = defaultConfigValues();
    expect(Object.keys(defaults)).toHaveLength(35);
    expect(defaults).toEqual({
      resolution: 128,
      mode: 'floyd',
      strength: 0.85,
      brightness: 0,
      contrast: 8,
      saturation: 5,
      pixelation: 0,
      upscale: 'nearest',
      stripeAngle: 45,
      patternSpace: 'uv',
      uvScale: 1,
      worldspaceScale: 64,
      seed: 1,
      aoBias: 0,
      aoPower: 1,
      aoDistance: 2,
      sunColor: '#ffffff',
      sunIntensity: 1,
      ambientColor: '#ffffff',
      ambientIntensity: 0.2,
      normalStrength: 1,
      normalFormat: 'opengl',
      uvStretchSensitivity: 1,
      sunDirection: DEFAULT_SUN_DIRECTION,
      quadTessellation: 16,
      quadGrid: false,
      displacementStrength: 0.15,
      displacementFlip: false,
      showUVWireframeOriginal: false,
      showUVWireframeProcessed: false,
      navigationPan: false,
      showFloorGrid: false,
      paletteFilter: 'compact',
      paletteSearchQuery: '',
      paletteSearchSort: 'name',
    });
    // Catalog/structural fields are deliberately not part of the table.
    expect('paletteKey' in defaults).toBe(false);
    expect('uvMap' in defaults).toBe(false);
    expect('palette' in defaults).toBe(false);
    expect('originalCamera' in defaults).toBe(false);
    expect('processedCamera' in defaults).toBe(false);
  });

  it('collects flat and nested settings out of a State object', () => {
    expect(collectConfigValues(stateFixture())).toEqual({
      resolution: 128,
      mode: 'checker',
      strength: 0.75,
      brightness: 12,
      contrast: -8,
      saturation: 25,
      pixelation: 1,
      upscale: 'nearest',
      stripeAngle: 45,
      seed: 1,
      aoBias: 0,
      aoPower: 1,
      aoDistance: 2,
      sunColor: '#ffd8a8',
      sunIntensity: 0.9,
      ambientColor: '#8fb4ff',
      ambientIntensity: 0.6,
      normalStrength: 0.6,
      normalFormat: 'opengl',
      uvStretchSensitivity: 1.5,
      sunDirection: { x: -0.5, y: -0.7071067811865476, z: -0.5 },
      quadTessellation: 16,
      quadGrid: false,
      displacementStrength: 0.15,
      displacementFlip: false,
      showUVWireframeOriginal: false,
      showUVWireframeProcessed: true,
      navigationPan: false,
      showFloorGrid: true,
      paletteFilter: 'search',
      paletteSearchQuery: 'pico',
      paletteSearchSort: 'fewest',
    });
  });

  it('applies flat config values into a State, creating nested light objects as needed', () => {
    const state = {} as State;
    applyConfigValues(state, {
      resolution: 64,
      sunColor: '#ff0000',
      sunIntensity: 0.5,
      ambientIntensity: 0.3,
      normalFormat: 'directx',
    });
    expect(state.resolution).toBe(64);
    expect(state.sun.color).toBe('#ff0000');
    expect(state.sun.intensity).toBe(0.5);
    expect(state.ambient.intensity).toBe(0.3);
    expect(state.normalFormat).toBe('directx');
    // Fields not present in the table are left untouched.
    expect((state as unknown as Record<string, unknown>).paletteKey).toBeUndefined();
  });

  it('skips undefined values and leaves existing nested objects intact', () => {
    const state = stateFixture();
    const sunBefore = state.sun;
    applyConfigValues(state, { resolution: undefined, sunColor: undefined, ambientIntensity: 0.2 });
    expect(state.resolution).toBe(128);
    expect(state.sun).toBe(sunBefore);
    expect(state.sun.color).toBe('#ffd8a8');
    expect(state.ambient.intensity).toBe(0.2);
  });

  it('round-trips state -> config -> state without loss', () => {
    const applied = {} as State;
    applyConfigValues(applied, collectConfigValues(stateFixture()));
    expect(collectConfigValues(applied)).toEqual(collectConfigValues(stateFixture()));
  });
});
