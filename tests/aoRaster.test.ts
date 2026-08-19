import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { rasterizeAOBand, rasterizeAOShading, serializeBakeScene } from '../src/lib/aoRaster';
import { uvIsland } from './helpers/bakeFixtures';

describe('rasterizeAOShading', () => {
  it('marks the same covered texels as rasterizeAOBand', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial()));
    const bakeScene = collectBakeScene(scene, 1);
    const input = serializeBakeScene(bakeScene, 8);
    const width = 8;
    const height = 8;

    const factors = new Uint8ClampedArray(width * height).fill(255);
    const writtenByRaster = new Uint8Array(width * height);
    rasterizeAOBand(factors, writtenByRaster, bakeScene.bvh!, input, { width, height, yStart: 0, yEnd: height });

    const writtenByShading = new Uint8Array(width * height);
    const texelData = new Float32Array(width * height * 6);
    rasterizeAOShading(writtenByShading, texelData, input, { width, height, yStart: 0, yEnd: height });

    expect(Array.from(writtenByShading)).toEqual(Array.from(writtenByRaster));
  });

  it('records a flat plane\'s shading normal as +Z and offsets the origin by epsilon', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial()));
    const bakeScene = collectBakeScene(scene, 1);
    const input = serializeBakeScene(bakeScene, 8);
    const width = 4;
    const height = 4;

    const written = new Uint8Array(width * height);
    const texelData = new Float32Array(width * height * 6);
    rasterizeAOShading(written, texelData, input, { width, height, yStart: 0, yEnd: height });

    const center = 2 * width + 2;
    expect(written[center]).toBe(1);
    const offset = center * 6;
    // The smooth shading normal is +Z across the whole plane.
    expect(texelData[offset + 3]).toBeCloseTo(0, 5);
    expect(texelData[offset + 4]).toBeCloseTo(0, 5);
    expect(texelData[offset + 5]).toBeCloseTo(1, 5);
    // The ray origin is offset off the z = 0 plane by epsilon along +Z.
    expect(texelData[offset + 2]).toBeCloseTo(input.epsilon, 5);
  });

  it('leaves unwritten texels at zero so the shader emits the bright fill', () => {
    const scene = new Scene();
    scene.add(new Mesh(uvIsland(), new MeshBasicMaterial()));
    const bakeScene = collectBakeScene(scene, 1);
    const input = serializeBakeScene(bakeScene, 8);
    const width = 8;
    const height = 8;

    const written = new Uint8Array(width * height);
    const texelData = new Float32Array(width * height * 6);
    rasterizeAOShading(written, texelData, input, { width, height, yStart: 0, yEnd: height });

    // The island covers UV 0.4..0.6, so the far corner texel stays unwritten
    // and its shading data stays at zero.
    expect(written[0]).toBe(0);
    expect(Array.from(texelData.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
