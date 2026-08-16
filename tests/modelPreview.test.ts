import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimationClip, BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Object3D, Texture } from 'three';
import { loadModel, ModelViewport, upAxisRotation } from '../src/lib/modelPreview';
import type { ModelFileBundle } from '../src/lib/modelFiles';
import { domStubs, flushRaf, installDomStubs, rafCount } from './helpers/domStubs';

const mocks = vi.hoisted(() => ({
  scene: null as Object3D | null,
  animations: [] as AnimationClip[],
  failWith: null as string | null,
  rendererCalls: [] as string[],
  mixers: [] as Array<{ actions: Array<{ play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
  controls: [] as Array<{
    listeners: Map<string, () => void>;
    target: { copy: ReturnType<typeof vi.fn> };
    update: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    fire: (type: string) => void;
  }>,
}));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = { className: '', remove: vi.fn(), style: {} };
    setPixelRatio = vi.fn((ratio: number) => mocks.rendererCalls.push(`ratio:${ratio}`));
    setClearColor = vi.fn(() => mocks.rendererCalls.push('clear'));
    setSize = vi.fn((width: number, height: number) => mocks.rendererCalls.push(`size:${width}x${height}`));
    render = vi.fn(() => mocks.rendererCalls.push('render'));
    dispose = vi.fn(() => mocks.rendererCalls.push('dispose'));
  }
  class FakeAnimationMixer {
    actions: Array<{ play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    constructor() {
      mocks.mixers.push(this as never);
    }
    clipAction(_clip: unknown) {
      const action = { play: vi.fn(), stop: vi.fn() };
      this.actions.push(action);
      return action;
    }
    update = vi.fn();
    dispose = vi.fn();
  }
  return { ...three, WebGLRenderer: FakeWebGLRenderer, AnimationMixer: FakeAnimationMixer };
});

vi.mock('three/addons/controls/OrbitControls.js', () => {
  class FakeOrbitControls {
    listeners = new Map<string, () => void>();
    target = {
      x: 0,
      y: 0,
      z: 0,
      copy: vi.fn((source: { x: number; y: number; z: number }) => {
        this.target.x = source.x;
        this.target.y = source.y;
        this.target.z = source.z;
        return this.target;
      }),
      clone: vi.fn(() => ({ x: this.target.x, y: this.target.y, z: this.target.z })),
    };
    enableDamping = true;
    constructor(public camera: unknown, public domElement: unknown) {
      mocks.controls.push(this as never);
    }
    addEventListener = vi.fn((type: string, callback: () => void) => {
      this.listeners.set(type, callback);
    });
    fire(type: string) {
      this.listeners.get(type)?.();
    }
    update = vi.fn();
    dispose = vi.fn();
  }
  return { OrbitControls: FakeOrbitControls };
});

vi.mock('three/addons/loaders/GLTFLoader.js', async () => {
  const { Object3D } = await import('three');
  return {
    GLTFLoader: class {
      constructor(public manager: { resolveURL?: (url: string) => string }) {}
      loadAsync = vi.fn(async () => {
        this.manager?.resolveURL?.('relative.bin');
        if (mocks.failWith) throw new Error(mocks.failWith);
        return { scene: mocks.scene ?? new Object3D(), animations: mocks.animations ?? [] };
      });
    },
  };
});

vi.mock('three/addons/loaders/FBXLoader.js', async () => {
  const { Object3D } = await import('three');
  return {
    FBXLoader: class {
      constructor(public manager: { resolveURL?: (url: string) => string }) {}
      loadAsync = vi.fn(async () => {
        this.manager?.resolveURL?.('relative.bin');
        if (mocks.failWith) throw new Error(mocks.failWith);
        const object = mocks.scene ?? new Object3D();
        (object as unknown as { animations?: unknown }).animations = mocks.animations ?? [];
        return object;
      });
    },
  };
});

vi.mock('three/addons/loaders/OBJLoader.js', async () => {
  const { Object3D } = await import('three');
  return {
    OBJLoader: class {
      constructor(public manager: { resolveURL?: (url: string) => string }) {}
      loadAsync = vi.fn(async () => {
        this.manager?.resolveURL?.('relative.bin');
        if (mocks.failWith) throw new Error(mocks.failWith);
        const object = mocks.scene ?? new Object3D();
        (object as unknown as { animations?: unknown }).animations = mocks.animations ?? [];
        return object;
      });
      setMaterials = vi.fn();
    },
  };
});

vi.mock('three/addons/loaders/MTLLoader.js', () => ({
  MTLLoader: class {
    loadAsync = vi.fn(async () => ({ preload: vi.fn() }));
  },
}));

function bundle(format: string): ModelFileBundle {
  return { format, primaryUrl: 'blob:1', manager: { resolveURL: vi.fn((url: string) => url) } } as unknown as ModelFileBundle;
}

/** A root with one triangle mesh carrying deliberately stale (flipped) normals. */
function meshScene(): Object3D {
  const root = new Object3D();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, -1, 0, 0, -1, 0, 0, -1], 3));
  root.add(new Mesh(geometry, new MeshBasicMaterial()));
  return root;
}

function host(): HTMLElement {
  return { append: vi.fn(), clientWidth: 800, clientHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLElement;
}

beforeEach(() => {
  mocks.scene = null;
  mocks.animations = [];
  mocks.failWith = null;
  mocks.rendererCalls.length = 0;
  mocks.mixers.length = 0;
  mocks.controls.length = 0;
  installDomStubs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('upAxisRotation', () => {
  it('tilts Blender exports onto their side and keeps Maya exports upright', () => {
    expect(upAxisRotation('blender')).toBe(-Math.PI / 2);
    expect(upAxisRotation('maya')).toBe(0);
  });
});

describe('loadModel', () => {
  it('loads GLB scenes and recomputes stale normals by default', async () => {
    mocks.scene = meshScene();
    const result = await loadModel(bundle('glb'), [], 'maya');
    expect(result.scene.children).toHaveLength(1);
    const normal = (result.scene.children[0] as Mesh).geometry.getAttribute('normal');
    expect(normal.getZ(0)).toBeCloseTo(1);
  });

  it('keeps source normals when asked', async () => {
    mocks.scene = meshScene();
    const result = await loadModel(bundle('glb'), [], 'maya', { useSourceNormals: true });
    const normal = (result.scene.children[0] as Mesh).geometry.getAttribute('normal');
    expect(normal.getZ(0)).toBeCloseTo(-1);
  });

  it('passes animations through from GLTF sources', async () => {
    mocks.scene = meshScene();
    mocks.animations = [new AnimationClip('idle', 1, [])];
    const result = await loadModel(bundle('gltf'), [], 'maya');
    expect(result.animations).toHaveLength(1);
  });

  it('applies the world-axis rotation to FBX loads', async () => {
    mocks.scene = meshScene();
    const blender = await loadModel(bundle('fbx'), [], 'blender');
    expect(blender.scene.rotation.x).toBe(-Math.PI / 2);
    const maya = await loadModel(bundle('fbx'), [], 'maya');
    expect(maya.scene.rotation.x).toBe(0);
  });

  it('loads OBJ with an MTL companion, resolving and revoking its blob URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:mtl');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    mocks.scene = meshScene();
    const mtl = { name: 'model.mtl', size: 10 } as File;

    const result = await loadModel(bundle('obj'), [mtl], 'maya');
    expect(result.scene.children).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledWith(mtl);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mtl');
  });

  it('loads OBJ without an MTL file', async () => {
    mocks.scene = meshScene();
    const result = await loadModel(bundle('obj'), [], 'maya');
    expect(result.scene.children).toHaveLength(1);
    expect(result.animations).toEqual([]);
  });

  it('surfaces loader failures', async () => {
    mocks.failWith = 'network down';
    await expect(loadModel(bundle('glb'), [], 'maya')).rejects.toThrow('network down');
  });
});

describe('ModelViewport', () => {
  it('wires the renderer, controls, lights, and resize observer', () => {
    const viewport = new ModelViewport(host());
    expect(mocks.rendererCalls).toContain('ratio:1');
    expect(mocks.rendererCalls).toContain('clear');
    expect(mocks.controls).toHaveLength(1);
    expect(domStubs.resizeObservers).toHaveLength(1);
    expect(rafCount()).toBe(1); // first animation frame scheduled
    viewport.dispose();
  });

  it('setModel plays the first animation and refits the camera', () => {
    const viewport = new ModelViewport(host());
    viewport.onCameraChange = vi.fn();
    viewport.setModel(meshScene(), [new AnimationClip('idle', 1, [])]);

    expect(mocks.mixers).toHaveLength(1);
    expect(mocks.mixers[0].actions[0].play).toHaveBeenCalled();
    expect(mocks.rendererCalls).toContain('size:800x600');
    expect(mocks.controls[0].target.copy).toHaveBeenCalled();
    expect(viewport.onCameraChange).toHaveBeenCalled();
    viewport.dispose();
  });

  it('captureCamera/restoreCamera preserve the orbit view across a model swap', () => {
    const viewport = new ModelViewport(host());
    const before = viewport.captureCamera();

    viewport.setModel(meshScene(), []); // refits the camera away from its default pose
    const during = viewport.captureCamera();
    expect(during.position.equals(before.position)).toBe(false);

    viewport.restoreCamera(before);
    const after = viewport.captureCamera();
    expect(after.position.equals(before.position)).toBe(true);
    expect(after.quaternion.equals(before.quaternion)).toBe(true);
    expect(after.target).toEqual(before.target);
    viewport.dispose();
  });

  it('skips the mixer when there are no animations', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    expect(mocks.mixers).toHaveLength(0);
    viewport.dispose();
  });

  it('respects prefers-reduced-motion by not playing the clip', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), [new AnimationClip('idle', 1, [])]);
    expect(mocks.mixers).toHaveLength(1);
    expect(mocks.mixers[0].actions).toHaveLength(0);
    viewport.dispose();
  });

  it('disposes the previous model when replacing it', () => {
    const viewport = new ModelViewport(host());
    const first = meshScene();
    const geometryDispose = vi.spyOn((first.children[0] as Mesh).geometry, 'dispose');
    viewport.setModel(first, []);
    viewport.setModel(meshScene(), []);
    expect(geometryDispose).toHaveBeenCalled();
    viewport.dispose();
  });

  it('reorients and refits on world-axis changes', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    viewport.setWorldAxis('blender');
    expect(viewport.getCameraForward()).toBeDefined();
    expect(mocks.controls[0].target.copy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // No model → early return, no crash.
    const empty = new ModelViewport(host());
    empty.setWorldAxis('maya');
    empty.dispose();
    viewport.dispose();
  });

  it('applyImage assigns the pixel texture to every material slot', () => {
    const viewport = new ModelViewport(host());
    expect(viewport.applyImage({} as CanvasImageSource)).toBe(0); // no model
    const model = meshScene();
    viewport.setModel(model, []);
    const textureDispose = vi.spyOn(Texture.prototype, 'dispose');
    expect(viewport.applyImage({} as CanvasImageSource)).toBe(1);
    const material = (model.children[0] as Mesh).material as MeshBasicMaterial;
    expect(material.map).not.toBeNull();
    // A second application disposes the previous texture.
    expect(viewport.applyImage({} as CanvasImageSource)).toBe(1);
    expect(textureDispose).toHaveBeenCalled();
    viewport.dispose();
  });

  it('applyUV and applyLOD fall back safely without a model', () => {
    const viewport = new ModelViewport(host());
    expect(viewport.applyUV('uv1')).toEqual({ fallbackMeshes: 0, missingMeshes: 0 });
    expect(viewport.applyLOD(1)).toBe(0);
    viewport.dispose();
  });

  it('applyUV and applyLOD act on the loaded model', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    expect(viewport.applyUV('uv')).toEqual({ fallbackMeshes: 0, missingMeshes: 0 });
    const named = new Object3D();
    const base = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    base.name = 'Cube';
    const lod1 = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    lod1.name = 'Cube_LOD1';
    named.add(base, lod1);
    viewport.setModel(named, []);
    expect(viewport.applyLOD(1)).toBe(1);
    expect(base.visible).toBe(false);
    expect(lod1.visible).toBe(true);
    viewport.dispose();
  });

  it('applySmoothAngle re-smooths normals and no-ops without a model', () => {
    const viewport = new ModelViewport(host());
    viewport.applySmoothAngle(30); // no model → no-op

    const model = meshScene(); // stale flipped (-Z) normals
    viewport.setModel(model, []);
    viewport.applySmoothAngle(30);
    const normal = (model.children[0] as Mesh).geometry.getAttribute('normal');
    expect(normal.getX(0)).toBeCloseTo(0);
    expect(normal.getY(0)).toBeCloseTo(0);
    expect(normal.getZ(0)).toBeCloseTo(1);
    viewport.dispose();
  });

  it('applyTessellation re-tessellates from the pristine base and no-ops without a model', () => {
    const viewport = new ModelViewport(host());
    viewport.applyTessellation(2, 30, 'uv'); // no model → no-op

    const model = meshScene(); // single triangle, 3 vertices
    viewport.setModel(model, []);
    viewport.applyTessellation(2, 30, 'uv');
    const geometry = (model.children[0] as Mesh).geometry;
    // 1 triangle × 2² subtriangles × 3 corners = 12 vertices.
    expect(geometry.getAttribute('position').count).toBe(12);
    const normal = geometry.getAttribute('normal');
    expect(normal).toBeDefined();
    expect(normal.getZ(0)).toBeCloseTo(1);
    viewport.dispose();
  });

  it('setNormalsView swaps materials and restores the originals', () => {
    const viewport = new ModelViewport(host());
    const model = meshScene();
    viewport.setModel(model, []);
    const mesh = model.children[0] as Mesh;
    const original = mesh.material;
    viewport.setNormalsView(true);
    expect((mesh.material as MeshBasicMaterial).type).toBe('MeshNormalMaterial');
    viewport.setNormalsView(false);
    expect(mesh.material).toBe(original);

    // Early returns: no model / already in the same state.
    const empty = new ModelViewport(host());
    empty.setNormalsView(true);
    empty.setNormalsView(false);
    empty.dispose();
    viewport.dispose();
  });

  it('setUVOverlap builds an overlay for mapped triangles and tolerates missing geometry', () => {
    const viewport = new ModelViewport(host());
    viewport.setUVOverlap(new Map()); // empty map → no-op
    viewport.setUVOverlap(new Map([[0, [0]]])); // no model → no-op
    viewport.setModel(meshScene(), []);
    viewport.setUVOverlap(new Map([[0, [0]]]));
    viewport.dispose();

    const bare = new Object3D();
    bare.add(new Mesh(new BufferGeometry(), new MeshBasicMaterial())); // no position attribute
    const viewport2 = new ModelViewport(host());
    viewport2.setModel(bare, []);
    viewport2.setUVOverlap(new Map([[0, [0]]]));
    viewport2.dispose();
  });

  it('exposes the camera forward direction for sun orientation', () => {
    // Lighting is baked only — the viewport carries no realtime sun/ambient
    // setters. The camera forward vector is what feeds the bake direction.
    const viewport = new ModelViewport(host());
    const forward = viewport.getCameraForward();
    expect(Math.hypot(forward.x, forward.y, forward.z)).toBeCloseTo(1);
    viewport.dispose();
  });

  it('notifies onCameraChange from orbit controls and refits', () => {
    const viewport = new ModelViewport(host());
    viewport.onCameraChange = vi.fn();
    mocks.controls[0].fire('change');
    expect(viewport.onCameraChange).toHaveBeenCalledOnce();
    viewport.dispose();
  });

  it('resizes through the resize observer', () => {
    const viewport = new ModelViewport(host());
    domStubs.resizeObservers[0].callback([] as never, null as never);
    expect(mocks.rendererCalls).toContain('size:800x600');
    viewport.dispose();
  });

  it('animates one frame per requestAnimationFrame', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), [new AnimationClip('idle', 1, [])]);
    const rendersBefore = mocks.rendererCalls.filter((call) => call === 'render').length;
    flushRaf(16);
    // The constructor renders once synchronously; each rAF tick adds exactly one.
    expect(mocks.rendererCalls.filter((call) => call === 'render')).toHaveLength(rendersBefore + 1);
    expect(mocks.mixers[0].update).toHaveBeenCalled();
    viewport.dispose();
  });

  it('dispose tears down the renderer, controls, observer, and frame loop', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    viewport.dispose();
    expect(mocks.rendererCalls).toContain('dispose');
    expect(mocks.controls[0].dispose).toHaveBeenCalled();
    expect(domStubs.resizeObservers[0].disconnect).toHaveBeenCalled();
    expect(rafCount()).toBe(0);
    const rendersBefore = mocks.rendererCalls.filter((call) => call === 'render').length;
    flushRaf(16);
    // dispose cancels the loop, so no new renders may appear after it.
    expect(mocks.rendererCalls.filter((call) => call === 'render')).toHaveLength(rendersBefore);
  });
});
