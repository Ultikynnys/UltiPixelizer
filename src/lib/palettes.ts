export type PaletteCategory = 'compact' | 'pixel-art' | 'hardware' | 'themed' | 'extended';

export type Palette = {
  name: string;
  description: string;
  category: PaletteCategory;
  colors: string[];
  attribution?: string;
  source?: string;
};

const colors = (hex: string): string[] => hex.split(/\s+/).map((color) => `#${color}`);

const rgb332 = Array.from({ length: 256 }, (_, value) => {
  const red = Math.round(((value >> 5) & 7) * 255 / 7);
  const green = Math.round(((value >> 2) & 7) * 255 / 7);
  const blue = Math.round((value & 3) * 255 / 3);
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
});

export const palettes: Record<string, Palette> = {
  ink: { name: 'Ink & Paper', description: 'Warm monochrome', category: 'compact', colors: colors('171719 48454b 9c9284 f1e7d1') },
  gameboy: { name: 'Pocket LCD', description: 'Four mossy greens', category: 'hardware', colors: colors('172313 3b5f28 82a63b d6e681') },
  pico8: { name: 'PICO-8', description: 'Punchy fantasy console', category: 'pixel-art', colors: colors('000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa'), attribution: 'Lexaloffle Games' },
  lospec: { name: 'Sweetie 16', description: 'Balanced pixel-art range', category: 'pixel-art', colors: colors('1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57'), attribution: 'GrafxKid' },
  cga: { name: 'CGA Pop', description: 'Electric cyan and magenta', category: 'hardware', colors: colors('050505 55ffff ff55ff ffffff') },
  ember: { name: 'Ember', description: 'Smoky heat ramp', category: 'compact', colors: colors('150b0c 49111c 9b2226 ee6c4d ffb703 fff0c2') },
  ocean: { name: 'Night Tide', description: 'Deep aquatic blues', category: 'compact', colors: colors('071821 0d3446 086788 07a0c3 7ed6df f0f7d4') },
  mono: { name: '1-Bit', description: 'Pure black and white', category: 'compact', colors: colors('101010 f4f0e6') },

  aap64: { name: 'AAP-64', description: 'Expansive all-purpose pixel palette', category: 'extended', attribution: 'Adigun A. Polack', source: 'Lospec', colors: colors('060608 141013 3b1725 73172d b4202a df3e23 fa6a0a f9a31b ffd541 fffc40 d6f264 9cdb43 59c135 14a02e 1a7a3e 24523b 122020 143464 285cc4 249fde 20d6c7 a6fcdb ffffff fef3c0 fad6b8 f5a097 e86a73 bc4a9b 793a80 403353 242234 221c1a 322b28 71413b bb7547 dba463 f4d29c dae0ea b3b9d1 8b93af 6d758d 4a5462 333941 422433 5b3138 8e5252 ba756a e9b5a3 e3e6ff b9bffb 849be4 588dbe 477d85 23674e 328464 5daf8d 92dcba cdf7e2 e4d2aa c7b08b a08662 796755 5a4e44 423934') },
  endesga32: { name: 'Endesga 32', description: 'Vibrant game-ready spectrum', category: 'extended', attribution: 'ENDESGA', source: 'Lospec', colors: colors('be4a2f d77643 ead4aa e4a672 b86f50 733e39 3e2731 a22633 e43b44 f77622 feae34 fee761 63c74d 3e8948 265c42 193c3e 124e89 0099db 2ce8f5 ffffff c0cbdc 8b9bb4 5a6988 3a4466 262b44 181425 ff0044 68386c b55088 f6757a e8b796 c28569') },
  dawnbringer32: { name: 'DawnBringer 32', description: 'Classic balanced pixel-art set', category: 'extended', attribution: 'DawnBringer', source: 'Lospec', colors: colors('000000 222034 45283c 663931 8f563b df7126 d9a066 eec39a fbf236 99e550 6abe30 37946e 4b692f 524b24 323c39 3f3f74 306082 5b6ee1 639bff 5fcde4 cbdbfc ffffff 9badb7 847e87 696a6a 595652 76428a ac3232 d95763 d77bba 8f974a 8a6f30') },
  na16: { name: 'NA16', description: 'Muted storybook colors', category: 'pixel-art', attribution: 'Nauris', source: 'Lospec', colors: colors('8c8fae 584563 3e2137 9a6348 d79b7d f5edba c0c741 647d34 e4943a 9d303b d26471 70377f 7ec4c1 34859d 17434b 1f0e1c') },
  ansi16: { name: 'ANSI 16', description: 'Terminal standard colors', category: 'hardware', colors: colors('000000 800000 008000 808000 000080 800080 008080 c0c0c0 808080 ff0000 00ff00 ffff00 0000ff ff00ff 00ffff ffffff') },
  c64: { name: 'Commodore 64', description: 'Home-computer nostalgia', category: 'hardware', colors: colors('000000 ffffff 880000 aaffee cc44cc 00cc55 0000aa eeee77 dd8855 664400 ff7777 333333 777777 aaff66 0088ff bbbbbb') },
  zx: { name: 'ZX Spectrum', description: 'Eight colors in two intensities', category: 'hardware', colors: colors('000000 0000cd cd0000 cd00cd 00cd00 00cdcd cdcd00 cdcdcd 0000ff ff0000 ff00ff 00ff00 00ffff ffff00 ffffff 202020') },
  solarized: { name: 'Solarized', description: 'Low-strain precision hues', category: 'themed', attribution: 'Ethan Schoonover', colors: colors('002b36 073642 586e75 657b83 839496 93a1a1 eee8d5 fdf6e3 b58900 cb4b16 dc322f d33682 6c71c4 268bd2 2aa198 859900') },
  nord: { name: 'Nord', description: 'Polar night and frost', category: 'themed', attribution: 'Arctic Ice Studio', colors: colors('2e3440 3b4252 434c5e 4c566a d8dee9 e5e9f0 eceff4 8fbcbb 88c0d0 81a1c1 5e81ac bf616a d08770 ebcb8b a3be8c b48ead') },
  gruvbox: { name: 'Gruvbox', description: 'Retro groove with warm contrast', category: 'themed', attribution: 'Pavel Pertsev', colors: colors('1d2021 282828 3c3836 504945 665c54 7c6f64 928374 ebdbb2 fb4934 fe8019 fabd2f b8bb26 8ec07c 83a598 d3869b d65d0e') },
  pastel24: { name: 'Pastel 24', description: 'Soft full-spectrum chalks', category: 'extended', colors: colors('2f2a3b 5b536b 8c7f91 c6b8b2 f4e6d4 f6b8b8 e98f9c c86b85 9d5c8b 7b6aa8 8897c4 8fb8d8 9adbd5 79c9a7 7abf7f a7d46f d9dc78 f4d06f f5ad65 e98655 ca6a4b a65454 704b5e 453847') },
  earth24: { name: 'Earth 24', description: 'Stone, soil, leaf, and sky', category: 'extended', colors: colors('171c18 29332b 3d4a37 52633f 6d7849 8b8c58 a9a66a c9c18a e5ddb5 f5f0d7 3b2b26 593c2e 79533a 9b7049 be9461 d7b47a 5b3331 81443e a65d4d cb7b61 263b49 36566b 50768b 79a0ad') },
  neon24: { name: 'Neon 24', description: 'Arcade light against deep shadow', category: 'extended', colors: colors('05050a 0d1021 181b3a 24265c 312b78 58308f 8b2fa1 c92f9b f23883 ff5263 ff7b42 ffa62b ffd23f f9f871 b6f45f 69e85b 25d98b 18c9bb 19b4e8 398cff 5965f2 824ee0 bd4bd8 f5d5ff') },
  autumn16: { name: 'Autumn 16', description: 'Leaves, bark, and late sunlight', category: 'themed', colors: colors('1b1410 332018 523023 76432b 9e5a2f c87532 ec9b3b f8c65a f7e39a d2c66f a1a44f 6f7c3d 46552e 71343b a94c45 d87550') },
  arctic16: { name: 'Arctic 16', description: 'Ice caves and blue twilight', category: 'themed', colors: colors('07141f 0c2638 123d55 195875 26779a 3999bb 58b8d0 82d1df b5e5e8 e8f5f2 ffffff 8a9eb5 64738f 484e6d 322e4f 211d38') },
  skin16: { name: 'Skin Tones 16', description: 'Broad portrait shading range', category: 'themed', colors: colors('2b1712 48251b 673426 864832 a95e40 c97855 e3946e f0af89 f7c6a5 f9d9bd f7e7d5 8e5b51 6e4546 50343d 352631 211c27') },
  vapor: { name: 'Vaporwave', description: 'Sunset chrome and pool light', category: 'themed', colors: colors('160c2d 2d1552 512179 813190 b84a9d e66ca4 ff9aaf ffc3b8 f8e0cc 74d4d8 35a8c4 246b9b') },
  forest: { name: 'Old Forest', description: 'Deep woodland ramp', category: 'compact', colors: colors('0c1510 16251a 213722 304b2b 456136 617a43 829553 a6af68 c9c985 e4dfac f4eed0 6b4632') },
  desert: { name: 'Desert Bloom', description: 'Sandstone and cactus flowers', category: 'compact', colors: colors('251b18 473026 6e4933 986743 c58a57 e5ae70 f4d194 f9e7bd 7a8140 4d6539 9f4e55 d97569') },
  arcade: { name: 'Arcade 12', description: 'Saturated cabinet graphics', category: 'compact', colors: colors('080808 27214d 45368f 3066be 2da8c4 52d273 a8e04f f6df3a f59b32 ec4c3c c43b82 f5f2df') },
  noir: { name: 'Noir Film', description: 'Silver gelatin with warm highlights', category: 'compact', colors: colors('090a0b 1b1d20 34373b 51555a 73777b 999b9b c1c0ba e8e2d5 b9a27d 795f45') },
  rgb332: { name: 'RGB 3-3-2', description: 'Complete 8-bit RGB color cube', category: 'extended', colors: rgb332 },
};

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
