import { beforeEach, describe, expect, it } from 'vitest';
import { palettes } from '../src/lib/palettes';
import {
  PRESET_STORAGE_KEY,
  applyConfigValues,
  collectConfigValues,
  createPreset,
  defaultConfigValues,
  deletePreset,
  isConversionPreset,
  loadPresetLibrary,
  parsePreset,
  savePresetLibrary,
  serializePreset,
  upsertPreset,
  type ConversionConfig,
  type StorageLike,
} from '../src/lib/presets';
import type { State } from '../src/lib/state';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}

const config: ConversionConfig = {
  resolution: 128,
  mode: 'checker',
  strength: 0.75,
  brightness: 12,
  contrast: -8,
  saturation: 25,
  paletteKey: 'pico8',
  palette: palettes.pico8,
  uvMap: 'uv2',
  stripeAngle: 45,
  noiseScale: 1,
  seed: 1,
  aoBias: 0,
  aoScale: 1,
  aoDistance: 2,
  sunColor: '#ffd8a8',
  sunIntensity: 0.9,
  ambientColor: '#8fb4ff',
  ambientIntensity: 0.6,
  lightmapContribution: 0.75,
  normalStrength: 0.6,
  normalFormat: 'opengl',
};

let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

describe('conversion presets', () => {
  it('captures and round-trips every setting and complete palette metadata', () => {
    const preset = createPreset('My Texture', 'Full conversion setup', config, new Date('2026-01-02T03:04:05Z'));
    const parsed = parsePreset(serializePreset(preset));
    expect(parsed).toEqual(preset);
    expect(parsed.palette.colors).toEqual(palettes.pico8.colors);
    expect(parsed.palette.name).toBe('PICO-8');
    expect(parsed.palette.description).toBe('Punchy fantasy console');
    expect(parsed.uvMap).toBe('uv2');
    expect(parsed.id).toBe('1767323045000-my-texture');
  });

  it('migrates presets saved before UV-map selection existed', () => {
    const oldPreset = createPreset('Legacy', '', config);
    const { uvMap: _removed, ...legacy } = oldPreset;
    expect(parsePreset(JSON.stringify(legacy)).uvMap).toBe('uv');
  });

  it('migrates presets saved before seed selection existed', () => {
    const oldPreset = createPreset('Legacy', '', config);
    const { seed: _removed, ...legacy } = oldPreset;
    expect(parsePreset(JSON.stringify(legacy)).seed).toBe(1);
  });

  it('migrates presets saved before AO bias/scale existed', () => {
    const oldPreset = createPreset('Legacy', '', config);
    const { aoBias: _bias, aoScale: _scale, ...legacy } = oldPreset;
    const parsed = parsePreset(JSON.stringify({ ...legacy, version: 1, aoIntensity: 0.6 }));
    expect(parsed.aoScale).toBe(0.6);
    expect(parsed.aoBias).toBe(0);
    expect('aoIntensity' in parsed).toBe(false);
  });

  it('migrates presets saved before configurable lighting existed', () => {
    const current = createPreset('Legacy lighting', '', config);
    const { sunColor: _sunColor, sunIntensity: _sunIntensity, ambientColor: _ambientColor, ambientIntensity: _ambientIntensity, ...legacy } = current;
    const parsed = parsePreset(JSON.stringify({ ...legacy, version: 2 }));
    expect(parsed.sunColor).toBe('#ffffff');
    expect(parsed.sunIntensity).toBe(1);
    expect(parsed.ambientColor).toBe('#ffffff');
    expect(parsed.ambientIntensity).toBe(0.7);
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

  it('validates lighting colors and intensity bounds', () => {
    const base = createPreset('Lighting', '', config);
    expect(isConversionPreset({ ...base, ambientIntensity: 0 })).toBe(true);
    expect(isConversionPreset({ ...base, sunColor: 'white' })).toBe(false);
    expect(isConversionPreset({ ...base, sunIntensity: 10.1 })).toBe(false);
    expect(isConversionPreset({ ...base, ambientIntensity: -0.1 })).toBe(false);
  });

  it('migrates and validates lightmap contribution', () => {
    const current = createPreset('Legacy lightmap', '', config);
    const { lightmapContribution: _removed, ...legacy } = current;
    expect(parsePreset(JSON.stringify({ ...legacy, version: 3 })).lightmapContribution).toBe(1);
    expect(isConversionPreset({ ...current, lightmapContribution: 0 })).toBe(true);
    expect(isConversionPreset({ ...current, lightmapContribution: 1 })).toBe(true);
    expect(isConversionPreset({ ...current, lightmapContribution: 1.01 })).toBe(false);
  });

  it('migrates presets saved before normal mapping existed', () => {
    const current = createPreset('Legacy normals', '', config);
    const { normalStrength: _strength, normalFormat: _format, ...legacy } = current;
    const parsed = parsePreset(JSON.stringify(legacy));
    expect(parsed.normalStrength).toBe(1);
    expect(parsed.normalFormat).toBe('opengl');
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

  it('persists, replaces by case-insensitive name, and deletes named presets', () => {
    const first = createPreset('Portrait', '', config, new Date('2026-01-01'));
    const replacement = createPreset('portrait', 'updated', { ...config, resolution: 64 }, new Date('2026-01-02'));
    expect(upsertPreset(storage, first)).toHaveLength(1);
    const updated = upsertPreset(storage, replacement);
    expect(updated).toHaveLength(1);
    expect(updated[0].resolution).toBe(64);
    expect(deletePreset(storage, replacement.id)).toEqual([]);
    expect(storage.data.has(PRESET_STORAGE_KEY)).toBe(true);
  });

  it('returns nothing for absent storage and throws for corrupt or non-array data', () => {
    expect(loadPresetLibrary(storage)).toEqual([]);
    storage.data.set(PRESET_STORAGE_KEY, '{bad');
    expect(() => loadPresetLibrary(storage)).toThrow('corrupt JSON');
    storage.data.set(PRESET_STORAGE_KEY, '{}');
    expect(() => loadPresetLibrary(storage)).toThrow('not an array');
  });

  it('drops invalid entries and keeps valid ones', () => {
    const valid = createPreset('Valid', '', config);
    storage.data.set(PRESET_STORAGE_KEY, JSON.stringify([{}, valid]));
    expect(loadPresetLibrary(storage)).toEqual([valid]);
  });

  it('refuses to save invalid library entries', () => {
    expect(() => savePresetLibrary(storage, [{} as never])).toThrow('invalid data');
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
      stripeAngle: 45,
      noiseScale: 1,
      seed: 1,
      aoBias: 0,
      aoScale: 1,
      aoDistance: 2,
      sun: { color: '#ffd8a8', intensity: 0.9, direction: { x: -0.5, y: -0.7071067811865476, z: -0.5 }, enabled: true },
      ambient: { color: '#8fb4ff', intensity: 0.6, enabled: true },
      lightmapContribution: 0.75,
      normalStrength: 0.6,
      normalFormat: 'opengl',
    } as State;
  }

  it('derives initial defaults for every serializable setting', () => {
    const defaults = defaultConfigValues();
    expect(Object.keys(defaults)).toHaveLength(19);
    expect(defaults).toEqual({
      resolution: 128,
      mode: 'floyd',
      strength: 0.85,
      brightness: 0,
      contrast: 8,
      saturation: 5,
      stripeAngle: 45,
      noiseScale: 1,
      seed: 1,
      aoBias: 0,
      aoScale: 1,
      aoDistance: 2,
      sunColor: '#ffffff',
      sunIntensity: 1,
      ambientColor: '#ffffff',
      ambientIntensity: 0.7,
      lightmapContribution: 1,
      normalStrength: 1,
      normalFormat: 'opengl',
    });
    // Catalog/structural fields are deliberately not part of the table.
    expect('paletteKey' in defaults).toBe(false);
    expect('uvMap' in defaults).toBe(false);
    expect('palette' in defaults).toBe(false);
  });

  it('collects flat and nested settings out of a State object', () => {
    expect(collectConfigValues(stateFixture())).toEqual({
      resolution: 128,
      mode: 'checker',
      strength: 0.75,
      brightness: 12,
      contrast: -8,
      saturation: 25,
      stripeAngle: 45,
      noiseScale: 1,
      seed: 1,
      aoBias: 0,
      aoScale: 1,
      aoDistance: 2,
      sunColor: '#ffd8a8',
      sunIntensity: 0.9,
      ambientColor: '#8fb4ff',
      ambientIntensity: 0.6,
      lightmapContribution: 0.75,
      normalStrength: 0.6,
      normalFormat: 'opengl',
    });
  });

  it('applies flat config values into a State, creating nested light objects as needed', () => {
    const state = {} as State;
    applyConfigValues(state, {
      resolution: 64,
      sunColor: '#ff0000',
      sunIntensity: 0.5,
      ambientIntensity: 0.3,
      lightmapContribution: 0.25,
      normalFormat: 'directx',
    });
    expect(state.resolution).toBe(64);
    expect(state.sun.color).toBe('#ff0000');
    expect(state.sun.intensity).toBe(0.5);
    expect(state.ambient.intensity).toBe(0.3);
    expect(state.lightmapContribution).toBe(0.25);
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
