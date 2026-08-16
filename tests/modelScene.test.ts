import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, MeshPhongMaterial, MeshStandardMaterial, NearestFilter, Object3D, PerspectiveCamera, ShaderMaterial, SRGBColorSpace, Texture, Vector3 } from 'three';
import { applyTextureToModel, applyUVChannel, cloneModelScene, computeSmoothNormals, createPixelTexture, disposeModel, fitCameraToObject, geometryUVChannels, recomputeVertexNormals, stripSpecularFromModel, triangleNormal, uvChannelIndex } from '../src/lib/modelScene';

function mesh(channels: string[], materials = 1): Mesh {
  const geometry = new BufferGeometry();
  channels.forEach((channel, index) => geometry.setAttribute(channel, new Float32BufferAttribute([index, 0, 1, 1], 2)));
  const materialList = Array.from({ length: materials }, () => new MeshBasicMaterial());
  return new Mesh(geometry, materials === 1 ? materialList[0] : materialList);
}

describe('model scene processing', () => {
  it('enumerates UV channels numerically across every mesh', () => {
    const root = new Object3D();
    root.add(mesh(['uv2', 'uv']), mesh(['uv10', 'uv1']));
    expect(geometryUVChannels(root)).toEqual(['uv', 'uv1', 'uv2', 'uv10']);
    expect(uvChannelIndex('position')).toBe(Number.POSITIVE_INFINITY);
  });

  it('applies a selected UV globally with first-channel fallback and missing reporting', () => {
    const root = new Object3D();
    const exact = mesh(['uv', 'uv1']);
    const fallback = mesh(['uv2']);
    const missing = mesh([]);
    root.add(exact, fallback, missing);
    expect(applyUVChannel(root, 'uv1')).toEqual({ fallbackMeshes: 1, missingMeshes: 1 });
    expect(exact.geometry.getAttribute('uv')).toBe(exact.geometry.userData.ultiPixelizerUVs.uv1);
    expect(fallback.geometry.getAttribute('uv')).toBe(fallback.geometry.userData.ultiPixelizerUVs.uv2);
  });

  it('assigns a texture to every material slot', () => {
    const root = new Object3D();
    const single = mesh(['uv']);
    const multiple = mesh(['uv'], 3);
    const unsupported = new Mesh(new BufferGeometry(), new ShaderMaterial());
    root.add(single, multiple, unsupported);
    const texture = new Texture();
    expect(applyTextureToModel(root, texture)).toBe(5);
    expect((single.material as MeshBasicMaterial).map).toBe(texture);
    expect((single.material as MeshBasicMaterial).side).toBe(DoubleSide);
    expect((multiple.material as MeshBasicMaterial[]).every((material) => material.map === texture && material.side === DoubleSide)).toBe(true);
  });

  it('creates a nearest-neighbor sRGB canvas texture', () => {
    const texture = createPixelTexture({} as CanvasImageSource);
    expect(texture.colorSpace).toBe(SRGBColorSpace);
    expect(texture.minFilter).toBe(NearestFilter);
    expect(texture.magFilter).toBe(NearestFilter);
    expect(texture.generateMipmaps).toBe(false);
  });

  it('deep-clones mutable geometry, materials, and textures without changing material shape', () => {
    const root = new Object3D();
    const single = mesh(['uv']);
    const multiple = mesh(['uv'], 2);
    const sourceMaterials = multiple.material as MeshBasicMaterial[];
    const texture = new Texture();
    (single.material as MeshBasicMaterial).map = texture;
    sourceMaterials.forEach((material) => { material.map = texture; });
    root.add(single, multiple);
    const clone = cloneModelScene(root);
    const clonedSingle = clone.children[0] as Mesh;
    const clonedMultiple = clone.children[1] as Mesh;
    const clonedMaterials = clonedMultiple.material as MeshBasicMaterial[];
    expect(clonedSingle.geometry).not.toBe(single.geometry);
    expect(clonedSingle.material).not.toBe(single.material);
    expect(Array.isArray(clonedSingle.material)).toBe(false);
    expect(Array.isArray(clonedMultiple.material)).toBe(true);
    expect((clonedSingle.material as MeshBasicMaterial).map).not.toBe(texture);
    expect(clonedMaterials[0].map).not.toBe(texture);
    expect(clonedMaterials[0].map).toBe(clonedMaterials[1].map);
  });

  it('fits cameras for populated and empty objects', () => {
    const camera = new PerspectiveCamera();
    const root = new Object3D();
    const populated = mesh(['uv']);
    populated.geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, 1, 0], 3));
    root.add(populated);
    expect(fitCameraToObject(camera, root, 2).toArray()).toEqual([0, 0, 0]);
    expect(camera.aspect).toBe(2);
    expect(fitCameraToObject(camera, new Object3D(), 0).toArray()).toEqual([0, 0, 0]);
    expect(camera.aspect).toBe(1);
  });

  it('rebuilds vertex normals from winding, replacing stale normals', () => {
    const root = new Object3D();
    const geometry = new BufferGeometry();
    // Triangle winding +Z: (0,0,0) -> (1,0,0) -> (0,1,0)
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    // Deliberately wrong normals pointing -Z.
    geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, -1, 0, 0, -1, 0, 0, -1], 3));
    root.add(new Mesh(geometry, new MeshBasicMaterial()));
    expect(recomputeVertexNormals(root)).toBe(1);
    const normal = geometry.getAttribute('normal');
    for (let i = 0; i < 3; i += 1) {
      expect(normal.getZ(i)).toBeCloseTo(1);
      expect(normal.getX(i)).toBeCloseTo(0);
      expect(normal.getY(i)).toBeCloseTo(0);
    }
  });

  it('computes flat faceted normals by expanding indexed geometry per face', () => {
    const root = new Object3D();
    const geometry = new BufferGeometry();
    // Two triangles sharing the (0,0,0)–(0,1,0) edge: an XY face (+Z) and a YZ face (+X).
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0,  1, 0, 0,  0, 1, 0,  0, 0, 1,
    ], 3));
    // Stale exporter normals pointing -Y, to be discarded on recompute.
    geometry.setAttribute('normal', new Float32BufferAttribute([
      0, -1, 0,  0, -1, 0,  0, -1, 0,  0, -1, 0,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    root.add(mesh);
    expect(recomputeVertexNormals(root)).toBe(1);
    const flat = mesh.geometry;
    expect(flat).not.toBe(geometry);
    expect(flat.index).toBeNull();
    expect(flat.getAttribute('position').count).toBe(6);
    const normal = flat.getAttribute('normal');
    for (let i = 0; i < 3; i += 1) {
      expect(normal.getX(i)).toBeCloseTo(0);
      expect(normal.getY(i)).toBeCloseTo(0);
      expect(normal.getZ(i)).toBeCloseTo(1);
    }
    for (let i = 3; i < 6; i += 1) {
      expect(normal.getX(i)).toBeCloseTo(1);
      expect(normal.getY(i)).toBeCloseTo(0);
      expect(normal.getZ(i)).toBeCloseTo(0);
    }
  });

  it('computeSmoothNormals returns a new de-indexed geometry for indexed input and the same instance for non-indexed', () => {
    const indexed = new BufferGeometry();
    indexed.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0,  1, 0, 0,  0, 1, 0,  0, 0, 1,
    ], 3));
    indexed.setIndex([0, 1, 2, 0, 2, 3]);
    const flat = computeSmoothNormals(indexed, 0);
    expect(flat).not.toBe(indexed);
    expect(flat.index).toBeNull();
    expect(flat.getAttribute('normal').getZ(0)).toBeCloseTo(1);

    const soup = new BufferGeometry();
    soup.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    expect(computeSmoothNormals(soup)).toBe(soup);
    expect(soup.getAttribute('normal').getZ(0)).toBeCloseTo(1);
  });

  it('computeSmoothNormals smooths a 90° dihedral edge above the angle but keeps it hard below it', () => {
    const geometry = new BufferGeometry();
    // Two triangles sharing the (0,0,0)–(0,1,0) edge: an XY face (+Z) and a YZ face (+X), 90° apart.
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0,  1, 0, 0,  0, 1, 0,  0, 0, 1,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const hard = computeSmoothNormals(geometry, 30);
    expect(hard.getAttribute('normal').getX(0)).toBeCloseTo(0);
    expect(hard.getAttribute('normal').getZ(0)).toBeCloseTo(1);
    expect(hard.getAttribute('normal').getX(5)).toBeCloseTo(1);

    const smooth = computeSmoothNormals(geometry, 120);
    const normal = smooth.getAttribute('normal');
    expect(normal.getX(0)).toBeCloseTo(Math.SQRT1_2);
    expect(normal.getY(0)).toBeCloseTo(0);
    expect(normal.getZ(0)).toBeCloseTo(Math.SQRT1_2);
    expect(normal.getX(5)).toBeCloseTo(1);
  });

  it('triangleNormal returns (B−A)×(C−A) with magnitude 2×area', () => {
    const a = new Vector3(0, 0, 0);
    const b = new Vector3(1, 0, 0);
    const c = new Vector3(0, 1, 0);
    const target = new Vector3();
    expect(triangleNormal(a, b, c, target)).toBe(target);
    expect(target.x).toBeCloseTo(0);
    expect(target.y).toBeCloseTo(0);
    expect(target.z).toBeCloseTo(1);
  });

  it('stripSpecularFromModel removes Phong specular and PBR sheen from every material', () => {
    const phong = new MeshPhongMaterial({ specular: 0xffffff, shininess: 60 });
    const standard = new MeshStandardMaterial({ metalness: 1, roughness: 0 });
    const root = new Object3D();
    root.add(new Mesh(new BufferGeometry(), phong));
    root.add(new Mesh(new BufferGeometry(), standard));

    expect(stripSpecularFromModel(root)).toBe(2);
    expect(phong.specular.getHex()).toBe(0x000000);
    expect(phong.shininess).toBe(0);
    expect(standard.metalness).toBe(0);
    expect(standard.roughness).toBe(1);
  });

  it('disposes geometry, materials, and textures without closing shared image sources', () => {
    const root = new Object3D();
    const item = mesh(['uv']);
    const texture = new Texture();
    const close = vi.fn();
    const geometryDispose = vi.spyOn(item.geometry, 'dispose');
    const materialDispose = vi.spyOn(item.material as MeshBasicMaterial, 'dispose');
    const textureDispose = vi.spyOn(texture, 'dispose');
    texture.image = { close };
    (item.material as MeshBasicMaterial).map = texture;
    root.add(item);
    disposeModel(root);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});
