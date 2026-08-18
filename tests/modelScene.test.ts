import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial, NearestFilter, Object3D, PerspectiveCamera, ShaderMaterial, SRGBColorSpace, Texture, Vector3 } from 'three';
import { applyDisplacement, applyUVChannel, cloneModelScene, computeSmoothNormals, convertToLambertShading, createFallbackQuadScene, createPixelTexture, disposeModel, fitCameraToObject, geometryUVChannels, triangleNormal, uvChannelIndex } from '../src/lib/modelScene';

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
    const texture = new Texture({ width: 1, height: 1 });
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

  it('drops image-less placeholder textures from clones instead of cloning them', () => {
    // Loaders leave `new Texture()` placeholders when a model references a
    // texture that is missing or has an undefined filename. Cloning such a
    // texture bumps its version while the image stays null, so the renderer
    // warns "Texture marked for update but no image data found" on every
    // frame. The clone must drop the slot instead.
    const root = new Object3D();
    const item = mesh(['uv']);
    const placeholder = new Texture(); // image null — never decoded
    const valid = new Texture({ width: 1, height: 1 });
    const material = new MeshLambertMaterial();
    material.map = placeholder;
    material.normalMap = valid;
    item.material = material;
    root.add(item);

    const clone = cloneModelScene(root);
    const clonedMaterial = (clone.children[0] as Mesh).material as MeshLambertMaterial;
    expect(clonedMaterial.map).toBeNull();
    expect(clonedMaterial.normalMap).not.toBe(valid);
    expect(clonedMaterial.normalMap?.image).toEqual({ width: 1, height: 1 });
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

describe('createFallbackQuadScene', () => {
  it('is a flat quad facing up with full-UV coverage', () => {
    const quad = createFallbackQuadScene() as Mesh;
    expect(quad).toBeInstanceOf(Mesh);
    // The quad's normal points +Y after the rotateX(-π/2) — it faces up, so
    // the default sun (which travels downward) lights it.
    const normals = quad.geometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i += 1) {
      expect(normals.getX(i)).toBeCloseTo(0);
      expect(normals.getY(i)).toBeCloseTo(1);
      expect(normals.getZ(i)).toBeCloseTo(0);
    }
    // UVs span the whole 0..1 unit square, so a bake covers the full texture
    // rather than a corner island.
    const uv = quad.geometry.getAttribute('uv');
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < uv.count; i += 1) {
      minU = Math.min(minU, uv.getX(i));
      maxU = Math.max(maxU, uv.getX(i));
      minV = Math.min(minV, uv.getY(i));
      maxV = Math.max(maxV, uv.getY(i));
    }
    expect(minU).toBe(0);
    expect(maxU).toBe(1);
    expect(minV).toBe(0);
    expect(maxV).toBe(1);
  });

  it('subdivides the plane by the tessellation parameter', () => {
    const quad = createFallbackQuadScene(4, false) as Mesh;
    // PlaneGeometry(1, 1, 4, 4) → (4 + 1)² vertices.
    expect(quad.geometry.getAttribute('position').count).toBe(25);
    expect(quad.geometry.getAttribute('uv').count).toBe(25);
  });

  it('arranges nine tiles around the origin in grid mode', () => {
    const grid = createFallbackQuadScene(2, true);
    const meshes = grid.children.filter((child): child is Mesh => child instanceof Mesh);
    expect(meshes).toHaveLength(9);
    // The middle tile sits at the origin; every tile is a tessellated quad
    // facing up, so the bake layer can treat the middle tile as the single
    // quad it always bakes.
    const middle = meshes[4];
    expect(middle.position.x).toBe(0);
    expect(middle.position.z).toBe(0);
    expect(middle.geometry.getAttribute('position').count).toBe(9);
    expect(middle.geometry.getAttribute('normal').getY(0)).toBeCloseTo(1);
  });

  it('renders both sides so displaced cliffs never read as gaps', () => {
    const quad = createFallbackQuadScene() as Mesh;
    expect((quad.material as MeshBasicMaterial).side).toBe(DoubleSide);
  });

  /** World-space vertices of a tile (meshes sit at integer positions; the
   * geometry is local). */
  function worldVertices(tile: Mesh): Array<{ x: number; y: number; z: number }> {
    const position = tile.geometry.getAttribute('position');
    return Array.from({ length: position.count }, (_v, i) => ({
      x: position.getX(i) + tile.position.x,
      y: position.getY(i),
      z: position.getZ(i) + tile.position.z,
    }));
  }

  /** Max |y| difference between matching boundary vertices of horizontally
   * adjacent tiles — a seamless heightmap must keep the grid watertight. */
  function boundaryGap(grid: Object3D): number {
    const tiles = grid.children.filter((child): child is Mesh => child instanceof Mesh);
    const byPosition = new Map(tiles.map((tile) => [`${tile.position.x},${tile.position.z}`, worldVertices(tile)]));
    let maxGap = 0;
    for (const [key, vertices] of byPosition) {
      const [tx, tz] = key.split(',').map(Number);
      const neighbor = byPosition.get(`${tx + 1},${tz}`);
      if (!neighbor) continue;
      for (const a of vertices) {
        for (const b of neighbor) {
          if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9) {
            maxGap = Math.max(maxGap, Math.abs(a.y - b.y));
          }
        }
      }
    }
    return maxGap;
  }

  it('keeps adjacent displaced tiles flush with a seamless heightmap', () => {
    // sin(2πu) is periodic — u=0 and u=1 sample identically, so the map wraps
    // with zero discontinuity at every tile boundary.
    const seamless = (u: number, v: number): number => 0.5 + 0.25 * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI * 2);
    const grid = createFallbackQuadScene(16, true);
    applyDisplacement(grid, seamless, 0.15);
    expect(boundaryGap(grid)).toBeLessThan(1e-9);
  });

  it('flags the boundary step a non-seamless map leaves behind (sanity)', () => {
    // u=1 samples the last texel (white), u=0 the first (black) — a broken map
    // leaves a ~0.3-unit vertical step at every boundary.
    const step = (u: number): number => (u > 0.999 ? 1 : u < 0.001 ? 0 : 0.5);
    const grid = createFallbackQuadScene(16, true);
    applyDisplacement(grid, step, 0.15);
    expect(boundaryGap(grid)).toBeGreaterThan(0.2);
  });
});

describe('applyDisplacement', () => {
  const snapshot = (attribute: { count: number; getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number }): number[] => {
    const values: number[] = [];
    for (let i = 0; i < attribute.count; i += 1) values.push(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
    return values;
  };

  it('pushes vertices along their normals by (height − 0.5) × 2 × strength', () => {
    const quad = createFallbackQuadScene(1, false) as Mesh;
    const position = quad.geometry.getAttribute('position');
    const baselineX = Array.from({ length: position.count }, (_v, i) => position.getX(i));
    applyDisplacement(quad, () => 0.75, 0.2);
    // offset = (0.75 − 0.5) × 2 × 0.2 = 0.1 along the +Y normal.
    for (let i = 0; i < position.count; i += 1) {
      expect(position.getY(i)).toBeCloseTo(0.1, 6);
      expect(position.getX(i)).toBeCloseTo(baselineX[i], 6);
    }
  });

  it('leaves mid-gray heightmaps and zero strength untouched', () => {
    const quad = createFallbackQuadScene(1, false) as Mesh;
    const position = quad.geometry.getAttribute('position');
    const baseline = snapshot(position);
    applyDisplacement(quad, () => 0.5, 0.2);
    expect(snapshot(position)).toEqual(baseline);
  });

  it('restores the pristine geometry when the sampler is cleared', () => {
    const quad = createFallbackQuadScene(1, false) as Mesh;
    const position = quad.geometry.getAttribute('position');
    const normal = quad.geometry.getAttribute('normal');
    const baselinePositions = snapshot(position);
    const baselineNormals = snapshot(normal);
    applyDisplacement(quad, () => 0.9, 0.5);
    applyDisplacement(quad, null, 0.5);
    snapshot(position).forEach((value, i) => expect(value).toBeCloseTo(baselinePositions[i], 6));
    snapshot(normal).forEach((value, i) => expect(value).toBeCloseTo(baselineNormals[i], 6));
  });

  it('re-applies from the pristine base so repeated calls are idempotent', () => {
    const quad = createFallbackQuadScene(1, false) as Mesh;
    const position = quad.geometry.getAttribute('position');
    applyDisplacement(quad, () => 0.8, 0.4);
    const first = snapshot(position);
    applyDisplacement(quad, () => 0.8, 0.4);
    expect(snapshot(position)).toEqual(first);
  });

  it('recomputes normals after displacement so bumps shade', () => {
    const quad = createFallbackQuadScene(4, false) as Mesh;
    // Height ramps across the quad — the recomputed normals tilt off +Y.
    applyDisplacement(quad, (u) => u, 0.5);
    const normal = quad.geometry.getAttribute('normal');
    let maxTilt = 0;
    for (let i = 0; i < normal.count; i += 1) {
      maxTilt = Math.max(maxTilt, Math.abs(normal.getX(i)));
    }
    expect(maxTilt).toBeGreaterThan(0.1);
  });
});


