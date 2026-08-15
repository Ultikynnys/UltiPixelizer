import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene } from 'three';
import { collectUVTriangles, computeUVOverlap } from '../src/lib/uvOverlap';

function triMesh(uv: [number, number][], position: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('uv', new Float32BufferAttribute(uv.flat(), 2));
  geometry.setAttribute('position', new Float32BufferAttribute(position.flat(), 3));
  return new Mesh(geometry, new MeshBasicMaterial());
}

describe('UV overlap detection', () => {
  it('detects overlapping UVs across two meshes', () => {
    const scene = new Scene();
    scene.add(triMesh([[0, 0], [1, 0], [0, 1]]), triMesh([[0, 0], [1, 0], [0, 1]]));
    const result = computeUVOverlap(scene, 8, 8);
    expect(Math.max(...result.counts)).toBeGreaterThanOrEqual(2);
    expect(result.overlapping.get(0)).toEqual([0]);
    expect(result.overlapping.get(1)).toEqual([0]);
  });

  it('flags every overlapping triangle within a single indexed mesh', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 1, 2]);
    const scene = new Scene();
    scene.add(new Mesh(geometry, new MeshBasicMaterial()));
    const result = computeUVOverlap(scene, 8, 8);
    expect(result.overlapping.get(0)).toEqual([0, 1]);
  });

  it('leaves disjoint UVs unflagged', () => {
    const scene = new Scene();
    scene.add(
      triMesh([[0, 0], [0.4, 0], [0, 0.4]]),
      triMesh([[0.6, 0.6], [1, 0.6], [0.6, 1]]),
    );
    const result = computeUVOverlap(scene, 8, 8);
    expect(Math.max(...result.counts)).toBe(1);
    expect(result.overlapping.size).toBe(0);
  });

  it('keeps mesh indices stable across invisible and UV-less meshes', () => {
    const scene = new Scene();
    const withUV = triMesh([[0, 0], [1, 0], [0, 1]]);
    const withoutUV = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    withoutUV.geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const invisible = triMesh([[0, 0], [1, 0], [0, 1]]);
    invisible.visible = false;
    const lastWithUV = triMesh([[0, 0], [1, 0], [0, 1]]);
    scene.add(withUV, withoutUV, invisible, lastWithUV);
    expect(collectUVTriangles(scene).map((triangle) => triangle.meshIndex)).toEqual([0, 3]);
  });
});
