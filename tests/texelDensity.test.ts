import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene } from 'three';
import { computeAverageTexelDensity, computeUVStretchData, uvStretchColor } from '../src/lib/texelDensity';

/** Single-triangle mesh: world triangle (0,0,0)-(1,0,0)-(0,1,0) (area 0.5)
 * mapped onto UV triangle (0,0)-(1,0)-(0,1) (UV area 0.5). */
function triMesh(uv: [number, number][] = [[0, 0], [1, 0], [0, 1]], position: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('uv', new Float32BufferAttribute(uv.flat(), 2));
  geometry.setAttribute('position', new Float32BufferAttribute(position.flat(), 3));
  return new Mesh(geometry, new MeshBasicMaterial());
}

function quadMesh(): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return new Mesh(geometry, new MeshBasicMaterial());
}

describe('average texel density', () => {
  it('uses sqrt(summed UV area × texture area / summed world area)', () => {
    const scene = new Scene();
    scene.add(quadMesh());
    expect(computeAverageTexelDensity(scene, 100, 50)).toBeCloseTo(Math.sqrt(5000), 10);
  });

  it('scales linearly when both texture dimensions scale equally', () => {
    const scene = new Scene();
    scene.add(quadMesh());
    expect(computeAverageTexelDensity(scene, 200, 100)).toBeCloseTo(Math.sqrt(20000), 10);
  });

  it('sums stacked UV and corresponding world area per mapped layer', () => {
    const scene = new Scene();
    scene.add(quadMesh(), quadMesh());
    // UV area and world area both double, preserving density.
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(100);
  });

  it('includes UV shell area outside the 0–1 square', () => {
    const scene = new Scene();
    scene.add(triMesh([[-1, -1], [3, -1], [-1, 3]], [[0, 0, 0], [1, 0, 0], [0, 2, 0]]));
    // Unclipped UV area is 8 and world area is 1.
    expect(computeAverageTexelDensity(scene, 32, 16)).toBe(64);
  });

  it('is unaffected by tessellation of the same UV and world surface', () => {
    const coarse = new Scene();
    coarse.add(quadMesh());

    const dense = new Scene();
    dense.add(triMesh(
      [
        [0, 0], [0.5, 0], [0, 0.5],
        [0.5, 0], [1, 0], [1, 0.5],
        [0.5, 0], [1, 0.5], [0.5, 0.5],
        [0.5, 0], [0.5, 0.5], [0, 0.5],
        [0.5, 0.5], [1, 0.5], [1, 1],
        [0.5, 0.5], [1, 1], [0.5, 1],
        [0, 0.5], [0.5, 0.5], [0.5, 1],
        [0, 0.5], [0.5, 1], [0, 1],
      ],
      [
        [0, 0, 0], [0.5, 0, 0], [0, 0.5, 0],
        [0.5, 0, 0], [1, 0, 0], [1, 0.5, 0],
        [0.5, 0, 0], [1, 0.5, 0], [0.5, 0.5, 0],
        [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0],
        [0.5, 0.5, 0], [1, 0.5, 0], [1, 1, 0],
        [0.5, 0.5, 0], [1, 1, 0], [0.5, 1, 0],
        [0, 0.5, 0], [0.5, 0.5, 0], [0.5, 1, 0],
        [0, 0.5, 0], [0.5, 1, 0], [0, 1, 0],
      ],
    ));

    expect(computeAverageTexelDensity(dense, 64, 64)).toBe(
      computeAverageTexelDensity(coarse, 64, 64),
    );
  });

  it('excludes UV-less surfaces from the corresponding area sums', () => {
    const scene = new Scene();
    const uvless = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    uvless.geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    uvless.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    scene.add(quadMesh(), uvless);
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(100);
  });

  it('uses transformed world-space surface area', () => {
    const scene = new Scene();
    const mesh = quadMesh();
    mesh.scale.set(2, 2, 2);
    scene.add(mesh);
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(50);
  });

  it('ignores invisible and degenerate world triangles', () => {
    const scene = new Scene();
    const invisible = quadMesh();
    invisible.visible = false;
    const degenerate = triMesh([[0, 0], [1, 0], [0, 1]], [[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    scene.add(quadMesh(), invisible, degenerate);
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(100);
  });

  it('returns null without measurable mapped surface', () => {
    expect(computeAverageTexelDensity(new Scene(), 100, 100)).toBeNull();
    const uvless = new Scene();
    const mesh = triMesh();
    mesh.geometry.deleteAttribute('uv');
    uvless.add(mesh);
    expect(computeAverageTexelDensity(uvless, 100, 100)).toBeNull();
  });
});

describe('UV stretch data', () => {
  it('reports zero distortion when every face preserves relative area', () => {
    const scene = new Scene();
    scene.add(quadMesh());
    const data = computeUVStretchData(scene)!;
    expect(data.faces).toHaveLength(2);
    expect(data.faces.every((face) => face.distortion === 0)).toBe(true);
    expect(data.faces.every((face) => face.color.join(',') === uvStretchColor(0).join(','))).toBe(true);
  });

  it('reports symmetric compression and expansion relative to the model average', () => {
    const scene = new Scene();
    scene.add(
      triMesh([[0, 0], [1, 0], [0, 1]], [[0, 0, 0], [2, 0, 0], [0, 1, 0]]),
      triMesh([[0, 0], [2, 0], [0, 1]], [[0, 0, 0], [1, 0, 0], [0, 1, 0]]),
    );
    const data = computeUVStretchData(scene)!;
    expect(data.faces[0].distortion).toBeCloseTo(data.faces[1].distortion, 10);
    expect(data.faces[0].distortion).toBeGreaterThan(0);
  });

  it('is invariant to uniform world and UV scaling', () => {
    const original = new Scene();
    original.add(
      triMesh([[0, 0], [1, 0], [0, 1]]),
      triMesh([[0, 0], [2, 0], [0, 2]]),
    );
    const scaled = original.clone(true);
    scaled.scale.setScalar(4);
    scaled.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const uv = object.geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * 3);
    });
    expect(computeUVStretchData(scaled)!.faces.map((face) => face.distortion)).toEqual(
      computeUVStretchData(original)!.faces.map((face) => face.distortion),
    );
  });

  it('retains finite metrics while clamping extreme display colors', () => {
    expect(uvStretchColor(100)).toEqual(uvStretchColor(2));
    const scene = new Scene();
    scene.add(
      triMesh([[0, 0], [0.0001, 0], [0, 0.0001]]),
      triMesh([[0, 0], [1, 0], [0, 1]]),
    );
    expect(computeUVStretchData(scene)!.faces.every((face) => Number.isFinite(face.distortion))).toBe(true);
  });

  it('returns null for unavailable or degenerate mapped geometry', () => {
    const scene = new Scene();
    const uvless = triMesh();
    uvless.geometry.deleteAttribute('uv');
    const degenerateUv = triMesh([[0, 0], [1, 0], [2, 0]]);
    const degenerateWorld = triMesh([[0, 0], [1, 0], [0, 1]], [[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    scene.add(uvless, degenerateUv, degenerateWorld);
    expect(computeUVStretchData(scene)).toBeNull();
  });
});
