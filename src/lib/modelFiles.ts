export type ModelFormat = 'fbx' | 'obj' | 'gltf' | 'glb' | 'usdz';
export type WorldAxis = 'blender' | 'maya';

const modelExtensions = new Set<ModelFormat>(['fbx', 'obj', 'gltf', 'glb', 'usdz']);
const imageResourcePattern = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;
const missingImageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const missingResourceUrl = 'data:application/octet-stream;base64,';

function safelyDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function fileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export function modelFormat(name: string): ModelFormat | null {
  const extension = fileExtension(name) as ModelFormat;
  return modelExtensions.has(extension) ? extension : null;
}

export function findPrimaryModel(files: Iterable<Pick<File, 'name'>>): Pick<File, 'name'> {
  const models = Array.from(files).filter((file) => modelFormat(file.name));
  if (models.length === 0) throw new Error('Choose an FBX, OBJ, glTF, GLB, or USDZ model.');
  if (models.length > 1) throw new Error('Choose one primary model at a time.');
  return models[0];
}

function normalizedResourceKeys(name: string): string[] {
  const clean = name.replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = clean.split('/').pop()!;
  return Array.from(new Set([clean, basename, safelyDecodeURIComponent(clean), safelyDecodeURIComponent(basename)])).map((key) => key.toLowerCase());
}

export type ModelFileBundle = {
  primary: File;
  format: ModelFormat;
  primaryUrl: string;
  manager: {
    resolveURL(url: string): string;
  };
  revoke(): void;
};

export function createModelFileBundle(filesInput: FileList | File[]): ModelFileBundle {
  const files = Array.from(filesInput);
  if (files.length > 64) throw new Error('Choose no more than 64 model and companion files.');
  if (files.reduce((total, file) => total + file.size, 0) > 200_000_000) throw new Error('Model bundle exceeds the 200 MB limit.');
  const primary = findPrimaryModel(files) as File;
  const format = modelFormat(primary.name)!;
  const urls = new Map<string, string>();
  const createdUrls = new Set<string>();

  files.forEach((file) => {
    const url = URL.createObjectURL(file);
    createdUrls.add(url);
    normalizedResourceKeys(file.name).forEach((key) => urls.set(key, url));
  });

  const primaryUrl = urls.get(primary.name.toLowerCase())!;
  return {
    primary,
    format,
    primaryUrl,
    manager: {
      resolveURL(url: string): string {
        if (/^data:/i.test(url) || createdUrls.has(url)) return url;
        const decoded = safelyDecodeURIComponent(url).replace(/\\/g, '/');
        const basename = decoded.split('/').pop()!;
        const uploadedResource = urls.get(decoded.toLowerCase()) ?? urls.get(basename.toLowerCase());
        if (uploadedResource) return uploadedResource;
        return imageResourcePattern.test(decoded) ? missingImageUrl : missingResourceUrl;
      },
    },
    revoke(): void {
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      createdUrls.clear();
    },
  };
}
