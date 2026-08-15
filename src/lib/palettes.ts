export type Palette = {
  name: string;
  description: string;
  colors: string[];
};

export const palettes: Record<string, Palette> = {
  ink: {
    name: 'Ink & Paper',
    description: 'Warm monochrome',
    colors: ['#171719', '#48454b', '#9c9284', '#f1e7d1'],
  },
  gameboy: {
    name: 'Pocket LCD',
    description: 'Four mossy greens',
    colors: ['#172313', '#3b5f28', '#82a63b', '#d6e681'],
  },
  pico8: {
    name: 'PICO-8',
    description: 'Punchy fantasy console',
    colors: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
  },
  lospec: {
    name: 'Sweetie 16',
    description: 'Balanced pixel-art range',
    colors: ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57'],
  },
  cga: {
    name: 'CGA Pop',
    description: 'Electric cyan and magenta',
    colors: ['#050505', '#55ffff', '#ff55ff', '#ffffff'],
  },
  ember: {
    name: 'Ember',
    description: 'Smoky heat ramp',
    colors: ['#150b0c', '#49111c', '#9b2226', '#ee6c4d', '#ffb703', '#fff0c2'],
  },
  ocean: {
    name: 'Night Tide',
    description: 'Deep aquatic blues',
    colors: ['#071821', '#0d3446', '#086788', '#07a0c3', '#7ed6df', '#f0f7d4'],
  },
  mono: {
    name: '1-Bit',
    description: 'Pure black and white',
    colors: ['#101010', '#f4f0e6'],
  },
};

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
