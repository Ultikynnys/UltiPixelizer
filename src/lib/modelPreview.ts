import {
  AnimationClip,
  AnimationMixer,
  Clock,
  DirectionalLight,
  HemisphereLight,
  LoadingManager,
  Object3D,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { ModelFileBundle } from './modelFiles';
import { applyTextureToModel, applyUVChannel, createPixelTexture, disposeModel, fitCameraToObject } from './modelScene';

export type LoadedModel = { scene: Object3D; animations: AnimationClip[] };

function configureManager(bundle: ModelFileBundle): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => bundle.manager.resolveURL(url));
  return manager;
}

export async function loadModel(bundle: ModelFileBundle, files: File[]): Promise<LoadedModel> {
  const manager = configureManager(bundle);
  if (bundle.format === 'glb' || bundle.format === 'gltf') {
    const result = await new GLTFLoader(manager).loadAsync(bundle.primaryUrl);
    return { scene: result.scene, animations: result.animations };
  }
  if (bundle.format === 'fbx') {
    const scene = await new FBXLoader(manager).loadAsync(bundle.primaryUrl);
    return { scene, animations: scene.animations };
  }
  const objLoader = new OBJLoader(manager);
  const mtl = files.find((file) => file.name.toLowerCase().endsWith('.mtl'));
  if (mtl) {
    const mtlUrl = URL.createObjectURL(mtl);
    try {
      const materials = await new MTLLoader(manager).loadAsync(mtlUrl);
      materials.preload();
      objLoader.setMaterials(materials);
    } finally {
      URL.revokeObjectURL(mtlUrl);
    }
  }
  return { scene: await objLoader.loadAsync(bundle.primaryUrl), animations: [] };
}

export class ModelViewport {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(45, 1, 0.01, 1000);
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly clock = new Clock();
  private readonly resizeObserver: ResizeObserver;
  private model: Object3D | null = null;
  private mixer: AnimationMixer | null = null;
  private frame = 0;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'model-canvas';
    host.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new HemisphereLight(0xffffff, 0x383845, 2.2));
    const key = new DirectionalLight(0xffffff, 2.8);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.animate();
  }

  setModel(model: Object3D, animations: AnimationClip[]): void {
    if (this.model) {
      this.scene.remove(this.model);
      disposeModel(this.model);
    }
    this.model = model;
    this.scene.add(model);
    const target = fitCameraToObject(this.camera, model, this.host.clientWidth / Math.max(this.host.clientHeight, 1));
    this.controls.target.copy(target);
    this.controls.update();
    this.mixer = animations.length ? new AnimationMixer(model) : null;
    if (this.mixer && !matchMedia('(prefers-reduced-motion: reduce)').matches) this.mixer.clipAction(animations[0]).play();
    this.resize();
  }

  applyImage(image: CanvasImageSource): number {
    if (!this.model) return 0;
    const previousTextures = new Set<import('three').Texture>();
    this.model.traverse((child) => {
      if (!('isMesh' in child)) return;
      const mesh = child as import('three').Mesh;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => {
        const map = (material as import('three').Material & { map?: import('three').Texture | null }).map;
        if (map) previousTextures.add(map);
      });
    });
    const texture = createPixelTexture(image);
    const count = applyTextureToModel(this.model, texture);
    previousTextures.forEach((previous) => previous.dispose());
    return count;
  }

  applyUV(name: string): { fallbackMeshes: number; missingMeshes: number } {
    return this.model ? applyUVChannel(this.model, name) : { fallbackMeshes: 0, missingMeshes: 0 };
  }

  private resize(): void {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.mixer?.update(this.clock.getDelta());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    if (this.model) disposeModel(this.model);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
