import {
  AdditiveBlending,
  AmbientLight,
  AnimationClip,
  AxesHelper,
  AnimationMixer,
  Box3,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  LinearFilter,
  LoadingManager,
  Material,
  Mesh,
  MeshNormalMaterial,
  MOUSE,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  ShaderMaterial,
  Texture,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { createCanvas } from './canvas';
import type { ModelFileBundle, WorldAxis } from './modelFiles';
import { applyLodLevel } from './modelLod';
import { applyTextureToMaterial, applyUVChannel, convertToLambertShading, createPixelTexture, disposeModel, fitCameraToObject, forEachMeshIndexed, materialsOf, prepareSurfaceNormals, recomputeVertexNormals, triangleIndices } from './modelScene';
import { cameraForwardFromQuaternion, normalizeDirection, type DirectionVector } from './sunDirection';
import { UV_OVERLAP_LABEL } from './uvOverlap';

export type LoadedModel = { scene: Object3D; animations: AnimationClip[] };

export type CameraState = { position: Vector3; quaternion: Quaternion; target: Vector3 };

function overlapLabelTexture(): CanvasTexture {
  const { canvas, context } = createCanvas(256, 64);
  if (context) {
    context.font = '700 30px "DM Mono", monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.fillText(UV_OVERLAP_LABEL, 128, 32);
  }
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function configureManager(bundle: ModelFileBundle): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => bundle.manager.resolveURL(url));
  return manager;
}

export function upAxisRotation(worldAxis: WorldAxis): number {
  return worldAxis === 'blender' ? -Math.PI / 2 : 0;
}

function orientToWorldAxis(object: Object3D, worldAxis: WorldAxis): void {
  object.rotation.set(upAxisRotation(worldAxis), 0, 0);
}

export type LoadModelOptions = { useSourceNormals?: boolean; smoothAngle?: number; tessellation?: number };

export async function loadModel(
  bundle: ModelFileBundle,
  files: File[],
  worldAxis: WorldAxis,
  options: LoadModelOptions = {},
): Promise<LoadedModel> {
  const manager = configureManager(bundle);
  let scene: Object3D;
  let animations: AnimationClip[];

  if (bundle.format === 'glb' || bundle.format === 'gltf') {
    const result = await new GLTFLoader(manager).loadAsync(bundle.primaryUrl);
    scene = result.scene;
    animations = result.animations;
  } else if (bundle.format === 'usdz') {
    // USDLoader parses the USDZ archive in-process (embedded textures included)
    // and converts Z-up to Y-up itself, so like glTF no world-axis rotation applies.
    const loaded = await new USDLoader(manager).loadAsync(bundle.primaryUrl);
    scene = loaded;
    animations = loaded.animations ?? [];
  } else if (bundle.format === 'fbx') {
    // FBXLoader parses synchronously and starts texture loads (embedded or
    // companion files) asynchronously through the shared LoadingManager, so
    // loadAsync resolves before the texture images decode. Wait until the
    // manager reports all items complete (textures included) so callers like
    // collectModelTextures see decoded images, not placeholders.
    let textureLoadsStarted = false;
    let resolveIdle: () => void = () => {};
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    manager.onStart = () => {
      textureLoadsStarted = true;
    };
    manager.onLoad = () => resolveIdle();
    const loaded = await new FBXLoader(manager).loadAsync(bundle.primaryUrl);
    orientToWorldAxis(loaded, worldAxis);
    if (textureLoadsStarted) await idle;
    scene = loaded;
    animations = loaded.animations;
  } else {
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
    const loaded = await objLoader.loadAsync(bundle.primaryUrl);
    orientToWorldAxis(loaded, worldAxis);
    scene = loaded;
    animations = [];
  }

  if (!options.useSourceNormals) prepareSurfaceNormals(scene, options.smoothAngle, options.tessellation);
  convertToLambertShading(scene);
  return { scene, animations };
}

export class ModelViewport {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(45, 1, 0.01, 1000);
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly timer = new Timer();
  private readonly resizeObserver: ResizeObserver;
  // Lighting is baked only — the model texture already carries the baked (or
  // implicitly baked) lighting, so the viewport never re-lights it in realtime.
  // The full-intensity white ambient displays the texture unmodulated.
  private readonly ambient = new AmbientLight(0xffffff, Math.PI);
  private readonly axes = new AxesHelper(1);
  private model: Object3D | null = null;
  private mixer: AnimationMixer | null = null;
  private overlapOverlay: Mesh | null = null;
  private readonly normalMaterial = new MeshNormalMaterial({ side: DoubleSide });
  private readonly originalMaterials = new WeakMap<Mesh, Material | Material[]>();
  private normalsView = false;
  private frame = 0;

  /** Invoked whenever the orbit camera moves (drag, damping, or programmatic fit). */
  onCameraChange?: () => void;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'model-canvas';
    host.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.controls.addEventListener('change', () => this.onCameraChange?.());
    this.scene.add(this.ambient);
    this.scene.add(this.axes);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.timer.connect(document);
    this.animate();
  }

  setModel(model: Object3D, animations: AnimationClip[]): void {
    if (this.model) {
      this.setNormalsView(false);
      this.scene.remove(this.model);
      disposeModel(this.model);
    }
    this.removeOverlapOverlay();
    this.model = model;
    this.scene.add(model);
    this.mixer = animations.length ? new AnimationMixer(model) : null;
    if (this.mixer && !matchMedia('(prefers-reduced-motion: reduce)').matches) this.mixer.clipAction(animations[0]).play();
    this.resize();
    this.refitCamera();
  }

  setWorldAxis(worldAxis: WorldAxis): void {
    if (!this.model) return;
    orientToWorldAxis(this.model, worldAxis);
    this.refitCamera();
  }

  applyImage(image: CanvasImageSource): number {
    if (!this.model) return 0;
    const previousTextures = new Set<Texture>();
    this.model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      this.texturableMaterials(child).forEach((material) => {
        const map = (material as Material & { map?: Texture | null }).map;
        if (map) previousTextures.add(map);
      });
    });
    const texture = createPixelTexture(image);
    let count = 0;
    this.model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      this.texturableMaterials(child).forEach((material) => {
        applyTextureToMaterial(material, texture);
        count += 1;
      });
    });
    previousTextures.forEach((previous) => previous.dispose());
    return count;
  }

  /** The materials that carry the baked texture — the live materials, or the
   * originals stashed while the normals debug view is active. */
  private texturableMaterials(mesh: Mesh): Material[] {
    if (this.normalsView) {
      const original = this.originalMaterials.get(mesh);
      return original ? (Array.isArray(original) ? original : [original]) : [];
    }
    return materialsOf(mesh);
  }

  applyUV(name: string): { fallbackMeshes: number; missingMeshes: number } {
    return this.model ? applyUVChannel(this.model, name) : { fallbackMeshes: 0, missingMeshes: 0 };
  }

  applyLOD(level: number): number {
    return this.model ? applyLodLevel(this.model, level) : 0;
  }

  /** Re-smooths the model's normals in place at the given smooth angle (a no-op
   * while source normals are in effect). */
  applySmoothAngle(angle: number): void {
    if (!this.model) return;
    recomputeVertexNormals(this.model, angle);
  }

  /** Re-tessellates the model from its pristine base geometry at the given
   * density, re-smooths at `angle`, and restores the active UV channel (the
   * rebuild produces a fresh geometry with the primary channel active). */
  applyTessellation(tessellation: number, angle: number, uvChannel: string): void {
    if (!this.model) return;
    prepareSurfaceNormals(this.model, angle, tessellation);
    applyUVChannel(this.model, uvChannel);
  }

  /** Swaps every mesh to a normals-as-color material for visual debugging, and
   * restores the originals when disabled. */
  setNormalsView(enabled: boolean): void {
    if (!this.model || this.normalsView === enabled) return;
    this.normalsView = enabled;
    this.model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      if (enabled) {
        this.originalMaterials.set(child, child.material);
        child.material = this.normalMaterial;
      } else {
        const original = this.originalMaterials.get(child);
        if (original) {
          child.material = original;
          this.originalMaterials.delete(child);
        }
      }
    });
  }

  /**
   * Highlights overlapping UV triangles as a translucent red overlay. The map
   * keys are mesh traversal indices (matching `collectUVTriangles`), values are
   * triangle indices. Passing null (or an empty map) removes the overlay.
   */
  setUVOverlap(overlapping: Map<number, number[]> | null): void {
    this.removeOverlapOverlay();
    if (!overlapping || overlapping.size === 0 || !this.model) return;

    this.model.updateMatrixWorld(true);
    const positions: number[] = [];
    const v = new Vector3();
    forEachMeshIndexed(this.model, (child, meshIndex) => {
      const meshTriangleIndices = overlapping.get(meshIndex);
      if (!meshTriangleIndices || meshTriangleIndices.length === 0) return;

      const position = child.geometry.getAttribute('position');
      if (!position) return;
      for (const triangleIndex of meshTriangleIndices) {
        const [ia, ib, ic] = triangleIndices(child.geometry, triangleIndex);
        for (const vertexIndex of [ia, ib, ic]) {
          v.fromBufferAttribute(position, vertexIndex).applyMatrix4(child.matrixWorld);
          positions.push(v.x, v.y, v.z);
        }
      }
    });
    if (positions.length === 0) return;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      uniforms: { uTime: { value: 0 }, uText: { value: overlapLabelTexture() } },
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform sampler2D uText;
        void main() {
          vec2 p = gl_FragCoord.xy;
          float a = 0.5 + 0.5 * sin((p.x + p.y) * 0.06 + uTime * 5.0);
          float b = 0.5 + 0.5 * sin((p.x - p.y) * 0.08 - uTime * 3.5);
          float wave = clamp(a * 0.7 + b * 0.3, 0.0, 1.0);
          vec2 cell = vec2(256.0, 64.0);
          vec2 t = mod(p - vec2(uTime * 60.0, uTime * 30.0), cell) / cell;
          float label = texture2D(uText, t).a;
          float i = clamp(max(wave, label * 0.9), 0.0, 1.0);
          vec3 color = mix(vec3(1.0, 0.12, 0.28), vec3(1.0, 0.68, 0.14), i);
          gl_FragColor = vec4(color * (0.5 + i * 1.5), 0.35 + i * 0.5);
        }
      `,
    });
    this.overlapOverlay = new Mesh(geometry, material);
    this.overlapOverlay.renderOrder = 1;
    this.scene.add(this.overlapOverlay);
  }

  private removeOverlapOverlay(): void {
    if (!this.overlapOverlay) return;
    this.scene.remove(this.overlapOverlay);
    this.overlapOverlay.geometry.dispose();
    const material = this.overlapOverlay.material as ShaderMaterial;
    (material.uniforms.uText.value as CanvasTexture | undefined)?.dispose();
    material.dispose();
    this.overlapOverlay = null;
  }

  getCameraForward(): DirectionVector {
    const worldQuaternion = this.camera.getWorldQuaternion(new Quaternion());
    return cameraForwardFromQuaternion(worldQuaternion);
  }

  /** Orients the orbit camera to look along a world forward direction, keeping
   * the current orbit distance and target. Used to restore a saved camera angle
   * after loading settings. */
  setCameraForward(direction: DirectionVector): void {
    const forward = normalizeDirection(direction);
    const target = new Vector3(this.controls.target.x, this.controls.target.y, this.controls.target.z);
    const distance = this.camera.position.distanceTo(target);
    this.camera.position.copy(target).addScaledVector(new Vector3(forward.x, forward.y, forward.z), -distance);
    this.camera.lookAt(target);
    this.controls.update();
    this.onCameraChange?.();
  }

  /** Snapshot of the orbit camera — position, orientation, and orbit target —
   * so the user's view can survive a model swap (setModel refits the camera). */
  captureCamera(): CameraState {
    return {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
      target: this.controls.target.clone(),
    };
  }

  /** Restores a snapshot taken by `captureCamera`, re-aiming the orbit controls
   * at the saved target. */
  restoreCamera(state: CameraState): void {
    this.camera.position.copy(state.position);
    this.camera.quaternion.copy(state.quaternion);
    this.controls.target.copy(state.target);
    this.controls.update();
  }

  /** Recenters the orbit camera on the model and notifies camera-change
   * listeners. Shared by model load and world-axis changes. */
  private refitCamera(): void {
    if (!this.model) return;
    this.fitAxesToModel();
    const target = fitCameraToObject(this.camera, this.model, this.host.clientWidth / Math.max(this.host.clientHeight, 1));
    this.controls.target.copy(target);
    this.controls.update();
    this.onCameraChange?.();
  }

  private fitAxesToModel(): void {
    if (!this.model) return;
    const bounds = new Box3().setFromObject(this.model);
    const size = bounds.isEmpty() ? 1 : Math.max(bounds.getSize(new Vector3()).length() * 0.2, 0.01);
    this.axes.scale.setScalar(size);
  }

  private resize(): void {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = (timestamp?: number): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.timer.update(timestamp);
    this.mixer?.update(this.timer.getDelta());
    this.controls.update();
    if (this.overlapOverlay) {
      (this.overlapOverlay.material as ShaderMaterial).uniforms.uTime.value = (timestamp ?? 0) / 1000;
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.timer.dispose();
    this.removeOverlapOverlay();
    this.setNormalsView(false);
    if (this.model) disposeModel(this.model);
    this.normalMaterial.dispose();
    this.axes.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
