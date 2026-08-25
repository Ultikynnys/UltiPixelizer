import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimationClip, BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, MOUSE, Object3D, Scene, ShaderMaterial, Texture } from 'three';
import { FLOOR_GRID_DIVISION, loadModel, ModelViewport, upAxisRotation } from '../src/lib/modelPreview';
import { renderModelThumbnail } from '../src/lib/modelScene';
import type { ModelFileBundle } from '../src/lib/modelFiles';
import { domStubs, FakeCanvas, flushRaf, installDomStubs, rafCount } from './helpers/domStubs';

const mocks = vi.hoisted(() => ({
  scene: null as Object3D | null,
  animations: [] as AnimationClip[],
  failWith: null as string | null,
  deferTextureItem: false,
  emitZupWarning: false,
  releaseTextureItem: null as (() => void) | null,
  rendererCalls: [] as string[],
  renderer: null as unknown,
  mixers: [] as Array<{ actions: Array<{ play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
  controls: [] as Array<{
    listeners: Map<string, () => void>;
    target: { copy: ReturnType<typeof vi.fn> };
    update: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    fire: (type: string) => void;
    mouseButtons: Record<string, number>;
  }>,
}));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = { className: '', remove: vi.fn(), style: {} };
    constructor() {
      mocks.renderer = this;
    }
    setPixelRatio = vi.fn((ratio: number) => mocks.rendererCalls.push(`ratio:${ratio}`));
    getPixelRatio = vi.fn(() => 1);
    setClearColor = vi.fn(() => mocks.rendererCalls.push('clear'));
    setSize = vi.fn((width: number, height: number) => mocks.rendererCalls.push(`size:${width}x${height}`));
    setScissorTest = vi.fn();
    setScissor = vi.fn();
    setViewport = vi.fn();
    render = vi.fn(() => mocks.rendererCalls.push('render'));
    getContext = vi.fn(() => ({
      finish: vi.fn(() => mocks.rendererCalls.push('finish')),
      readPixels: vi.fn(),
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
    }));
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
    mouseButtons: Record<string, number> = {};
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
        if (mocks.emitZupWarning) {
          console.warn('THREE.FBXLoader: You are loading an asset with a Z-UP coordinate system. The loader just rotates the asset to transform it into Y-UP. The vertex data are not converted.');
          console.warn('an unrelated warning');
        }
        if (mocks.deferTextureItem) {
          const manager = this.manager as { itemStart?: (url: string) => void; itemEnd?: (url: string) => void };
          manager.itemStart?.('embedded.png');
          mocks.releaseTextureItem = () => manager.itemEnd?.('embedded.png');
        }
        const object = mocks.scene ?? new Object3D();
        (object as unknown as { animations?: unknown }).animations = mocks.animations ?? [];
        return object;
      });
    },
  };
});

vi.mock('three/addons/loaders/USDLoader.js', async () => {
  const { Object3D } = await import('three');
  return {
    USDLoader: class {
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
  mocks.deferTextureItem = false;
  mocks.emitZupWarning = false;
  mocks.releaseTextureItem = null;
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

describe('renderModelThumbnail', () => {
  it('renders a mesh preview into a small square canvas', () => {
    const callsBefore = mocks.rendererCalls.length;
    const thumbnail = renderModelThumbnail(meshScene(), 40);
    expect((thumbnail as unknown as FakeCanvas).width).toBe(40);
    expect((thumbnail as unknown as FakeCanvas).height).toBe(40);
    // The lazy shared renderer draws the model before the pixels are copied.
    expect(mocks.rendererCalls.slice(callsBefore)).toContain('render');
    // The readback waits for the GPU (finish) before copying the framebuffer.
    expect(mocks.rendererCalls.slice(callsBefore)).toContain('finish');
  });
});

describe('loadModel', () => {
  it('loads GLB scenes keeping the embedded source normals', async () => {
    mocks.scene = meshScene();
    const result = await loadModel(bundle('glb'), [], 'maya');
    expect(result.scene.children).toHaveLength(1);
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

  it('suppresses the FBXLoader Z-up notice while passing other warnings through', async () => {
    mocks.scene = meshScene();
    mocks.emitZupWarning = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadModel(bundle('fbx'), [], 'maya');
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('Z-UP coordinate system'))).toBe(false);
    expect(messages).toContain('an unrelated warning');
  });

  it('waits for FBX texture loads to finish before resolving', async () => {
    mocks.scene = meshScene();
    mocks.deferTextureItem = true;
    let resolved = false;
    const pending = loadModel(bundle('fbx'), [], 'maya').then(() => {
      resolved = true;
    });
    // The FBX mock starts a manager item for an embedded texture; loadModel
    // must stay pending until that item ends, so texture extraction sees a
    // decoded image rather than a placeholder.
    await flushRaf();
    expect(resolved).toBe(false);
    mocks.releaseTextureItem?.();
    await pending;
    expect(resolved).toBe(true);
  });

  it('loads USDZ without rotation and passes animations through', async () => {
    mocks.scene = meshScene();
    mocks.animations = [new AnimationClip('idle', 1, [])];
    const result = await loadModel(bundle('usdz'), [], 'maya');
    expect(result.scene.children).toHaveLength(1);
    expect(result.scene.rotation.x).toBe(0);
    expect(result.animations).toHaveLength(1);
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

  it('strips Ctrl/Cmd/Shift from pointerdown so the drag action always follows the navigation toggle', () => {
    const hostElement = host();
    const viewport = new ModelViewport(hostElement);
    const install = vi.mocked(hostElement.addEventListener).mock.calls.find((call) => call[0] === 'pointerdown');
    expect(install).toBeDefined();
    expect(install?.[2]).toBe(true); // capture on the host; runs before the canvas listener
    const handler = install?.[1] as unknown as (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
    // three would map ctrl+drag to the other action; the strip must zero the
    // flags so the navigation toggle alone picks orbit vs pan.
    const dragged = { ctrlKey: true, metaKey: true, shiftKey: false };
    handler(dragged);
    expect(dragged.ctrlKey).toBe(false);
    expect(dragged.metaKey).toBe(false);
    expect(dragged.shiftKey).toBe(false);
    // A plain drag passes through untouched.
    const clean = { ctrlKey: false, metaKey: false, shiftKey: false };
    handler(clean);
    expect(clean).toEqual({ ctrlKey: false, metaKey: false, shiftKey: false });
    viewport.dispose();
  });

  it('removes the pointerdown stripper on dispose', () => {
    const hostElement = host();
    const viewport = new ModelViewport(hostElement);
    viewport.dispose();
    expect(vi.mocked(hostElement.removeEventListener).mock.calls.some((call) => call[0] === 'pointerdown' && call[2] === true)).toBe(true);
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

  it('setNavigationDragMode swaps the primary drag button between orbit and pan', () => {
    const viewport = new ModelViewport(host());
    // Default matches the app's navigation toggle default: orbit-left, pan-right.
    expect(mocks.controls[0].mouseButtons.LEFT).toBe(MOUSE.ROTATE);
    expect(mocks.controls[0].mouseButtons.RIGHT).toBe(MOUSE.PAN);
    viewport.setNavigationDragMode(true);
    expect(mocks.controls[0].mouseButtons.LEFT).toBe(MOUSE.PAN);
    expect(mocks.controls[0].mouseButtons.RIGHT).toBe(MOUSE.ROTATE);
    viewport.setNavigationDragMode(false);
    expect(mocks.controls[0].mouseButtons.LEFT).toBe(MOUSE.ROTATE);
    expect(mocks.controls[0].mouseButtons.RIGHT).toBe(MOUSE.PAN);
    viewport.dispose();
  });

  it('shows a floor grid with fixed 10 cm divisions at the model floor', () => {
    const viewport = new ModelViewport(host());
    const grid = () => (viewport as unknown as { floorGrid: Object3D & { visible: boolean; geometry: BufferGeometry } }).floorGrid;
    expect(FLOOR_GRID_DIVISION).toBe(0.1);
    expect(grid().visible).toBe(false);

    const model = meshScene();
    model.position.set(2, 3, 4);
    viewport.setModel(model, []);
    viewport.setFloorGrid(true);

    expect(grid().visible).toBe(true);
    expect(grid().position.y).toBeCloseTo(3);
    expect(grid().position.x).toBeCloseTo(2.5);
    expect(grid().position.z).toBeCloseTo(4);
    const positions = grid().geometry.getAttribute('position');
    const firstZ = positions.getZ(0);
    const nextZ = positions.getZ(4);
    expect(Math.abs(nextZ - firstZ)).toBeCloseTo(FLOOR_GRID_DIVISION);

    viewport.setFloorGrid(false);
    expect(grid().visible).toBe(false);
    const geometryDispose = vi.spyOn(grid().geometry, 'dispose');
    const material = (grid() as unknown as { material: MeshBasicMaterial }).material;
    const materialDispose = vi.spyOn(material, 'dispose');
    viewport.dispose();
    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
  });

  it('restoreCameraView re-aims the camera from a saved position and orbit target', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []); // refits the camera away from the default pose
    viewport.onCameraChange = vi.fn();
    viewport.restoreCameraView({ x: 3, y: 4, z: 5 }, { x: 0, y: 0, z: 0 });

    const state = viewport.captureCamera();
    expect(state.position.x).toBeCloseTo(3);
    expect(state.position.y).toBeCloseTo(4);
    expect(state.position.z).toBeCloseTo(5);
    expect(state.target).toEqual({ x: 0, y: 0, z: 0 });
    // The camera looks from the saved position toward the saved target.
    const magnitude = Math.hypot(3, 4, 5);
    const forward = viewport.getCameraForward();
    expect(forward.x).toBeCloseTo(-3 / magnitude);
    expect(forward.y).toBeCloseTo(-4 / magnitude);
    expect(forward.z).toBeCloseTo(-5 / magnitude);
    expect(mocks.controls[0].update).toHaveBeenCalled();
    expect(viewport.onCameraChange).toHaveBeenCalled();
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

  it('applyDisplacement displaces along the original normals and restores', () => {
    const viewport = new ModelViewport(host());
    const model = meshScene();
    viewport.setModel(model, []);
    const position = (model.children[0] as Mesh).geometry.getAttribute('position');
    viewport.applyDisplacement(() => 0.75, 0.2);
    // offset = (0.75 − 0.5) × 2 × 0.2 = 0.1 along the model's normal (0, 0, −1).
    expect(position.getZ(0)).toBeCloseTo(-0.1, 6);
    expect(position.getX(0)).toBeCloseTo(0, 6);
    // Clearing restores the pristine vertices.
    viewport.applyDisplacement(null, 0.2);
    expect(position.getZ(0)).toBeCloseTo(0, 6);
    viewport.dispose();
  });

  it('applyDisplacement is a no-op without a model', () => {
    const viewport = new ModelViewport(host());
    expect(() => viewport.applyDisplacement(() => 0.5, 0.2)).not.toThrow();
    viewport.dispose();
  });

  it('setNormalsView swaps materials and restores the originals', () => {
    const viewport = new ModelViewport(host());
    const model = meshScene();
    viewport.setModel(model, []);
    const mesh = model.children[0] as Mesh;
    const original = mesh.material;
    viewport.setNormalsView(true);
    // The normals view showcases the actual normal map, not the mesh's vertex
    // normals — the swap target is the normal-map sampling shader.
    expect((mesh.material as ShaderMaterial).type).toBe('ShaderMaterial');
    expect((mesh.material as ShaderMaterial).uniforms.uHasNormalMap.value).toBe(0);
    viewport.setNormalsView(false);
    expect(mesh.material).toBe(original);

    // Early returns: no model / already in the same state.
    const empty = new ModelViewport(host());
    empty.setNormalsView(true);
    empty.setNormalsView(false);
    empty.dispose();
    viewport.dispose();
  });

  it('setNormalMap feeds the normals-view shader and clears it', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    viewport.setNormalsView(true);
    const uniforms = (viewport as unknown as { normalMapMaterial: ShaderMaterial }).normalMapMaterial.uniforms;

    viewport.setNormalMap({} as CanvasImageSource, 0.5, true);
    expect(uniforms.uHasNormalMap.value).toBe(1);
    expect(uniforms.uStrength.value).toBe(0.5);
    expect(uniforms.uFlipY.value).toBe(1);
    expect(uniforms.uNormalMap.value).not.toBeNull();

    viewport.setNormalMap(null);
    expect(uniforms.uHasNormalMap.value).toBe(0);
    expect(uniforms.uNormalMap.value).toBeNull();
    viewport.dispose();
  });

  it('setNormalStrength moves the showcase uniform without touching the texture', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    viewport.setNormalsView(true);
    viewport.setNormalMap({} as CanvasImageSource, 1, false);
    const uniforms = (viewport as unknown as { normalMapMaterial: ShaderMaterial }).normalMapMaterial.uniforms;
    const texture = uniforms.uNormalMap.value;

    viewport.setNormalStrength(0.35);

    expect(uniforms.uStrength.value).toBe(0.35);
    // A full setNormalMap would have rebuilt the texture; the live strength
    // update must leave it in place.
    expect(uniforms.uNormalMap.value).toBe(texture);
    viewport.dispose();
  });

  it('setUVOverlap builds an overlay for mapped triangles and tolerates missing geometry', () => {
    const viewport = new ModelViewport(host());
    const overlapMeshes = () =>
      (viewport as unknown as { scene: Scene }).scene.children.filter((child) => child.renderOrder === 1);

    viewport.setUVOverlap(new Map()); // empty map → no-op
    expect(overlapMeshes()).toHaveLength(0);
    viewport.setUVOverlap(new Map([[0, [0]]])); // no model → no-op
    expect(overlapMeshes()).toHaveLength(0);

    viewport.setModel(meshScene(), []);
    viewport.setUVOverlap(new Map([[0, [0]]]));
    // The mapped triangle's vertices were collected into the overlay mesh.
    expect(overlapMeshes()).toHaveLength(1);
    viewport.dispose();

    const bare = new Object3D();
    bare.add(new Mesh(new BufferGeometry(), new MeshBasicMaterial())); // no position attribute
    const viewport2 = new ModelViewport(host());
    viewport2.setModel(bare, []);
    viewport2.setUVOverlap(new Map([[0, [0]]]));
    // No positions to collect → no overlay mesh is added.
    expect(
      (viewport2 as unknown as { scene: Scene }).scene.children.filter((child) => child.renderOrder === 1),
    ).toHaveLength(0);
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

  it('setCameraForward reorients the camera along a direction and notifies', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    viewport.onCameraChange = vi.fn();
    viewport.setCameraForward({ x: 0, y: 0, z: -1 });
    const forward = viewport.getCameraForward();
    expect(forward.x).toBeCloseTo(0);
    expect(forward.y).toBeCloseTo(0);
    expect(forward.z).toBeCloseTo(-1);
    expect(viewport.onCameraChange).toHaveBeenCalled();
    expect(mocks.controls[0].update).toHaveBeenCalled();
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
    // The constructor renders synchronously; each rAF tick adds exactly two —
    // the model scene plus the corner sun-axis gizmo.
    expect(mocks.rendererCalls.filter((call) => call === 'render')).toHaveLength(rendersBefore + 2);
    expect(mocks.mixers[0].update).toHaveBeenCalled();
    viewport.dispose();
  });

  it('keeps the gizmo box inside the buffer on HiDPI screens (pixel ratio 2)', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    const renderer = mocks.renderer as unknown as {
      getPixelRatio: ReturnType<typeof vi.fn>;
      setViewport: ReturnType<typeof vi.fn>;
      setScissor: ReturnType<typeof vi.fn>;
    };
    renderer.getPixelRatio.mockReturnValue(2);
    flushRaf(16);
    // three multiplies viewport/scissor by pixel ratio internally, so the gizmo
    // must pass logical pixels — the old device-pixel math pushed the box off
    // the buffer entirely at ratio 2.
    const scissorCalls = renderer.setScissor.mock.calls;
    const [sx, sy, sw, sh] = scissorCalls[scissorCalls.length - 1] as [number, number, number, number];
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sx + sw).toBeLessThanOrEqual(800);
    expect(sy + sh).toBeLessThanOrEqual(600);
    // The full-frame viewport reset is also logical, so the next model render
    // fills the buffer exactly.
    const viewportCalls = renderer.setViewport.mock.calls;
    expect(viewportCalls[viewportCalls.length - 1]).toEqual([0, 0, 800, 600]);
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

  it('applies images through the stashed originals while the normals view is active', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    viewport.setNormalsView(true);
    // texturableMaterials resolves the stashed original material, not the
    // live normals-as-color material.
    expect(viewport.applyImage({} as CanvasImageSource)).toBe(1);
    viewport.dispose();
  });

  it('handles multi-material meshes while the normals view is active', () => {
    const viewport = new ModelViewport(host());
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    const model = new Object3D();
    model.add(new Mesh(geometry, [new MeshBasicMaterial(), new MeshBasicMaterial()]));
    viewport.setModel(model, []);
    viewport.setNormalsView(true);
    // The stashed original is a material array — applyImage targets each entry.
    expect(viewport.applyImage({} as CanvasImageSource)).toBe(2);
    viewport.dispose();
  });

  it('animates the UV-overlap overlay time uniform', () => {
    const viewport = new ModelViewport(host());
    viewport.setModel(meshScene(), []);
    viewport.setUVOverlap(new Map([[0, [0]]]));
    const overlay = (viewport as unknown as { overlapOverlay: Mesh | null }).overlapOverlay;
    expect(overlay).not.toBeNull();
    const uniforms = (overlay!.material as ShaderMaterial).uniforms;
    const before = uniforms.uTime.value;
    flushRaf(16); // animate runs with the overlay present
    expect(uniforms.uTime.value).not.toBe(before);
    expect(uniforms.uTime.value).toBeCloseTo(16 / 1000);
    viewport.dispose();
  });
});
