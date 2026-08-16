import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelFileBundle, fileExtension, findPrimaryModel, modelFormat } from '../src/lib/modelFiles';

function file(name: string, size = 0): File {
  return { name, size } as File;
}

beforeEach(() => {
  let id = 0;
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:${++id}`),
    revokeObjectURL: vi.fn(),
  });
});

describe('model file bundles', () => {
  it('detects supported extensions case-insensitively', () => {
    expect(fileExtension('thing.MODEL.GLB')).toBe('glb');
    expect(['fbx', 'obj', 'gltf', 'glb', 'usdz'].map((extension) => modelFormat(`mesh.${extension}`))).toEqual(['fbx', 'obj', 'gltf', 'glb', 'usdz']);
    expect(modelFormat('mesh.stl')).toBeNull();
  });

  it('requires exactly one primary model', () => {
    expect(() => findPrimaryModel([file('readme.txt')])).toThrow('Choose an FBX');
    expect(() => findPrimaryModel([file('a.obj'), file('b.glb')])).toThrow('one primary');
    expect(findPrimaryModel([file('mesh.obj'), file('mesh.mtl')]).name).toBe('mesh.obj');
  });

  it('caps model bundle file counts and total bytes', () => {
    expect(() => createModelFileBundle(Array.from({ length: 65 }, (_, index) => file(index ? `asset-${index}.bin` : 'model.glb')))).toThrow('64');
    expect(() => createModelFileBundle([file('model.glb', 200_000_001)])).toThrow('200 MB');
  });

  it('resolves relative companion resources and revokes every URL', () => {
    const bundle = createModelFileBundle([file('scene/model.gltf'), file('buffers/model.bin'), file('textures/albedo.png')]);
    expect(bundle.format).toBe('gltf');
    expect(bundle.primaryUrl).toBe('blob:1');
    expect(bundle.manager.resolveURL('./buffers/model.bin')).toBe('blob:2');
    expect(bundle.manager.resolveURL('textures%2Falbedo.png')).toBe('blob:3');
    expect(bundle.manager.resolveURL('missing.png')).toBe('missing.png');
    expect(bundle.manager.resolveURL('blob:https://example.test/textures/missing.png')).toBe('blob:https://example.test/textures/missing.png');
    expect(bundle.manager.resolveURL('https://127.0.0.1/private')).toBe('https://127.0.0.1/private');
    expect(bundle.manager.missing).toEqual(['missing.png', 'blob:https://example.test/textures/missing.png', 'https://127.0.0.1/private']);
    expect(bundle.manager.resolveURL('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
    expect(bundle.manager.resolveURL(bundle.primaryUrl)).toBe(bundle.primaryUrl);
    bundle.revoke();
    bundle.revoke();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('passes loader-created blob URLs for embedded textures through untouched', () => {
    const bundle = createModelFileBundle([file('model.fbx')]);
    // Binary FBX Video.Content and GLB bufferView images load through blob
    // object URLs created by the loaders (blob:<origin>/<uuid>); those must
    // survive resolveURL, unlike unresolved relative references which carry a
    // file extension and fail loudly (recorded in `missing`).
    expect(bundle.manager.resolveURL('blob:https://example.test/3f2a4b5c-6d7e-8f90-abcd-1234567890ef')).toBe('blob:https://example.test/3f2a4b5c-6d7e-8f90-abcd-1234567890ef');
    expect(bundle.manager.resolveURL('blob:https://example.test/textures/missing.png')).toBe('blob:https://example.test/textures/missing.png');
    expect(bundle.manager.missing).toEqual(['blob:https://example.test/textures/missing.png']);
    bundle.revoke();
  });

  it('handles literal percent characters in uploaded and referenced file names', () => {
    const bundle = createModelFileBundle([file('model.fbx'), file('Book 100%.png')]);
    expect(bundle.manager.resolveURL('textures/Book 100%.png')).toBe('blob:2');
    expect(bundle.manager.resolveURL('textures/Book%20100%25.png')).toBe('blob:2');
    bundle.revoke();
  });
});
