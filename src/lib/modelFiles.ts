export type ModelFormat = 'fbx' | 'obj' | 'gltf' | 'glb';

const modelExtensions = new Set<ModelFormat>(['fbx', 'obj', 'gltf', 'glb']);

export function fileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export function modelFormat(name: string): ModelFormat | null {
  const extension = fileExtension(name) as ModelFormat;
  return modelExtensions.has(extension) ? extension : null;
}

export function findPrimaryModel(files: Iterable<Pick<File, 'name'>>): Pick<File, 'name'> {
  const models = Array.from(files).filter((file) => modelFormat(file.name));
  if (models.length === 0) throw new Error('Choose an FBX, OBJ, glTF, or GLB model.');
  if (models.length > 1) throw new Error('Choose one primary model at a time.');
  return models[0];
}

function normalizedResourceKeys(name: string): string[] {
  const clean = name.replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = clean.split('/').pop() ?? clean;
  return Array.from(new Set([clean, basename, decodeURIComponent(clean), decodeURIComponent(basename)])).map((key) => key.toLowerCase());
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
        const decoded = decodeURIComponent(url).replace(/\\/g, '/');
        const basename = decoded.split('/').pop() ?? decoded;
        const embeddedResource = /^(?:data|blob):/i.test(url);
        return urls.get(decoded.toLowerCase()) ?? urls.get(basename.toLowerCase()) ?? (embeddedResource ? url : 'data:application/octet-stream;base64,');
      },
    },
    revoke(): void {
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      createdUrls.clear();
    },
  };
}
