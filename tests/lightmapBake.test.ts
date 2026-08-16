import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, PlaneGeometry, Scene, Vector3 } from 'three';
import { bakeMeshLightmap, type BakeLightmapOptions } from '../src/lib/lightmapBake';

const defaults: BakeLightmapOptions = {
  // Orthographic rays travel down camera-local forward (-Z) onto the default +Z plane face.
  sunDirection: { x: 0, y: 0, z: -1 },
  sunColor: '#ffffff',
  sunIntensity: 1,
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
      sunIntensity: 0,
      ambientColor: '#804020',
      ambientIntensity: 1,
    });
    expect(centerRGB(pixels)).toEqual([128, 64, 32]);
  });

  it('lets ambient intensity 0 bake pure black with no minimum fill', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const pixels = bakeMeshLightmap(scene, 8, 8, {
      ...defaults,
      sunIntensity: 0,
      ambientColor: '#ffffff',
      ambientIntensity: 0,
    });
    expect(centerRGB(pixels)).toEqual([0, 0, 0]);
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
      ambientIntensity: 1,
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

  it('perturbs the interpolated vertex normal, not the flat face normal', () => {
    const scene = new Scene();
    const plane = new PlaneGeometry(1, 1);
    // Tilt every vertex normal toward +Y so the smoothed normal no longer matches
    // the +Z face normal — the sun must use this, not the geometric normal.
    const tilt = 1 / Math.SQRT2;
    const normals: number[] = [];
    for (let i = 0; i < plane.getAttribute('normal').count; i += 1) normals.push(0, tilt, tilt);
    plane.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    scene.add(new Mesh(plane, new MeshBasicMaterial()));
    // A flat normal map leaves the shading normal as the interpolated vertex
    // normal. The sun faces +Z, so lambert = tilt (~0.707) rather than 1.
    const flat = { data: new Uint8ClampedArray([128, 128, 255, 255]), width: 1, height: 1 };
    const rgb = centerRGB(bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ffffff', normalMap: flat }));
    expect(rgb[0]).toBeCloseTo(tilt * 255, 0);
    expect(rgb[1]).toBeCloseTo(tilt * 255, 0);
    expect(rgb[2]).toBeCloseTo(tilt * 255, 0);
  });

  it('lights the interpolated normal per pixel rather than averaging per-vertex light', () => {
    const scene = new Scene();
    const geometry = new BufferGeometry();
    // A right triangle whose three vertex normals point in three different
    // directions, so per-vertex (Gouraud) averaging diverges from per-pixel
    // (Phong) shading of the interpolated normal.
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geometry.setAttribute('normal', new Float32BufferAttribute([
      0, 0, 1, // +Z — fully lit
      1, 0, 0, // +X — dark
      0, 1, 0, // +Y — dark
    ], 3));
    scene.add(new Mesh(geometry, new MeshBasicMaterial()));

    // A zero-strength normal map reduces to the interpolated vertex normal, so it
    // is the exact per-pixel reference for the unmapped bake.
    const reference = bakeMeshLightmap(scene, 8, 8, {
      ...defaults,
      sunColor: '#ffffff',
      normalMap: { data: new Uint8ClampedArray([128, 128, 255, 255]), width: 1, height: 1 },
      normalStrength: 0,
    });
    const unmapped = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunColor: '#ffffff' });

    // The unmapped bake must now match the per-pixel reference everywhere — it
    // used to average the three vertex lights instead.
    for (let i = 0; i < unmapped.length; i += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs(unmapped[i + channel] - reference[i + channel])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps a full-strength sun at white regardless of ambient', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const sunOnly = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunIntensity: 1, ambientIntensity: 0 });
    const withAmbient = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunIntensity: 1, ambientIntensity: 0.5 });
    expect(centerRGB(sunOnly)).toEqual([255, 255, 255]);
    expect(centerRGB(withAmbient)).toEqual([255, 255, 255]);
  });

  it('adds ambient to sun rather than subtracting it', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
    const pixels = bakeMeshLightmap(scene, 8, 8, {
      ...defaults,
      sunColor: '#ffffff',
      sunIntensity: 0.5,
      ambientColor: '#ffffff',
      ambientIntensity: 0.25,
    });
    // 0.5 (sun) + 0.25 (ambient) = 0.75 -> 191/255.
    expect(centerRGB(pixels)).toEqual([191, 191, 191]);
  });

  it('pads unwritten texels at UV island edges with island light instead of the bright background', () => {
    const scene = new Scene();
    const island = new BufferGeometry();
    island.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    island.setAttribute('uv', new Float32BufferAttribute([0.4, 0.4, 0.6, 0.4, 0.4, 0.6], 2));
    scene.add(new Mesh(island, new MeshBasicMaterial()));
    const pixels = bakeMeshLightmap(scene, 8, 8, { ...defaults, sunIntensity: 0 });
    const rgb = (px: number, py: number): number[] =>
      Array.from(pixels.slice((py * 8 + px) * 4, (py * 8 + px) * 4 + 3));
    // No light reaches the island, so it bakes black…
    expect(rgb(3, 3)).toEqual([0, 0, 0]);
    // …and the texel just outside its edge inherits that black instead of the
    // full-light background that used to bleed into the UV seam.
    expect(rgb(2, 3)).toEqual([0, 0, 0]);
    // A texel far from the island keeps the full-light background.
    expect(rgb(0, 0)).toEqual([255, 255, 255]);
  });
});
