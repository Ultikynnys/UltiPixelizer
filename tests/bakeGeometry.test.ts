import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry } from 'three';
import {
  BAKE_PAD_TEXELS,
  collectBakeScene,
  dilateUVBake,
  rasterizeBake,
  rasterizeBakedPixels,
  type BakeTriangle,
} from '../src/lib/bakeGeometry';

function meshWith(attributes: { position?: number[]; uv?: number[]; normal?: number[] }, visible = true): Mesh {
  const geometry = new BufferGeometry();
  if (attributes.position) geometry.setAttribute('position', new Float32BufferAttribute(attributes.position, 3));
  if (attributes.uv) geometry.setAttribute('uv', new Float32BufferAttribute(attributes.uv, 2));
  if (attributes.normal) geometry.setAttribute('normal', new Float32BufferAttribute(attributes.normal, 3));
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.visible = visible;
  return mesh;
}

/** A unit triangle with UVs matching its local XY (uv (0,0),(1,0),(0,1)). */
function uvTriangle(): Mesh {
  return meshWith({
    position: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    uv: [0, 0, 1, 0, 0, 1],
    normal: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  });
}

describe('collectBakeScene', () => {
  it('collects world-space vertices, triangles, and a BVH over occluders', () => {
    const scene = new Object3D();
    const mesh = uvTriangle();
    mesh.position.set(5, 0, 0);
    scene.add(mesh);
    const result = collectBakeScene(scene, 2);

    expect(result.vertices).toHaveLength(3);
    expect(result.triangles).toHaveLength(1);
    // World-space: the local +X vertex is offset by the mesh translation.
    expect(result.vertices[1].position.x).toBeCloseTo(6);
    expect(result.triangles[0].uv).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(result.bvh).not.toBeNull();
    expect(result.maxDistance).toBeCloseTo(result.radius * 2);
    expect(result.epsilon).toBe(result.radius * 1e-3);
  });

  it('deduplicates coincident world position + normal vertices', () => {
    const scene = new Object3D();
    const geometry = new BufferGeometry();
    // Two triangles sharing the (0,0,0)–(0,1,0) edge, same normal.
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
    geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    scene.add(new Mesh(geometry, new MeshBasicMaterial()));
    const result = collectBakeScene(scene);
    expect(result.triangles).toHaveLength(2);
    expect(result.vertices).toHaveLength(4);
  });

  it('recomputes normals for bakeable meshes that have UVs but no normals', () => {
    const scene = new Object3D();
    const mesh = uvTriangle();
    mesh.geometry.deleteAttribute('normal');
    const original = mesh.geometry;
    const dispose = vi.spyOn(original, 'dispose');
    // Indexed input makes computeSmoothNormals return a new de-indexed geometry,
    // which is the branch that swaps and disposes the old one.
    original.setIndex([0, 1, 2]);
    scene.add(mesh);

    const result = collectBakeScene(scene);
    expect(dispose).toHaveBeenCalledOnce();
    expect(mesh.geometry).not.toBe(original);
    expect(mesh.geometry.getAttribute('normal')).not.toBeNull();
    expect(result.triangles).toHaveLength(1);
  });

  it('skips zero-area and collapsed-UV triangles from the bake surface', () => {
    const scene = new Object3D();
    // Collinear positions → zero world area → excluded entirely.
    scene.add(meshWith({
      position: [0, 0, 0, 1, 0, 0, 2, 0, 0],
      uv: [0, 0, 1, 0, 0, 1],
      normal: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    }));
    // Valid area but collapsed UVs → no bake surface, still an occluder.
    scene.add(meshWith({
      position: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      uv: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      normal: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    }));

    const result = collectBakeScene(scene);
    expect(result.triangles).toHaveLength(0);
    expect(result.vertices).toHaveLength(0);
    // The collapsed-UV triangle still casts shadows, so the BVH is built.
    expect(result.bvh).not.toBeNull();
  });

  it('skips invisible meshes and meshes without positions', () => {
    const scene = new Object3D();
    const first = uvTriangle();
    const second = uvTriangle();
    second.position.set(2, 0, 0);
    scene.add(first, second);
    const invisible = uvTriangle();
    invisible.visible = false;
    scene.add(invisible);
    scene.add(new Mesh(new BufferGeometry(), new MeshBasicMaterial()));
    scene.add(new Object3D()); // not a mesh

    const result = collectBakeScene(scene);
    expect(result.triangles).toHaveLength(2);
    expect(result.vertices).toHaveLength(6);
  });

  it('returns a null BVH and safe fallbacks for a scene with no geometry', () => {
    const result = collectBakeScene(new Object3D());
    expect(result.bvh).toBeNull();
    expect(result.triangles).toEqual([]);
    expect(result.vertices).toEqual([]);
    expect(result.epsilon).toBeGreaterThan(0);
    expect(result.maxDistance).toBeGreaterThanOrEqual(0);
  });

  it('derives the occlusion radius from the occluder bounding sphere', () => {
    const scene = new Object3D();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const result = collectBakeScene(scene, 2);
    expect(result.radius).toBeCloseTo(Math.sqrt(0.5), 5);
    expect(result.maxDistance).toBeCloseTo(2 * Math.sqrt(0.5), 5);
  });
});

describe('rasterizeBake', () => {
  function triangleAt(uv: [number, number][]): BakeTriangle {
    return { uv: [uv[0], uv[1], uv[2]], verts: [0, 1, 2] };
  }

  it('covers the UV-space triangle with unit-weight barycentrics', () => {
    const written: Array<{ px: number; py: number; w0: number; w1: number; w2: number }> = [];
    rasterizeBake(4, 4, [triangleAt([[0, 0], [1, 0], [0, 1]])], (px, py, w0, w1, w2) => {
      written.push({ px, py, w0, w1, w2 });
    });
    expect(written.length).toBeGreaterThan(0);
    for (const pixel of written) {
      expect(pixel.px).toBeGreaterThanOrEqual(0);
      expect(pixel.px).toBeLessThan(4);
      expect(pixel.py).toBeGreaterThanOrEqual(0);
      expect(pixel.py).toBeLessThan(4);
      expect(pixel.w0 + pixel.w1 + pixel.w2).toBeCloseTo(1);
    }
  });

  it('skips degenerate zero-area triangles without writing', () => {
    const writePixel = vi.fn();
    rasterizeBake(4, 4, [triangleAt([[0, 0], [0, 0], [0, 1]])], writePixel);
    expect(writePixel).not.toHaveBeenCalled();
  });

  it('clips to the canvas bounds for off-canvas triangles', () => {
    const writePixel = vi.fn();
    rasterizeBake(4, 4, [triangleAt([[0.9, 0.9], [1.1, 0.9], [0.9, 1.1]])], writePixel);
    for (const [px, py] of writePixel.mock.calls.map((call) => [call[0], call[1]] as const)) {
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThan(4);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThan(4);
    }
  });
});

describe('rasterizeBakedPixels', () => {
  const triangle: BakeTriangle = { uv: [[0, 0], [1, 0], [0, 1]], verts: [0, 1, 2] };

  it('fills uncovered texels bright and pads island edges afterward', () => {
    const result = rasterizeBakedPixels(8, 8, [triangle], 1, (pixels, _px, _py, _w0, _w1, _w2, _triangle, offset) => {
      pixels[offset] = 0; // written texels go dark
    });
    // The written island is dark and the padding ring around it inherits 0.
    expect(result[0]).toBe(0);
    // A corner far from the island keeps the bright 255 fill (texel (7,0) sits
    // above the diagonal edge, far beyond the two pad rings).
    expect(result[7]).toBe(255);
  });

  it('keeps every texel bright when nothing is rasterized', () => {
    const degenerate: BakeTriangle = { uv: [[0, 0], [0, 0], [0, 1]], verts: [0, 1, 2] };
    const result = rasterizeBakedPixels(4, 4, [degenerate], 1, () => {});
    expect(Array.from(result)).toEqual(new Array(16).fill(255));
  });
});

describe('dilateUVBake', () => {
  function grid(pixels: number[], written: number[], width: number, height: number, channels: number, pad = BAKE_PAD_TEXELS) {
    const pixelData = new Uint8ClampedArray(pixels);
    const writtenData = new Uint8Array(written);
    dilateUVBake(pixelData, writtenData, width, height, channels, pad);
    return { pixelData, writtenData };
  }

  it('is a no-op for a zero pad', () => {
    const { pixelData } = grid([255, 255, 255, 255, 255, 255, 255, 255, 255], [1, 0, 0, 0, 0, 0, 0, 0, 0], 3, 3, 1, 0);
    expect(Array.from(pixelData)).toEqual(new Array(9).fill(255));
  });

  it('spreads a single written texel to its ring of neighbors', () => {
    // 4×4 grid, only (1,1) written with value 100; padding of 1.
    const pixels = new Uint8ClampedArray(16).fill(255);
    const written = new Uint8Array(16);
    const index = 1 * 4 + 1;
    pixels[index] = 100;
    written[index] = 1;
    dilateUVBake(pixels, written, 4, 4, 1, 1);

    // Center keeps 100; its 8 neighbors inherit 100; corners of the grid stay 255.
    expect(pixels[index]).toBe(100);
    for (const [x, y] of [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]]) {
      expect(pixels[y * 4 + x], `neighbor (${x},${y})`).toBe(100);
    }
    expect(pixels[0 * 4 + 3]).toBe(255);
    expect(pixels[3 * 4 + 0]).toBe(255);
    expect(pixels[3 * 4 + 3]).toBe(255);
  });

  it('averages every channel of the neighbors', () => {
    // 3×3 grid, channels=3. Written texel (1,1) = rgb(200, 100, 0).
    const pixels = new Uint8ClampedArray(27).fill(255);
    const written = new Uint8Array(9);
    const offset = (1 * 3 + 1) * 3;
    pixels.set([200, 100, 0], offset);
    written[1 * 3 + 1] = 1;
    dilateUVBake(pixels, written, 3, 3, 3, 1);

    const neighbor = (1 * 3 + 0) * 3;
    expect(Array.from(pixels.slice(neighbor, neighbor + 3))).toEqual([200, 100, 0]);
  });

  it('expands up to the requested pad rings', () => {
    const pixels = new Uint8ClampedArray(25).fill(255);
    const written = new Uint8Array(25);
    const center = 2 * 5 + 2;
    pixels[center] = 100;
    written[center] = 1;
    dilateUVBake(pixels, written, 5, 5, 1, 2);

    // Ring 2 texel (0,0) is 2 away from the center and inherits the value.
    expect(pixels[0]).toBe(100);
    // Beyond pad: 3+ away stays background — none exist in a 5×5 from center (2,2).
    expect(pixels[4 * 5 + 4]).toBe(100); // (4,4) is 2 rings away (max(2,2)) — also covered
  });

  it('marks padded texels as written for the next ring', () => {
    // 3×3 grid with the center texel written: it plus its 8 neighbors are marked.
    const { writtenData } = grid(
      [255, 255, 255, 255, 255, 255, 255, 255, 255],
      [0, 0, 0, 0, 1, 0, 0, 0, 0],
      3,
      3,
      1,
      1,
    );
    expect(Array.from(writtenData).filter((value) => value === 1)).toHaveLength(9);
  });
});
