import { saveBlobViaTauri, saveTextViaTauri } from './tauri';

export function cloneImageData(source: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height, { colorSpace: source.colorSpace });
}

/** RGBA pixel data plus dimensions — the shared shape of every decoded image
 * source (AO factors, lightmaps, normal maps). All the `*Source` aliases in the
 * renderer derive from this so the image→pixels contract stays in one place. */
export type PixelSource = { data: Uint8ClampedArray; width: number; height: number };

/** Creates a fresh canvas at the given size and returns it with its 2D context
 * (null if a context can't be created). Shared by every canvas bootstrap in the
 * app so the create + size + getContext idiom lives in one place. */
export function createCanvas(width: number, height: number, willReadFrequently = false): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D | null } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined);
  return { canvas, context };
}

/** Draws an image into a fresh canvas at the given size and returns the canvas
 * plus its 2D context (null if a context can't be created). Shared by every
 * image→pixels / image→canvas reader in the renderer. */
export function drawImageToCanvas(image: CanvasImageSource, width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D | null } {
  const { canvas, context } = createCanvas(width, height, true);
  if (context) context.drawImage(image, 0, 0, width, height);
  return { canvas, context };
}

/** Object-fit "contain" rect: scales `content` to fit inside `container`
 * (centered, never cropped) and returns the fitted position, size, and the
 * uniform scale. Mirrors CSS `object-fit: contain`, so the 2D preview pan/zoom,
 * the UV wireframe overlay, and eyedropper sampling all derive their geometry
 * from this one place instead of re-deriving letterbox math independently. */
export interface ContainRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Uniform scale applied to the content (content size → fitted size). */
  scale: number;
}

export function computeContainRect(containerWidth: number, containerHeight: number, contentWidth: number, contentHeight: number): ContainRect {
  if (containerWidth <= 0 || containerHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(containerWidth / contentWidth, containerHeight / contentHeight);
  const width = contentWidth * scale;
  const height = contentHeight * scale;
  return { left: (containerWidth - width) / 2, top: (containerHeight - height) / 2, width, height, scale };
}

/** Nearest-neighbor (pixelized) resize of an image to the given size —
 * smoothing disabled so source pixels stay crisp, matching the dithered
 * pipeline's pixelated look. Always returns a fresh canvas at the target
 * size, so callers can rely on canvas APIs (toBlob, getContext) regardless of
 * the source. Used to pixelize the normal map for the dithered viewport and
 * export, since a normal map can't be palette-dithered. */
export function resizeNearest(
  image: CanvasImageSource & { width: number; height: number },
  width: number,
  height: number,
): HTMLCanvasElement {
  const { canvas, context } = createCanvas(width, height);
  if (!context) throw new Error('Canvas is unavailable.');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

/** Draws an image at the given size and returns its RGBA pixel data. Shared by
 * the AO, lightmap, and normal-map image readers. */
export function imagePixels(image: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  const { context } = drawImageToCanvas(image, width, height);
  if (!context) throw new Error('Canvas is unavailable.');
  return context.getImageData(0, 0, width, height).data;
}

/** Writes RGBA pixel data into a fresh canvas at the given size. */
export function pixelsToCanvas(pixels: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const { canvas, context } = createCanvas(width, height);
  if (!context) throw new Error('Canvas is unavailable.');
  const imageData = context.createImageData(width, height);
  imageData.data.set(pixels);
  context.putImageData(imageData, 0, 0);
  return canvas;
}

/** Expands a single-channel factor array into a grayscale RGBA canvas. Pass an
 * optional `fill` callback to control the written value per pixel; returning
 * null leaves the pixel transparent (used for binary mask overlays). */
export function factorsToCanvas(
  factors: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  fill: (value: number, index: number) => number | null = (value) => value,
): HTMLCanvasElement {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < factors.length; i += 1) {
    const value = fill(factors[i], i);
    if (value === null) continue;
    const offset = i * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return pixelsToCanvas(pixels, width, height);
}

export function processLitImageData(
  source: ImageData,
  applyLighting: (pixels: Uint8ClampedArray, width: number, height: number) => void,
  process: (lit: ImageData) => ImageData,
): { lit: ImageData; processed: ImageData } {
  const lit = cloneImageData(source);
  applyLighting(lit.data, lit.width, lit.height);
  return { lit, processed: process(lit) };
}

/** Pixelizes a canvas by downscaling it to `1 - percent / 100` of its size and
 * nearest-neighbor upscaling it back to full resolution: a chunky block look
 * driven by a single 0..99 percentage (0 = off, the default). The downscale is
 * clamped to at least 1px so the image never collapses entirely. */
export function pixelateCanvas(canvas: HTMLCanvasElement, percent: number): HTMLCanvasElement {
  if (percent <= 0) return canvas;
  const { width, height } = canvas;
  const scale = 1 - percent / 100;
  const smallWidth = Math.max(1, Math.round(width * scale));
  const smallHeight = Math.max(1, Math.round(height * scale));
  const small = resizeNearest(canvas, smallWidth, smallHeight);
  return resizeNearest(small, width, height);
}

/** Nearest-neighbor resample to the given size followed by the downscale +
 * upscale pixelization filter — the processed normals map's pipeline, shared by
 * the 2D normals inspection, the processed viewport push, and the bake inputs. */
export function resampleAndPixelate(
  image: CanvasImageSource & { width: number; height: number },
  width: number,
  height: number,
  percent: number,
): HTMLCanvasElement {
  return pixelateCanvas(resizeNearest(image, width, height), percent);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSampleTexture(size = 640, seed = 1): HTMLCanvasElement {
  const { canvas, context } = createCanvas(size, Math.round(size * 0.72));
  if (!context) throw new Error('Canvas is unavailable.');

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#221d35');
  gradient.addColorStop(0.45, '#a63d5d');
  gradient.addColorStop(1, '#f2a65a');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = 'rgba(10, 16, 28, .72)';
  context.beginPath();
  context.moveTo(0, canvas.height * 0.75);
  context.lineTo(canvas.width * 0.2, canvas.height * 0.43);
  context.lineTo(canvas.width * 0.36, canvas.height * 0.7);
  context.lineTo(canvas.width * 0.57, canvas.height * 0.28);
  context.lineTo(canvas.width * 0.76, canvas.height * 0.67);
  context.lineTo(canvas.width, canvas.height * 0.38);
  context.lineTo(canvas.width, canvas.height);
  context.lineTo(0, canvas.height);
  context.closePath();
  context.fill();

  context.fillStyle = 'rgba(255, 226, 156, .92)';
  context.beginPath();
  context.arc(canvas.width * 0.76, canvas.height * 0.23, canvas.height * 0.115, 0, Math.PI * 2);
  context.fill();

  const noise = context.getImageData(0, 0, canvas.width, canvas.height);
  const random = mulberry32(seed);
  for (let i = 0; i < noise.data.length; i += 4) {
    const grain = (random() - 0.5) * 25;
    noise.data[i] += grain;
    noise.data[i + 1] += grain;
    noise.data[i + 2] += grain;
  }
  context.putImageData(noise, 0, 0);
  return canvas;
}

export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The selected file could not be decoded as an image.'));
    };
    image.src = url;
  });
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = name;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

export async function downloadText(content: string, name: string, type = 'application/json'): Promise<void> {
  // Desktop: the webview ignores blob-anchor downloads, so the native Save
  // dialog writes the file instead. Web keeps the anchor download.
  if (await saveTextViaTauri(name, content)) return;
  triggerDownload(new Blob([content], { type }), name);
}

export async function downloadCanvas(canvas: HTMLCanvasElement, name: string): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;
  if (await saveBlobViaTauri(name, blob)) return;
  triggerDownload(blob, name);
}
