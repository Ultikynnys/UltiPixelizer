import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene } from 'three';
import { computeAverageTexelDensity } from '../src/lib/texelDensity';

/** Single-triangle mesh: world triangle (0,0,0)-(1,0,0)-(0,1,0) (area 0.5)
 * mapped onto UV triangle (0,0)-(1,0)-(0,1) (UV area 0.5). */
function triMesh(uv: [number, number][] = [[0, 0], [1, 0], [0, 1]], position: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('uv', new Float32BufferAttribute(uv.flat(), 2));
  geometry.setAttribute('position', new Float32BufferAttribute(position.flat(), 3));
  return new Mesh(geometry, new MeshBasicMaterial());
}

describe('average texel density', () => {
  it('computes texels per world unit from the UV face size vs world face size', () => {
    const scene = new Scene();
    scene.add(triMesh());
    // UV texel area = 0.5 × 100 × 100 = 5000 texels; world area = 0.5.
    // density = sqrt(5000 / 0.5) = sqrt(10000) = 100 texels per unit.
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(100);
  });

  it('scales density with the texture resolution', () => {
    const scene = new Scene();
    scene.add(triMesh());
    // Doubling the total texel count (200×100 vs 100×100) doubles the texel
    // area, so the linear density grows by sqrt(2).
    expect(computeAverageTexelDensity(scene, 200, 100)).toBeCloseTo(100 * Math.SQRT2, 10);
  });

  it('computes mixed density from total UV texel area and total world area', () => {
    const scene = new Scene();
    // Face 1: UV area 0.5 and world area 0.5.
    scene.add(triMesh());
    // Face 2: UV area 0.125 and world area 0.5.
    scene.add(triMesh(
      [[0, 0], [0.5, 0], [0, 0.5]],
      [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    ));
    // Total density = sqrt((0.625 × 100 × 100) / 1).
    expect(computeAverageTexelDensity(scene, 100, 100)).toBeCloseTo(Math.sqrt(6250), 10);
  });

  it('is unaffected by uneven mesh tessellation', () => {
    const coarse = new Scene();
    coarse.add(
      triMesh(),
      triMesh(
        [[0, 0], [0.5, 0], [0, 0.5]],
        [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      ),
    );

    const dense = new Scene();
    dense.add(
      // The first coarse face split into four triangles with interpolated UVs.
      triMesh(
        [
          [0, 0], [0.5, 0], [0, 0.5],
          [0.5, 0], [1, 0], [0.5, 0.5],
          [0, 0.5], [0.5, 0.5], [0, 1],
          [0.5, 0], [0.5, 0.5], [0, 0.5],
        ],
        [
          [0, 0, 0], [0.5, 0, 0], [0, 0.5, 0],
          [0.5, 0, 0], [1, 0, 0], [0.5, 0.5, 0],
          [0, 0.5, 0], [0.5, 0.5, 0], [0, 1, 0],
          [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0],
        ],
      ),
      triMesh(
        [[0, 0], [0.5, 0], [0, 0.5]],
        [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      ),
    );

    expect(computeAverageTexelDensity(dense, 100, 100)).toBeCloseTo(
      computeAverageTexelDensity(coarse, 100, 100)!,
      10,
    );
  });

  it('matches for indexed geometry', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setIndex([0, 1, 2]);
    const scene = new Scene();
    scene.add(new Mesh(geometry, new MeshBasicMaterial()));
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(100);
  });

  it('divides density by scale: world area grows with scale²', () => {
    const scene = new Scene();
    const mesh = triMesh();
    mesh.scale.set(2, 2, 2);
    scene.add(mesh);
    // World area ×4 → density /2.
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(50);
  });

  it('ignores UV-less and invisible meshes', () => {
    const scene = new Scene();
    const withoutUV = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    withoutUV.geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const invisible = triMesh();
    invisible.visible = false;
    scene.add(withoutUV, invisible, triMesh());
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(100);
  });

  it('skips degenerate world triangles and collapsed UVs', () => {
    const scene = new Scene();
    // Collinear world corners (zero area) and a collapsed UV shell (zero UV
    // area) must not contribute — only the unit face sets the result.
    const degenerateWorld = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    degenerateWorld.geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    degenerateWorld.geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 0, 0], 3));
    const collapsedUv = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    collapsedUv.geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 0, 0, 1, 1], 2));
    collapsedUv.geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    scene.add(degenerateWorld, collapsedUv, triMesh());
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(100);
  });

  it('returns null when no measurable face exists', () => {
    expect(computeAverageTexelDensity(new Scene(), 100, 100)).toBeNull();
    const uvless = new Scene();
    const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    mesh.geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    uvless.add(mesh);
    expect(computeAverageTexelDensity(uvless, 100, 100)).toBeNull();
  });
});
