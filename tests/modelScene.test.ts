import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, NearestFilter, Object3D, PerspectiveCamera, ShaderMaterial, SRGBColorSpace, Texture } from 'three';
import { applyTextureToModel, applyUVChannel, cloneModelScene, createPixelTexture, disposeModel, fitCameraToObject, geometryUVChannels, uvChannelIndex } from '../src/lib/modelScene';

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
