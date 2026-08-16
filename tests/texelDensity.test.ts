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

  it('weights per-face densities by their UV footprint area', () => {
    const scene = new Scene();
    // Face 1: unit UV shell (area 0.5) on a unit world triangle → 100 texels/unit.
    scene.add(triMesh());
    // Face 2: same unit world triangle (area 0.5), but a half-scale UV shell
    // (0,0)-(0.5,0)-(0,0.5), area 0.125 → 0.125 × 100×100 = 1250 texels →
    // sqrt(1250 / 0.5) = 50 texels/unit. It owns 1/5 of the total UV area.
    scene.add(triMesh(
      [[0, 0], [0.5, 0], [0, 0.5]],
      [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    ));
    // UV-area-weighted: (100 × 0.5 + 50 × 0.125) / 0.625 = 90. A plain mean
    // would report 75, letting the small face pull the average toward itself.
    expect(computeAverageTexelDensity(scene, 100, 100)).toBe(90);
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
