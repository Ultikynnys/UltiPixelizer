import { describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Scene,
} from 'three';
import { bakeMeshAO } from '../src/lib/aoBake';

function mirroredHalfOccluderScene(direction: -1 | 1): Scene {
  const scene = new Scene();
  const surface = new Mesh(new PlaneGeometry(2, 2, 2, 2), new MeshBasicMaterial());
  surface.scale.x = direction;
  scene.add(surface);

  const ceiling = new BufferGeometry();
  ceiling.setAttribute('position', new Float32BufferAttribute([
    0, -3, 0.5,  3 * direction, -3, 0.5,  3 * direction, 3, 0.5,
    0, -3, 0.5,  3 * direction, 3, 0.5,  0, 3, 0.5,
  ], 3));
  scene.add(new Mesh(ceiling, new MeshBasicMaterial()));
  return scene;
}

describe('bakeMeshAO', () => {
  it('returns full visibility for an unoccluded plane', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const factors = bakeMeshAO(scene, 8, 8, { samples: 4 });
    expect(Array.from(factors)).toEqual(new Array(64).fill(255));
  });

  it('darkens a surface facing a nearby occluder', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));

    // Ceiling quad with no UVs so it occludes but is never baked itself.
    const ceiling = new BufferGeometry();
    ceiling.setAttribute('position', new Float32BufferAttribute([
      -2, -2, 0.5,  2, -2, 0.5,  2, 2, 0.5,
      -2, -2, 0.5,  2, 2, 0.5,  -2, 2, 0.5,
    ], 3));
    scene.add(new Mesh(ceiling, new MeshBasicMaterial()));

    const factors = bakeMeshAO(scene, 8, 8, { samples: 16, distance: 1 });
    const center = factors[4 * 8 + 4];
    expect(Math.min(...Array.from(factors))).toBeLessThan(255);
    expect(center).toBeLessThan(200);
  });

  it('produces identical output across repeated bakes', () => {
    const scene = mirroredHalfOccluderScene(1);
    const first = bakeMeshAO(scene, 16, 16, { samples: 32, distance: 1 });
    const second = bakeMeshAO(scene, 16, 16, { samples: 32, distance: 1 });
    expect(first).toEqual(second);
  });

  it('balances opposite ray directions for mirrored occlusion', () => {
    const rightOccluded = bakeMeshAO(mirroredHalfOccluderScene(1), 16, 16, { samples: 31, distance: 1 });
    const leftOccluded = bakeMeshAO(mirroredHalfOccluderScene(-1), 16, 16, { samples: 31, distance: 1 });
    expect(rightOccluded).toEqual(leftOccluded);
    expect(Math.min(...rightOccluded)).toBeLessThan(255);
  });

  it('keeps coincident hard-edge vertices separate by normal', () => {
    const scene = new Scene();
    const surface = new BufferGeometry();
    surface.setAttribute('position', new Float32BufferAttribute([
      -1, -1, 0,  1, -1, 0,  -1, 1, 0,
      -1, -1, 0,  1, -1, 0,  -1, 1, 0,
    ], 3));
    surface.setAttribute('normal', new Float32BufferAttribute([
      0, 0, 1,  0, 0, 1,  0, 0, 1,
      0, 0, -1,  0, 0, -1,  0, 0, -1,
    ], 3));
    surface.setAttribute('uv', new Float32BufferAttribute([
      0, 0,  0.45, 0,  0, 1,
      0.55, 0,  1, 0,  1, 1,
    ], 2));
    scene.add(new Mesh(surface, new MeshBasicMaterial()));

    const ceiling = new BufferGeometry();
    ceiling.setAttribute('position', new Float32BufferAttribute([
      -3, -3, 0.5,  3, -3, 0.5,  3, 3, 0.5,
      -3, -3, 0.5,  3, 3, 0.5,  -3, 3, 0.5,
    ], 3));
    scene.add(new Mesh(ceiling, new MeshBasicMaterial()));

    const factors = bakeMeshAO(scene, 16, 8, { samples: 64, distance: 1 });
    expect(factors[6 * 16 + 1]).toBeLessThan(200);
    expect(factors[6 * 16 + 14]).toBe(255);
  });

  it('pads unwritten texels around a UV island with the island edge value instead of the bright background', () => {
    const scene = new Scene();
    const island = new BufferGeometry();
    island.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    island.setAttribute('uv', new Float32BufferAttribute([0.4, 0.4, 0.6, 0.4, 0.4, 0.6], 2));
    scene.add(new Mesh(island, new MeshBasicMaterial()));
    const ceiling = new BufferGeometry();
    ceiling.setAttribute('position', new Float32BufferAttribute([
      -2, -2, 0.5,  2, -2, 0.5,  2, 2, 0.5,
      -2, -2, 0.5,  2, 2, 0.5,  -2, 2, 0.5,
    ], 3));
    scene.add(new Mesh(ceiling, new MeshBasicMaterial()));

    const factors = bakeMeshAO(scene, 8, 8, { samples: 16, distance: 1 });
    // The island itself is occluded by the ceiling…
    expect(factors[3 * 8 + 3]).toBeLessThan(255);
    // …and the texel just outside its left edge inherits that occlusion instead
    // of the bright unoccluded background (the UV-seam light bleed).
    expect(factors[3 * 8 + 2]).toBeLessThan(255);
    // A texel far from the island keeps the background.
    expect(factors[0]).toBe(255);
  });
});
