import { beforeEach, describe, expect, it } from 'vitest';
import { palettes } from '../src/lib/palettes';
import {
  PRESET_STORAGE_KEY,
  createPreset,
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
  sunIntensity: 3.4,
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
    expect(parsed.sunIntensity).toBe(2.8);
    expect(parsed.ambientColor).toBe('#ffffff');
    expect(parsed.ambientIntensity).toBe(2.2);
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

  it('tolerates absent, corrupt, non-array, and partially invalid stored libraries', () => {
    expect(loadPresetLibrary(storage)).toEqual([]);
    storage.data.set(PRESET_STORAGE_KEY, '{bad');
    expect(loadPresetLibrary(storage)).toEqual([]);
    storage.data.set(PRESET_STORAGE_KEY, '{}');
    expect(loadPresetLibrary(storage)).toEqual([]);
    const valid = createPreset('Valid', '', config);
    storage.data.set(PRESET_STORAGE_KEY, JSON.stringify([{}, valid]));
    expect(loadPresetLibrary(storage)).toEqual([valid]);
  });

  it('refuses to save invalid library entries', () => {
    expect(() => savePresetLibrary(storage, [{} as never])).toThrow('invalid data');
  });
});
