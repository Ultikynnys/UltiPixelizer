export const paletteCategories = ['compact', 'pixel-art', 'hardware', 'themed', 'extended', 'custom'] as const;
export type PaletteCategory = typeof paletteCategories[number];

export type Palette = {
  name: string;
  category: PaletteCategory;
  colors: string[];
  attribution?: string;
  source?: string;
};

const hexColor = /^#[0-9a-f]{6}$/i;

export function isPalette(value: unknown): value is Palette {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Palette>;
  return typeof candidate.name === 'string' && candidate.name.length > 0
    && paletteCategories.includes(candidate.category as PaletteCategory)
    && Array.isArray(candidate.colors) && candidate.colors.length >= 2 && candidate.colors.length <= 256
    && candidate.colors.every((color) => typeof color === 'string' && hexColor.test(color))
    && (candidate.attribution === undefined || typeof candidate.attribution === 'string')
    && (candidate.source === undefined || typeof candidate.source === 'string');
}

const modules = import.meta.glob<unknown>('../palettes/*.json', { eager: true, import: 'default' });

export const palettes: Record<string, Palette> = Object.fromEntries(
  Object.entries(modules).map(([path, value]) => {
    const key = path.split('/').pop()?.replace(/\.json$/, '');
    if (!key || !isPalette(value)) throw new Error(`Invalid palette file: ${path}`);
    return [key, value];
  }),
);

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function isHexColor(value: string): boolean {
  return hexColor.test(value);
}
