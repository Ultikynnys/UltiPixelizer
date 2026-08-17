export const paletteCategories = ['compact', 'pixel-art', 'hardware', 'themed', 'extended', 'posterize', 'custom'] as const;
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

export function rgbToHex(r: number, g: number, b: number): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const light = Math.min(100, Math.max(0, l)) / 100;
  if (sat === 0) {
    const gray = light * 255;
    return [gray, gray, gray];
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const light = (max + min) / 2;
  if (delta === 0) return [0, 0, light * 100];
  const sat = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) hue = ((bn - rn) / delta + 2) * 60;
  else hue = ((rn - gn) / delta + 4) * 60;
  return [hue, sat * 100, light * 100];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 60;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const value = Math.min(100, Math.max(0, v)) / 100;
  const c = value * sat;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = value - c;
  let rgb: [number, number, number];
  if (hue < 1) rgb = [c, x, 0];
  else if (hue < 2) rgb = [x, c, 0];
  else if (hue < 3) rgb = [0, c, x];
  else if (hue < 4) rgb = [0, x, c];
  else if (hue < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const value = max * 100;
  if (delta === 0) return [0, 0, value];
  const sat = (delta / max) * 100;
  let hue = 0;
  if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) hue = ((bn - rn) / delta + 2) * 60;
  else hue = ((rn - gn) / delta + 4) * 60;
  return [hue, sat, value];
}

export function isHexColor(value: string): boolean {
  return hexColor.test(value);
}
