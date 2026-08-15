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

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe('bakeMeshAO', () => {
  it('returns full visibility for an unoccluded plane', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const factors = bakeMeshAO(scene, 8, 8, { samples: 4, random: seededRandom(1) });
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

    const factors = bakeMeshAO(scene, 8, 8, { samples: 16, distance: 1, random: seededRandom(2) });
    const center = factors[4 * 8 + 4];
    expect(Math.min(...Array.from(factors))).toBeLessThan(255);
    expect(center).toBeLessThan(200);
  });

  it('generates one deterministic shared sample kernel per bake', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1, 4, 4), new MeshBasicMaterial()));
    const random = seededRandom(3);
    let calls = 0;
    const countedRandom = () => { calls += 1; return random(); };
    const first = bakeMeshAO(scene, 8, 8, { samples: 9, random: countedRandom });
    const second = bakeMeshAO(scene, 8, 8, { samples: 9, random: seededRandom(3) });
    expect(calls).toBe(18);
    expect(first).toEqual(second);
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

    const factors = bakeMeshAO(scene, 16, 8, { samples: 64, distance: 1, random: seededRandom(4) });
    expect(factors[6 * 16 + 1]).toBeLessThan(200);
    expect(factors[6 * 16 + 14]).toBe(255);
  });
});
