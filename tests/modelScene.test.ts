import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial, NearestFilter, Object3D, PerspectiveCamera, ShaderMaterial, SRGBColorSpace, Texture, Vector3 } from 'three';
import { applyUVChannel, cloneModelScene, computeSmoothNormals, convertToLambertShading, createPixelTexture, disposeModel, fitCameraToObject, geometryUVChannels, triangleNormal, uvChannelIndex } from '../src/lib/modelScene';

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

  it('smooths non-indexed geometry by welding shared positions', () => {
    // Two coplanar triangles sharing an edge, stored as non-indexed soup — every
    // face corner is a distinct vertex, exactly as FBX/OBJ exports produce.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0,  1, 0, 0,  0, 1, 0,
      1, 0, 0,  1, 1, 0,  0, 1, 0,
    ], 3));
    const result = computeSmoothNormals(geometry, 30);
    expect(result).toBe(geometry);
    const normal = result.getAttribute('normal');
    for (let i = 0; i < 6; i += 1) {
      expect(normal.getX(i)).toBeCloseTo(0);
      expect(normal.getY(i)).toBeCloseTo(0);
      expect(normal.getZ(i)).toBeCloseTo(1);
    }
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

  it('convertToLambertShading replaces Phong and Standard materials with matte Lambert, preserving diffuse channels', () => {
    const map = new Texture();
    const normalMap = new Texture();
    const phong = new MeshPhongMaterial({
      color: 0x336699, map, normalMap, emissive: 0x112233,
      specular: 0xffffff, shininess: 60, transparent: true, opacity: 0.5,
    });
    const standard = new MeshStandardMaterial({ color: 0x884422, metalness: 1, roughness: 0 });
    const root = new Object3D();
    root.add(new Mesh(new BufferGeometry(), phong), new Mesh(new BufferGeometry(), standard));

    expect(convertToLambertShading(root)).toBe(2);
    const convertedPhong = (root.children[0] as Mesh).material as MeshLambertMaterial;
    const convertedStandard = (root.children[1] as Mesh).material as MeshLambertMaterial;
    expect(convertedPhong.type).toBe('MeshLambertMaterial');
    expect(convertedStandard.type).toBe('MeshLambertMaterial');
    expect(convertedPhong.map).toBe(map);
    expect(convertedPhong.normalMap).toBe(normalMap);
    expect(convertedPhong.color.getHex()).toBe(0x336699);
    expect(convertedPhong.emissive.getHex()).toBe(0x112233);
    expect(convertedPhong.transparent).toBe(true);
    expect(convertedPhong.opacity).toBe(0.5);
    expect('specular' in convertedPhong).toBe(false);
    expect('shininess' in convertedPhong).toBe(false);
    expect('metalness' in convertedStandard).toBe(false);
    expect('roughness' in convertedStandard).toBe(false);
  });

  it('convertToLambertShading leaves Lambert and Basic materials untouched', () => {
    const lambert = new MeshLambertMaterial({ color: 0x123456 });
    const basic = new MeshBasicMaterial({ color: 0x654321 });
    const custom = new ShaderMaterial();
    const root = new Object3D();
    root.add(new Mesh(new BufferGeometry(), lambert), new Mesh(new BufferGeometry(), basic), new Mesh(new BufferGeometry(), custom));
    expect(convertToLambertShading(root)).toBe(0);
    expect((root.children[0] as Mesh).material).toBe(lambert);
    expect((root.children[1] as Mesh).material).toBe(basic);
    expect((root.children[2] as Mesh).material).toBe(custom);
  });

  it('convertToLambertShading converts multi-material meshes in place', () => {
    const mesh = new Mesh(new BufferGeometry(), [new MeshPhongMaterial(), new MeshStandardMaterial()]);
    const root = new Object3D();
    root.add(mesh);
    expect(convertToLambertShading(root)).toBe(2);
    expect(Array.isArray(mesh.material)).toBe(true);
    const converted = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    converted.forEach((material) => {
      expect(material.type).toBe('MeshLambertMaterial');
    });
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


