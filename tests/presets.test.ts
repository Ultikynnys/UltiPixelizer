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
  aoMode: 'none',
  aoIntensity: 1,
  aoInvert: false,
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
