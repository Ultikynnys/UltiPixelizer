import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, PlaneGeometry, Scene, Vector3 } from 'three';
import { bakeMeshLightmap, type BakeLightmapOptions } from '../src/lib/lightmapBake';

const defaults: BakeLightmapOptions = {
  // Orthographic rays travel down camera-local forward (-Z) onto the default +Z plane face.
  sunDirection: { x: 0, y: 0, z: -1 },
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

  it('lights a camera-facing surface when orthographic rays travel toward it', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const pixels = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ff8040' });
    expect(centerRGB(pixels)).toEqual([255, 128, 64]);
  });

  it('leaves the reverse side of the orthographic source with ambient only', () => {
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

  it('lights a source-facing plane from all six cardinal ray directions', () => {
    const planeNormal = new Vector3(0, 0, 1);
    for (const rayDirection of [
      new Vector3(1, 0, 0),
      new Vector3(-1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, -1, 0),
      new Vector3(0, 0, 1),
      new Vector3(0, 0, -1),
    ]) {
      const scene = new Scene();
      const plane = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
      plane.quaternion.setFromUnitVectors(planeNormal, rayDirection.clone().negate());
      scene.add(plane);
      const pixels = bakeMeshLightmap(scene, 8, 8, {
        ...defaults,
        sunDirection: rayDirection,
      });
      expect(centerRGB(pixels)).toEqual([255, 255, 255]);
    }
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

  it('ignores the normal map at zero strength', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const tilt = { data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1 };
    const zero = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ff8040', normalMap: tilt, normalStrength: 0 });
    const none = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ff8040' });
    expect(centerRGB(zero)).toEqual(centerRGB(none));
  });

  it('bakes a flat normal map close to the unmapped result', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const flat = { data: new Uint8ClampedArray([128, 128, 255, 255]), width: 1, height: 1 };
    const [r, g, b] = centerRGB(bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ff8040', normalMap: flat }));
    expect(r).toBeGreaterThanOrEqual(254);
    expect(g).toBeGreaterThanOrEqual(127);
    expect(g).toBeLessThanOrEqual(128);
    expect(b).toBeGreaterThanOrEqual(63);
    expect(b).toBeLessThanOrEqual(64);
  });

  it('reduces sun contribution when the normal map tilts away from the sun', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const tilt = { data: new Uint8ClampedArray([255, 128, 128, 255]), width: 1, height: 1 };
    const flat = { data: new Uint8ClampedArray([128, 128, 255, 255]), width: 1, height: 1 };
    const tilted = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ffffff', normalMap: tilt });
    const flatResult = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ffffff', normalMap: flat });
    expect(centerRGB(tilted)[0]).toBeLessThan(centerRGB(flatResult)[0]);
  });
});
