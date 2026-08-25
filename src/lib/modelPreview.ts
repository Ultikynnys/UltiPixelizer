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
  GridHelper,
  LinearFilter,
  LoadingManager,
  Material,
  Mesh,
  MOUSE,
  NearestFilter,
  Object3D,
  OrthographicCamera,
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
import { applyDisplacement, applyTextureToMaterial, applyUVChannel, convertToLambertShading, createPixelTexture, disposeModel, fitCameraToObject, forEachMeshIndexed, materialsOf, triangleIndices, type HeightSampler } from './modelScene';
import { cameraForwardFromQuaternion, normalizeDirection, type DirectionVector } from './sunDirection';
import { UV_OVERLAP_LABEL } from './uvOverlap';

export type LoadedModel = { scene: Object3D; animations: AnimationClip[] };

export type CameraState = { position: Vector3; quaternion: Quaternion; target: Vector3 };

/** Floor reference convention: one Three.js world unit is treated as one metre,
 * and every grid division is 0.1 units (10 cm). */
export const FLOOR_GRID_DIVISION = 0.1;
export const FLOOR_GRID_RADIUS = 5;
const FLOOR_GRID_SIZE = FLOOR_GRID_RADIUS * 2;
const FLOOR_GRID_DIVISIONS = FLOOR_GRID_SIZE / FLOOR_GRID_DIVISION;
const FLOOR_GRID_OPACITY = 0.35;

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

/** Loads with the three.js FBXLoader's Z-up notice suppressed. The FBXLoader
 * warns (and rotates the root to Y-up) whenever an FBX declares a Z-up axis;
 * loadModel immediately overwrites that rotation via orientToWorldAxis, so the
 * notice describes conversion work that is undone. Filter only that one
 * message and restore console.warn when the load settles. */
function withoutFbxUpAxisWarning<T>(load: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = ((...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('Z-UP coordinate system')) return;
    original(...args);
  }) as typeof console.warn;
  try {
    return load().finally(() => {
      console.warn = original;
    });
  } catch (error) {
    console.warn = original;
    throw error;
  }
}

export async function loadModel(
  bundle: ModelFileBundle,
  files: File[],
  worldAxis: WorldAxis,
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
    let resolveIdle: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    manager.onStart = () => {
      textureLoadsStarted = true;
    };
    manager.onLoad = () => resolveIdle?.();
    const loaded = await withoutFbxUpAxisWarning(() => new FBXLoader(manager).loadAsync(bundle.primaryUrl));
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
  private readonly floorGrid = new GridHelper(FLOOR_GRID_SIZE, FLOOR_GRID_DIVISIONS, 0x7f8c8d, 0x46525a);
  private floorGridY = 0;
  private readonly axes = new AxesHelper(1);
  private readonly gizmoScene = new Scene();
  private readonly gizmoCamera = new OrthographicCamera(-1.3, 1.3, 1.3, -1.3, 0.1, 10);
  private model: Object3D | null = null;
  private mixer: AnimationMixer | null = null;
  private overlapOverlay: Mesh | null = null;
  private normalMapTexture: Texture | null = null;
  // Normals view material — samples the model's normal-map texture at UV and
  // outputs the decoded tangent-space normal as color, using the same decode
  // the lightmap bake applies (rgb*2-1, DirectX green flip, strength, tz
  // reconstruction). Without a map every fragment is the neutral flat normal
  // (0, 0, 1), shown as (0.5, 0.5, 1.0) blue.
  private readonly normalMapMaterial = new ShaderMaterial({
    side: DoubleSide,
    uniforms: {
      uNormalMap: { value: null },
      uHasNormalMap: { value: 0 },
      uStrength: { value: 1 },
      uFlipY: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uNormalMap;
      uniform float uHasNormalMap;
      uniform float uStrength;
      uniform float uFlipY;
      varying vec2 vUv;
      void main() {
        vec3 n = vec3(0.0, 0.0, 1.0);
        if (uHasNormalMap > 0.5) {
          n = texture2D(uNormalMap, vUv).rgb * 2.0 - 1.0;
          // DirectX convention stores green flipped (green = −Y); uFlipY = 1
          // inverts it so the decode matches the lightmap bake.
          n.y *= mix(1.0, -1.0, uFlipY);
          n.xy *= uStrength;
          n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
        }
        gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
      }
    `,
  });
  private readonly originalMaterials = new WeakMap<Mesh, Material | Material[]>();
  private normalsView = false;
  private frame = 0;
  // Strips Ctrl/Cmd/Shift from pointerdown so three's built-in modifier swap
  // (orbit-left becomes pan, pan-left becomes orbit) can never fire. The
  // navigation toggle is the only thing that picks the drag action.
  private readonly modifierStripper: (event: PointerEvent) => void;

  /** Invoked whenever the orbit camera moves (drag, damping, or programmatic fit). */
  onCameraChange?: () => void;

  /** Swaps the primary drag button between orbit and pan: orbit-left /
   * pan-right (the default) or pan-left / orbit-right. The middle button
   * always zooms. Orbit drags rotate around the target; pan drags move the
   * camera sideways. */
  setNavigationDragMode(panLeft: boolean): void {
    this.controls.mouseButtons = panLeft
      ? { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }
      : { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
  }

  /** Shows a transparent floor reference in both app viewports. Spacing is
   * always 0.1 world units (10 cm under the app's 1 unit = 1 metre convention)
   * and the grid repeats to a 5 m radius around the camera. */
  setFloorGrid(visible: boolean): void {
    this.floorGrid.visible = visible;
    if (visible) this.updateFloorGridPosition();
  }

  private updateFloorGrid(): void {
    if (!this.model) return;
    this.model.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(this.model);
    if (bounds.isEmpty()) return;
    this.floorGridY = bounds.min.y;
    this.updateFloorGridPosition();
  }

  private updateFloorGridPosition(): void {
    this.floorGrid.position.set(
      Math.round(this.camera.position.x / FLOOR_GRID_DIVISION) * FLOOR_GRID_DIVISION,
      this.floorGridY,
      Math.round(this.camera.position.z / FLOOR_GRID_DIVISION) * FLOOR_GRID_DIVISION,
    );
  }

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
    // three's OrbitControls swaps the drag action while Ctrl/Cmd/Shift is held
    // (orbit-left becomes pan, pan-left becomes orbit). The navigation toggle
    // already fixes the action, so a held modifier must not override it: zero
    // the flags on the event before the control's own pointerdown handler runs
    // (capture on the host precedes the canvas listeners).
    this.modifierStripper = (event) => {
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return;
      for (const key of ['ctrlKey', 'metaKey', 'shiftKey'] as const) {
        Object.defineProperty(event, key, { value: false });
      }
    };
    host.addEventListener('pointerdown', this.modifierStripper, true);
    this.floorGrid.visible = false;
    const floorMaterials = Array.isArray(this.floorGrid.material) ? this.floorGrid.material : [this.floorGrid.material];
    floorMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = FLOOR_GRID_OPACITY;
      material.depthWrite = false;
    });
    this.scene.add(this.ambient, this.floorGrid);
    this.axes.renderOrder = 1;
    // The gizmo lives in its own scene — rendered last, scissored into the
    // bottom-right corner — so the model can never occlude it. It renders with
    // auto-clear disabled (see renderGizmo), so no background plane is needed
    // and the model shows through. The axis lines skip depth testing so the
    // stale model depth buffer can't hide them.
    (this.axes.material as Material).depthTest = false;
    (this.axes.material as Material).depthWrite = false;
    this.gizmoScene.add(this.axes);
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
    this.updateFloorGrid();
    // Keep the gizmo aligned with the model's world-axis convention — the model
    // arrives pre-oriented from loadModel, so mirror its root rotation.
    this.axes.rotation.copy(model.rotation);
    this.mixer = animations.length ? new AnimationMixer(model) : null;
    if (this.mixer && !matchMedia('(prefers-reduced-motion: reduce)').matches) this.mixer.clipAction(animations[0]).play();
    this.resize();
    this.refitCamera();
  }

  setWorldAxis(worldAxis: WorldAxis): void {
    if (!this.model) return;
    orientToWorldAxis(this.model, worldAxis);
    // Mirror the convention rotation so the gizmo tracks the model's axes:
    // Z-up (Blender) shows the blue Z axis pointing up, Y-up (Maya) the green Y.
    this.axes.rotation.copy(this.model.rotation);
    this.updateFloorGrid();
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

  /** Displaces the model's vertices along their original normals by the
   * heightmap sample at each vertex's UV — see modelScene.applyDisplacement.
   * Pass null (or zero strength) to restore the pristine geometry. */
  applyDisplacement(height: HeightSampler | null, strength: number): void {
    if (!this.model) return;
    applyDisplacement(this.model, height, strength);
  }

  /** Swaps every mesh to the normal-map showcase material — the actual normal
   * map sampled at UV, not the mesh's vertex normals — and restores the
   * originals when disabled. */
  setNormalsView(enabled: boolean): void {
    if (!this.model || this.normalsView === enabled) return;
    this.normalsView = enabled;
    this.model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      if (enabled) {
        this.originalMaterials.set(child, child.material);
        child.material = this.normalMapMaterial;
      } else {
        const original = this.originalMaterials.get(child);
        if (original) {
          child.material = original;
          this.originalMaterials.delete(child);
        }
      }
    });
  }

  /** Supplies the model's normal map to the Normals view. `strength` and
   * `flipY` (DirectX green flip) mirror the lightmap bake's decode, so the view
   * showcases the map exactly as lighting consumes it. Pass null to clear. */
  setNormalMap(image: CanvasImageSource | null, strength = 1, flipY = false): void {
    if (this.normalMapTexture) {
      this.normalMapTexture.dispose();
      this.normalMapTexture = null;
    }
    if (image) {
      const texture = new CanvasTexture(image);
      texture.magFilter = NearestFilter;
      texture.minFilter = NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      this.normalMapTexture = texture;
    }
    const uniforms = this.normalMapMaterial.uniforms;
    uniforms.uNormalMap.value = this.normalMapTexture;
    uniforms.uHasNormalMap.value = this.normalMapTexture ? 1 : 0;
    uniforms.uStrength.value = strength;
    uniforms.uFlipY.value = flipY ? 1 : 0;
  }

  /** Live strength update for the Normals-view showcase — cheaper than a full
   * `setNormalMap`, since only the shader uniform moves and the texture stays
   * untouched. Mirrors the lightmap bake's `normalStrength` decode. */
  setNormalStrength(strength: number): void {
    this.normalMapMaterial.uniforms.uStrength.value = strength;
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

  /** Re-aims the orbit camera from a saved view (world position + orbit
   * target). The viewport up axis is fixed, so position + target fully
   * determine the orientation — angle and position survive the round-trip
   * without storing the camera quaternion. Fires the camera-change callback
   * so the orientation readout follows. Used when loading saved settings. */
  restoreCameraView(position: DirectionVector, target: DirectionVector): void {
    this.camera.position.set(position.x, position.y, position.z);
    const targetVector = new Vector3(target.x, target.y, target.z);
    this.camera.lookAt(targetVector);
    this.controls.target.copy(targetVector);
    this.controls.update();
    this.onCameraChange?.();
  }

  /** Recenters the orbit camera on the model and notifies camera-change
   * listeners. Shared by model load and world-axis changes. */
  private refitCamera(): void {
    if (!this.model) return;
    const target = fitCameraToObject(this.camera, this.model, this.host.clientWidth / Math.max(this.host.clientHeight, 1));
    this.controls.target.copy(target);
    this.controls.update();
    this.onCameraChange?.();
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
    if (this.floorGrid.visible) this.updateFloorGridPosition();
    if (this.overlapOverlay) {
      (this.overlapOverlay.material as ShaderMaterial).uniforms.uTime.value = (timestamp ?? 0) / 1000;
    }
    this.renderer.render(this.scene, this.camera);
    this.renderGizmo();
  };

  /** Draws the world-axis gizmo into a fixed screen-space box at the bottom-right
   * corner of the canvas, oriented to match the orbit camera. Rendered last from
   * its own scene so the model can never occlude it. */
  private renderGizmo(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width <= 0 || height <= 0) return;
    const size = Math.max(48, Math.min(72, Math.round(Math.min(width, height) * 0.16)));
    const bottom = 12;
    this.gizmoCamera.quaternion.copy(this.camera.quaternion);
    this.gizmoCamera.position.copy(this.gizmoCamera.getWorldDirection(new Vector3())).multiplyScalar(-3.5);
    // Viewport and scissor values are logical pixels: the renderer scales them
    // by pixel ratio internally (three r150+), so passing device pixels here
    // would double-scale and push the gizmo box outside the drawing buffer on
    // HiDPI displays (e.g. Windows at 150%).
    const x = Math.round(width - size - 12);
    const y = Math.round(bottom);
    const s = Math.round(size);
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(x, y, s, s);
    this.renderer.setViewport(x, y, s, s);
    // Render without clearing: the model (already drawn this frame) stays in the
    // framebuffer, so the gizmo box is transparent and only the axis lines draw
    // on top of it.
    this.renderer.autoClear = false;
    this.renderer.render(this.gizmoScene, this.gizmoCamera);
    this.renderer.autoClear = true;
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.setScissorTest(false);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.host.removeEventListener('pointerdown', this.modifierStripper, true);
    this.timer.dispose();
    this.removeOverlapOverlay();
    this.setNormalsView(false);
    if (this.model) disposeModel(this.model);
    this.normalMapMaterial.dispose();
    this.normalMapTexture?.dispose();
    this.floorGrid.geometry.dispose();
    const gridMaterials = Array.isArray(this.floorGrid.material) ? this.floorGrid.material : [this.floorGrid.material];
    gridMaterials.forEach((material) => material.dispose());
    this.axes.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
