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

    const factors = bakeMeshAO(scene, 8, 8, { samples: 16, maxDistance: 1, random: seededRandom(2) });
    const center = factors[4 * 8 + 4];
    expect(Math.min(...Array.from(factors))).toBeLessThan(255);
    expect(center).toBeLessThan(200);
  });
});
