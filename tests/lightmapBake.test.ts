import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';
import { bakeMeshLightmap, type BakeLightmapOptions } from '../src/lib/lightmapBake';

const defaults: BakeLightmapOptions = {
  sunAzimuth: 90,
  sunElevation: 0,
  sunColor: '#ffffff',
  sunIntensity: Math.PI,
  ambientColor: '#000000',
  ambientIntensity: 0,
};

function centerRGB(pixels: Uint8ClampedArray, size = 8): number[] {
  const offset = (4 * size + 4) * 4;
  return Array.from(pixels.slice(offset, offset + 3));
}

describe('bakeMeshLightmap', () => {
  it('bakes ambient color independently of surface direction', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const pixels = bakeMeshLightmap(scene, 8, 8, {
      ...defaults,
      sunEnabled: false,
      ambientColor: '#804020',
      ambientIntensity: Math.PI,
    });
    expect(centerRGB(pixels)).toEqual([128, 64, 32]);
  });

  it('bakes directional sun color on a facing surface', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const pixels = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ff8040' });
    expect(centerRGB(pixels)).toEqual([255, 128, 64]);
  });

  it('leaves a back-facing surface with ambient light only', () => {
    const scene = new Scene();
    const plane = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
    plane.rotation.y = Math.PI;
    scene.add(plane);
    const pixels = bakeMeshLightmap(scene, 8, 8, {
      ...defaults,
      ambientColor: '#404040',
      ambientIntensity: Math.PI,
    });
    expect(centerRGB(pixels)).toEqual([64, 64, 64]);
  });

  it('casts directional shadows from UV-less geometry', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const blocker = new BufferGeometry();
    blocker.setAttribute('position', new Float32BufferAttribute([
      -2, -2, 0.25, 2, -2, 0.25, 2, 2, 0.25,
      -2, -2, 0.25, 2, 2, 0.25, -2, 2, 0.25,
    ], 3));
    scene.add(new Mesh(blocker, new MeshBasicMaterial()));
    const pixels = bakeMeshLightmap(scene, 8, 8, defaults);
    expect(centerRGB(pixels)).toEqual([0, 0, 0]);
  });
});
