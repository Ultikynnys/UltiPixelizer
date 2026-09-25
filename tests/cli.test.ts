import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { runCli } from '../cli/main';
import { sunDirectionFromAngles } from '../cli/config';
import { computeOutputDimensions, pixelate, resampleAndPixelate, resize } from '../cli/resample';
import { palettes } from '../src/lib/palettes';

/** Solid-color RGBA image the size of `size`. */
function makeImage(width: number, height: number, rgba: [number, number, number, number] = [200, 90, 40, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { data, width, height };
}

/** Left half red, right half blue  a non-uniform image for spatial checks. */
function makeHalves(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const left = x < width / 2;
      data[i] = left ? 220 : 20;
      data[i + 1] = 40;
      data[i + 2] = left ? 40 : 220;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function writePng(path: string, image: { data: Uint8ClampedArray; width: number; height: number }): void {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

const workdir = mkdtempSync(join(tmpdir(), 'ultipixelizer-cli-'));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  try {
    const code = await runCli(args);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('computeOutputDimensions', () => {
  it('preserves aspect ratio at the target width', () => {
    expect(computeOutputDimensions(128, { width: 256, height: 128 })).toEqual({ width: 128, height: 64 });
  });
  it('floors the height at 1px for extreme ratios', () => {
    expect(computeOutputDimensions(64, { width: 4096, height: 1 }).height).toBe(1);
  });
});

describe('resample', () => {
  it('nearest resize keeps exact block color', () => {
    const src = makeImage(2, 2, [10, 20, 30, 255]);
    const out = resize(src, 4, 4, 'nearest');
    expect(out.width).toBe(4);
    const i = (1 * 4 + 1) * 4;
    expect([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]]).toEqual([10, 20, 30, 255]);
  });

  it('pixelate with 50% halves the intermediate grid but keeps the size', () => {
    const src = makeImage(8, 8);
    const out = pixelate(src, 50, 'nearest');
    expect(out.width).toBe(8);
    expect(out.height).toBe(8);
  });

  it('resampleAndPixelate returns the requested size', () => {
    const out = resampleAndPixelate(makeImage(64, 32), 128, 64, 0, 'nearest');
    expect([out.width, out.height]).toEqual([128, 64]);
  });
});

describe('sunDirectionFromAngles', () => {
  it('reproduces the default sun (azimuth 45, elevation 45)', () => {
    const sun = sunDirectionFromAngles(45, 45);
    // DEFAULT_SUN_DIRECTION is (-0.5, -sqrt(1/2), -0.5).
    expect(sun.x).toBeCloseTo(-0.5, 3);
    expect(sun.y).toBeCloseTo(-0.7071, 3);
    expect(sun.z).toBeCloseTo(-0.5, 3);
  });

  it('defaults both angles when null', () => {
    const sun = sunDirectionFromAngles(null, null);
    expect(Math.hypot(sun.x, sun.y, sun.z)).toBeCloseTo(1, 5);
  });
});

describe('runCli', () => {
  it('prints help and returns 0', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('UltiPixelizer CLI');
    // Every serialized setting shows up in the help.
    expect(stdout).toContain('--ao-bias');
    expect(stdout).toContain('--sun-intensity');
    expect(stdout).toContain('--displacement-flip');
  });

  it('lists modes', async () => {
    const { code, stdout } = await run(['--list-modes']);
    expect(code).toBe(0);
    expect(stdout).toContain('floyd');
    expect(stdout).toContain('halftone');
  });

  it('lists palettes', async () => {
    const { code, stdout } = await run(['--list-palettes']);
    expect(code).toBe(0);
    expect(stdout).toContain('gameboy');
  });

  it('lists view modes', async () => {
    const { code, stdout } = await run(['--list-views']);
    expect(code).toBe(0);
    expect(stdout).toContain('basecolor');
    expect(stdout).toContain('lightmap-ao');
  });

  it('rejects an unknown mode', async () => {
    const { code, stderr } = await run(['--input', 'x.png', '--mode', 'bogus']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/must be one of/);
  });

  it('rejects an unknown view', async () => {
    const { code, stderr } = await run(['--input', 'x.png', '--view', 'bogus']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown view/);
  });

  it('rejects an unknown option', async () => {
    const { code, stderr } = await run(['--nope']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown option/);
  });

  it('requires an input', async () => {
    const { code, stderr } = await run([]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--input/);
  });

  it('rejects an out-of-range numeric config value', async () => {
    const input = join(workdir, 'range.png');
    writePng(input, makeImage(8, 8));
    const { code, stderr } = await run(['--input', input, '--ao-distance', '99']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/out of range/);
  });

  it('dithers a PNG to the requested resolution and palette', async () => {
    const input = join(workdir, 'in.png');
    const output = join(workdir, 'out.png');
    writePng(input, makeImage(64, 64));

    const { code, stdout } = await run([
      '--input', input, '--output', output,
      '--palette', 'gameboy', '--mode', 'floyd', '--resolution', '32', '--json',
    ]);
    expect(code).toBe(0);

    const summary = JSON.parse(stdout);
    expect(summary.resolution).toBe(32);
    expect(summary.size).toEqual({ width: 32, height: 32 });
    expect(summary.paletteColors).toBe(4);
    expect(summary.view).toBe('flat');

    const written = PNG.sync.read(readFileSync(output));
    expect([written.width, written.height]).toEqual([32, 32]);

    // Every pixel must be one of the four GameBoy palette colors.
    const gb = palettes.gameboy.colors.map((hex) => {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });
    expect(gb).toHaveLength(4);
    for (let i = 0; i < written.data.length; i += 4) {
      const px = [written.data[i], written.data[i + 1], written.data[i + 2]];
      expect(gb).toContainEqual(px);
    }
  });

  it('names the output by the view mode', async () => {
    const input = join(workdir, 'view-named.png');
    writePng(input, makeImage(16, 16));
    const { code } = await run(['--input', input, '--view', 'basecolor', '--resolution', '16']);
    expect(code).toBe(0);
    const produced = PNG.sync.read(readFileSync(join(workdir, 'view-named_BaseColor.png')));
    expect(produced.width).toBe(16);
  });

  it('defaults the output path next to the input', async () => {
    const input = join(workdir, 'default-out.png');
    writePng(input, makeImage(16, 16));
    const { code } = await run(['--input', input, '--palette', 'gameboy']);
    expect(code).toBe(0);
    const produced = PNG.sync.read(readFileSync(join(workdir, 'default-out_Combined.png')));
    expect(produced.width).toBe(128);
  });

  it('resamples a non-uniform input at a differing resolution without skewing', async () => {
    const input = join(workdir, 'halves.png');
    writePng(input, makeHalves(64, 64));
    const { code } = await run(['--input', input, '--resolution', '32', '--mode', 'none']);
    expect(code).toBe(0);
    const out = PNG.sync.read(readFileSync(join(workdir, 'halves_Combined.png')));
    expect([out.width, out.height]).toEqual([32, 32]);
    const px = (x: number, y: number) => {
      const i = (y * 32 + x) * 4;
      return [out.data[i], out.data[i + 1], out.data[i + 2]];
    };
    const left = px(4, 16);
    const right = px(28, 16);
    expect(left[0]).toBeGreaterThan(left[2]); // left half stayed red
    expect(right[2]).toBeGreaterThan(right[0]); // right half stayed blue
  });

  it('loads a .hex custom palette file', async () => {
    const input = join(workdir, 'hexin.png');
    writePng(input, makeImage(16, 16));
    const palette = join(workdir, 'my-pal.hex');
    writeFileSync(palette, '#000000\n#ffffff\n#ff0000\n');
    const { code, stdout } = await run([
      '--input', input, '--palette-file', palette, '--resolution', '16', '--json',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).paletteColors).toBe(3);
  });

  it('accepts every serialized config flag as a plain --flag value', async () => {
    const input = join(workdir, 'flags.png');
    writePng(input, makeImage(16, 16));
    const { code, stdout } = await run([
      '--input', input, '--resolution', '16', '--json',
      '--ao-bias', '0.2', '--ao-power', '1.5', '--ao-distance', '1.4',
      '--sun-color', '#ffcc88', '--sun-intensity', '1.6',
      '--ambient-color', '#334455', '--ambient-intensity', '0.4',
      '--normal-strength', '0.8', '--normal-format', 'directx',
      '--uv-stretch-sensitivity', '2', '--quad-tessellation', '24',
      '--displacement-strength', '0.1',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).mode).toBe('floyd');
  });

  it('dithers in world pattern space with no model (fallback quad)', async () => {
    const input = join(workdir, 'world.png');
    writePng(input, makeImage(16, 16));
    const { code } = await run([
      '--input', input, '--pattern-space', 'world', '--mode', 'noise', '--resolution', '16',
    ]);
    expect(code).toBe(0);
    const produced = PNG.sync.read(readFileSync(join(workdir, 'world_Combined.png')));
    expect([produced.width, produced.height]).toEqual([16, 16]);
  });

  it('round-trips a world-space preset and dithers with it', async () => {
    const input = join(workdir, 'world-rt.png');
    writePng(input, makeImage(16, 16));
    const preset = join(workdir, 'world.settings.json');
    const dumped = await run([
      '--input', input, '--mode', 'noise', '--pattern-space', 'world',
      '--worldspace-scale', '160', '--palette', 'gameboy', '--dump-config', preset,
    ]);
    expect(dumped.code).toBe(0);
    const json = JSON.parse(readFileSync(preset, 'utf8'));
    expect(json.patternSpace).toBe('world');
    expect(json.mode).toBe('noise');

    const { code, stdout } = await run(['--input', input, '--preset', preset, '--resolution', '16', '--json']);
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.mode).toBe('noise');
    expect(result.paletteColors).toBe(4);
  });

  it('bakes AO with no model (fallback quad) and writes the AO view', async () => {
    const input = join(workdir, 'ao-bake.png');
    writePng(input, makeImage(16, 16));
    const { code } = await run(['--input', input, '--generate-ao', '--view', 'ao', '--resolution', '16']);
    expect(code).toBe(0);
    const produced = PNG.sync.read(readFileSync(join(workdir, 'ao-bake_AO.png')));
    expect([produced.width, produced.height]).toEqual([16, 16]);
  });

  it('bakes a lightmap with a custom sun angle and writes the lightmap view', async () => {
    const input = join(workdir, 'lm-bake.png');
    writePng(input, makeImage(16, 16));
    const { code } = await run([
      '--input', input, '--bake-lighting', '--view', 'lightmap', '--resolution', '16',
      '--sun-azimuth', '120', '--sun-elevation', '35', '--sun-intensity', '1.4',
    ]);
    expect(code).toBe(0);
    const produced = PNG.sync.read(readFileSync(join(workdir, 'lm-bake_Lightmap.png')));
    expect(produced.width).toBe(16);
  });

  it('round-trips settings through --dump-config', async () => {
    const input = join(workdir, 'roundtrip.png');
    writePng(input, makeImage(16, 16));
    const preset = join(workdir, 'rt.settings.json');
    const dumped = await run([
      '--input', input, '--palette', 'c64', '--mode', 'ordered', '--resolution', '32',
      '--ao-bias', '0.1', '--sun-azimuth', '120', '--sun-elevation', '35',
      '--dump-config', preset,
    ]);
    expect(dumped.code).toBe(0);

    const json = JSON.parse(readFileSync(preset, 'utf8'));
    expect(json.version).toBe(7);
    expect(json.mode).toBe('ordered');
    expect(json.resolution).toBe(32);
    expect(json.paletteKey).toBe('c64');
    // azimuth 120 / elevation 35 -> travel (-0.709, -0.574, 0.410)
    expect(json.sunDirection.x).toBeCloseTo(-0.709, 2);
    expect(json.sunDirection.y).toBeCloseTo(-0.574, 2);

    // A second run loads it back through --preset.
    const reused = await run(['--input', input, '--preset', preset, '--view', 'basecolor', '--json']);
    expect(reused.code).toBe(0);
    expect(JSON.parse(reused.stdout).mode).toBe('ordered');
    expect(JSON.parse(reused.stdout).paletteColors).toBe(16);
  });
});
