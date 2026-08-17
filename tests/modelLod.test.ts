import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { applyLodLevel, isColliderName, lodIndexFor, prepareModelLods } from '../src/lib/modelLod';

function namedMesh(name: string): Mesh {
  const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

describe('model LOD and collider handling', () => {
  it('detects collider names by the UCX_ pattern', () => {
    expect(isColliderName('UCX_Cube_00')).toBe(true);
    expect(isColliderName('ucx_floor_01')).toBe(true);
    expect(isColliderName('Cube')).toBe(false);
    expect(isColliderName('Cube_LOD1')).toBe(false);
  });

  it('maps the basename to LOD 0 and parses LOD suffixes', () => {
    expect(lodIndexFor('Cube')).toBe(0);
    expect(lodIndexFor('Cube_LOD0')).toBe(0);
    expect(lodIndexFor('Cube_LOD1')).toBe(1);
    expect(lodIndexFor('Cube_LOD3')).toBe(3);
  });

  it('strips colliders and enumerates LOD levels in order', () => {
    const root = new Object3D();
    root.add(namedMesh('Cube'), namedMesh('Cube_LOD2'), namedMesh('Cube_LOD1'), namedMesh('UCX_Cube_00'));
    const prep = prepareModelLods(root);
    expect(prep.collidersRemoved).toBe(1);
    expect(prep.levels).toEqual([0, 1, 2]);
    expect(root.children.map((child) => child.name).sort()).toEqual(['Cube', 'Cube_LOD1', 'Cube_LOD2']);
  });

  it('removes a collider group including its nested meshes', () => {
    const root = new Object3D();
    const group = new Object3D();
    group.name = 'UCX_Cube_00';
    group.add(namedMesh('inner'));
    root.add(namedMesh('Cube'), group);
    const prep = prepareModelLods(root);
    expect(prep.collidersRemoved).toBe(1);
    expect(prep.levels).toEqual([0]);
    expect(root.children.length).toBe(1);
    expect(root.children[0].name).toBe('Cube');
  });

  it('disposes geometry of removed collider meshes', () => {
    const root = new Object3D();
    const collider = namedMesh('UCX_Cube_00');
    vi.spyOn(collider.geometry, 'dispose');
    root.add(collider, namedMesh('Cube'));
    prepareModelLods(root);
    expect(collider.geometry.dispose).toHaveBeenCalled();
  });

  it('toggles mesh visibility for the selected LOD level', () => {
    const root = new Object3D();
    const base = namedMesh('Cube');
    const lod1 = namedMesh('Cube_LOD1');
    const lod2 = namedMesh('Cube_LOD2');
    root.add(base, lod1, lod2);
    expect(applyLodLevel(root, 1)).toBe(1);
    expect(base.visible).toBe(false);
    expect(lod1.visible).toBe(true);
    expect(lod2.visible).toBe(false);
    applyLodLevel(root, 0);
    expect(base.visible).toBe(true);
    expect(lod1.visible).toBe(false);
  });
});
