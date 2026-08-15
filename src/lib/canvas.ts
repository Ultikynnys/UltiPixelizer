export function cloneImageData(source: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height, { colorSpace: source.colorSpace });
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
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = Math.round(size * 0.72);
  const context = canvas.getContext('2d');
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

export function downloadText(content: string, name: string, type = 'application/json'): void {
  triggerDownload(new Blob([content], { type }), name);
}

export function downloadCanvas(canvas: HTMLCanvasElement, name: string): void {
  canvas.toBlob((blob) => {
    if (blob) triggerDownload(blob, name);
  }, 'image/png');
}
