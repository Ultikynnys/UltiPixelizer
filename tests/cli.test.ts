import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { runCli } from '../cli/main';
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

describe('runCli', () => {
  it('prints help and returns 0', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('UltiPixelizer CLI');
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

  it('rejects an unknown mode', async () => {
    const { code, stderr } = await run(['--input', 'x.png', '--mode', 'bogus']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown mode/);
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

  it('defaults the output path next to the input', async () => {
    const input = join(workdir, 'default-out.png');
    writePng(input, makeImage(16, 16));
    const { code } = await run(['--input', input, '--palette', 'gameboy']);
    expect(code).toBe(0);
    const produced = PNG.sync.read(readFileSync(join(workdir, 'default-out_ultipixelized.png')));
    expect(produced.width).toBe(128);
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

  it('rejects the world pattern space (needs a 3D bake)', async () => {
    const input = join(workdir, 'world.png');
    writePng(input, makeImage(8, 8));
    const { code, stderr } = await run(['--input', input, '--pattern-space', 'world']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/world/);
  });
});
