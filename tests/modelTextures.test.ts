import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Mesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, Texture } from 'three';
import { collectModelTextures, textureSourceImage } from '../src/lib/modelTextures';
import { asSourceImage, FakeCanvas, FakeImageData, installDomStubs } from './helpers/domStubs';

/** Builds a canvas of known pixel rows, e.g. [[[255,0,0],[0,255,0]], [[0,0,255],[255,255,255]]]. */
function canvasWithRows(rows: number[][][]): FakeCanvas {
  const canvas = new FakeCanvas();
  canvas.width = rows[0].length;
  canvas.height = rows.length;
  const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  rows.forEach((row, y) => {
    row.forEach(([r, g, b], x) => {
      const offset = (y * canvas.width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    });
  });
  canvas.context.putImageData(new FakeImageData(data, canvas.width, canvas.height), 0, 0);
  return canvas;
}

/** Reads the returned canvas back as pixel rows for comparison. */
function rowsOf(source: CanvasImageSource & { width: number; height: number }): number[][][] {
  const canvas = source as unknown as FakeCanvas;
  const { width, height } = canvas;
  const data = canvas.context.getImageData(0, 0, width, height).data;
  const rows: number[][][] = [];
  for (let y = 0; y < height; y += 1) {
    const row: number[][] = [];
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      row.push([data[offset], data[offset + 1], data[offset + 2]]);
    }
    rows.push(row);
  }
  return rows;
}

function meshWith(material: MeshLambertMaterial | MeshBasicMaterial): Mesh {
  return new Mesh(new BufferGeometry(), material);
}

beforeEach(() => {
  installDomStubs();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('textureSourceImage', () => {
  it('copies a flipY=true texture image as-is at native size', () => {
    const source = canvasWithRows([[[255, 0, 0], [0, 255, 0]], [[0, 0, 255], [255, 255, 255]]]);
    const texture = new Texture(asSourceImage(source));
    expect(texture.flipY).toBe(true);
    const result = textureSourceImage(texture);
    expect(result).not.toBeNull();
    expect(rowsOf(result!)).toEqual([[[255, 0, 0], [0, 255, 0]], [[0, 0, 255], [255, 255, 255]]]);
  });

  it('flips glTF textures (flipY=false) vertically to match the bake convention', () => {
    const source = canvasWithRows([[[255, 0, 0], [0, 255, 0]], [[0, 0, 255], [255, 255, 255]]]);
    const texture = new Texture(asSourceImage(source));
    texture.flipY = false;
    const result = textureSourceImage(texture);
    expect(rowsOf(result!)).toEqual([[[0, 0, 255], [255, 255, 255]], [[255, 0, 0], [0, 255, 0]]]);
  });

  it('returns null for textures without a drawable image', () => {
    expect(textureSourceImage(new Texture())).toBeNull();
    // Compressed / KTX2 textures carry a mipmap set, not a drawable image.
    const compressed = new Texture();
    compressed.image = { mipmaps: [] } as never;
    expect(textureSourceImage(compressed)).toBeNull();
  });
});

describe('collectModelTextures', () => {
  it('collects the first base, normal, and AO texture across a scene', () => {
    const root = new Object3D();
    const base = new Texture(canvasWithRows([[[200, 10, 10]]]) as never);
    const normal = new Texture(canvasWithRows([[[10, 200, 10]]]) as never);
    const ao = new Texture(canvasWithRows([[[10, 10, 200]]]) as never);
    const material = new MeshLambertMaterial();
    material.map = base;
    material.normalMap = normal;
    material.aoMap = ao;
    root.add(meshWith(material));

    const found = collectModelTextures(root);
    expect(found.base).not.toBeUndefined();
    expect(found.normal).not.toBeUndefined();
    expect(found.ao).not.toBeUndefined();
  });

  it('walks material arrays and fills missing channels from later materials', () => {
    const root = new Object3D();
    const normal = new Texture(canvasWithRows([[[10, 200, 10]]]) as never);
    const first = new MeshLambertMaterial();
    const second = new MeshLambertMaterial();
    second.normalMap = normal;
    const mesh = new Mesh(new BufferGeometry(), [first, second]);
    root.add(mesh);

    const found = collectModelTextures(root);
    expect(found.normal).not.toBeUndefined();
    expect(found.base).toBeUndefined();
    expect(found.ao).toBeUndefined();
  });

  it('returns nothing for untextured models', () => {
    const root = new Object3D();
    root.add(meshWith(new MeshLambertMaterial()));
    root.add(meshWith(new MeshBasicMaterial()));
    expect(collectModelTextures(root)).toEqual({});
  });
});
