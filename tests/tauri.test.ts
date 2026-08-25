import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disableWebviewContextMenu, initTauriFileStore, isTauriApp, openExternalLink, saveBlobViaTauri, saveTextViaTauri } from '../src/lib/tauri';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { installDomStubs } from './helpers/domStubs';

// Desktop shell: the webview lacks target="_blank" navigation and blob-anchor
// downloads, so these helpers route through the opener/dialog/fs plugins.
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: vi.fn(), writeFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
// The install-folder data store reaches the Rust commands through invoke.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const SAVE_PATH = 'C:/Users/me/Downloads/out.json';

beforeAll(() => {
  installDomStubs();
});

beforeEach(() => {
  vi.mocked(save).mockReset().mockResolvedValue(SAVE_PATH);
  vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('isTauriApp', () => {
  it('is false in the plain browser (no Tauri internals)', () => {
    expect(isTauriApp()).toBe(false);
  });

  it('is true when the Tauri runtime injected its internals marker', () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(isTauriApp()).toBe(true);
  });
});

describe('disableWebviewContextMenu', () => {
  // installDomStubs maps window to globalThis, so temporarily attach a
  // capture listener to globalThis, run, and restore it afterwards.
  function withWindowListener(run: () => void): Array<(event: { target: unknown; preventDefault: () => void }) => void> {
    const g = globalThis as unknown as { addEventListener?: unknown };
    const previous = g.addEventListener;
    const handlers: Array<(event: { target: unknown; preventDefault: () => void }) => void> = [];
    g.addEventListener = ((_type: string, listener: (event: { target: unknown; preventDefault: () => void }) => void) => {
      handlers.push(listener);
    }) as never;
    try {
      run();
    } finally {
      if (previous === undefined) delete g.addEventListener;
      else g.addEventListener = previous as never;
    }
    return handlers;
  }

  it('registers in the plain browser and under Tauri  the tool UI never shows the native menu', () => {
    // The suppression is not desktop-only: the web build's own right-click
    // menu (Back/Refresh/Save As/Print) is equally unwanted on UI controls.
    expect(withWindowListener(() => {
      disableWebviewContextMenu();
    })).toHaveLength(1);
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      expect(withWindowListener(() => {
        disableWebviewContextMenu();
      })).toHaveLength(1);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it('suppresses the context menu outside editable fields', () => {
    const handlers = withWindowListener(() => {
      disableWebviewContextMenu();
    });
    const handler = handlers[0];
    expect(handler).toBeDefined();
    const prevented: unknown[] = [];
    const fire = (target: unknown) => handler({ target, preventDefault: () => prevented.push(target) });
    // Non-editable elements cancel the event so the native menu never shows.
    fire({ closest: () => null });
    // Editable fields keep the edit menu (Cut/Copy/Paste).
    fire({ closest: () => ({ tagName: 'INPUT' }) });
    expect(prevented).toHaveLength(1);
  });

  it('treats slider handles and toggle switches as UI controls, not editable fields', () => {
    const handlers = withWindowListener(() => {
      disableWebviewContextMenu();
    });
    const handler = handlers[0];
    const prevented: unknown[] = [];
    const fire = (target: unknown) => handler({ target, preventDefault: () => prevented.push(target) });
    // The editable exemption excludes range (slider) and checkbox (toggle)
    // inputs: closest() must not match them, so right-clicking cancels.
    const uiControl = (type: string) => ({
      closest: (selector: string) => (selector.includes(`[type="${type}"]`) ? null : { tagName: 'INPUT' }),
    });
    fire(uiControl('range'));
    fire(uiControl('checkbox'));
    expect(prevented).toHaveLength(2);
  });
});

describe('openExternalLink', () => {
  it('opens a new tab in the browser', async () => {
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    await openExternalLink('https://github.com/Ultikynnys/UltiPixelizer');
    expect(openSpy).toHaveBeenCalledWith('https://github.com/Ultikynnys/UltiPixelizer', '_blank', 'noopener,noreferrer');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('opens the system browser via the opener plugin under Tauri', async () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    await openExternalLink('https://ko-fi.com/r60dr60d');
    expect(openUrl).toHaveBeenCalledWith('https://ko-fi.com/r60dr60d');
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('saveTextViaTauri', () => {
  it('returns false in the browser so the caller falls back to an anchor download', async () => {
    await expect(saveTextViaTauri('x.json', '{}')).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('writes the picked path through the fs plugin under Tauri', async () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    await expect(saveTextViaTauri('x.json', '{"a":1}')).resolves.toBe(true);
    expect(save).toHaveBeenCalledWith({ defaultPath: 'x.json' });
    expect(writeTextFile).toHaveBeenCalledWith(SAVE_PATH, '{"a":1}');
  });

  it('treats a cancelled dialog as handled (nothing written)', async () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(save).mockResolvedValue(null);
    await expect(saveTextViaTauri('x.json', '{}')).resolves.toBe(true);
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

describe('saveBlobViaTauri', () => {
  it('returns false in the browser', async () => {
    await expect(saveBlobViaTauri('a.png', new Blob(['x']))).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('writes the blob bytes under Tauri', async () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    await expect(saveBlobViaTauri('a.png', new Blob(['x']))).resolves.toBe(true);
    expect(save).toHaveBeenCalledWith({ defaultPath: 'a.png' });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeFile).mock.calls[0][0]).toBe(SAVE_PATH);
    expect(vi.mocked(writeFile).mock.calls[0][1]).toBeInstanceOf(Uint8Array);
  });
});

// ---------------------------------------------------------------------------
// Install-folder data store (initTauriFileStore + the StorageLike facade)
// ---------------------------------------------------------------------------

// In-memory stand-in for the Rust side: files keyed by "<location>/<name>".
const fakeFiles = new Map<string, string>();
const INSTALL_DIR = 'C:/Program Files/UltiPixelizer';
const APPDATA_DIR = 'C:/Users/me/AppData/Roaming/com.ultikynnys.ultipixelizer';
let installWritable = true;

function mockStorageInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const { location, file, contents } = args as { location: string; file: string; contents?: string };
  const key = `${location}/${file}`;
  switch (command) {
    case 'write_app_data':
      if (location === 'install' && !installWritable) return Promise.reject(new Error('read-only file system'));
      fakeFiles.set(key, contents ?? '');
      return Promise.resolve();
    case 'remove_app_data':
      fakeFiles.delete(key);
      return Promise.resolve();
    case 'read_app_data':
      return Promise.resolve(fakeFiles.get(key) ?? null);
    case 'list_app_data': {
      const folder = (args as { folder: string }).folder;
      const prefix = `${location}/${folder}/`;
      return Promise.resolve(
        [...fakeFiles.keys()]
          .filter((fileKey) => fileKey.startsWith(prefix))
          .map((fileKey) => fileKey.slice(prefix.length))
          .sort(),
      );
    }
    case 'app_storage_dir':
      return Promise.resolve(location === 'install' ? INSTALL_DIR : APPDATA_DIR);
    default:
      return Promise.reject(new Error(`Unexpected command ${command}`));
  }
}

function resetStorageInvoke(): void {
  fakeFiles.clear();
  installWritable = true;
  vi.mocked(invoke).mockReset().mockImplementation(mockStorageInvoke as never);
}

describe('initTauriFileStore', () => {
  beforeEach(resetStorageInvoke);

  it('returns null in the plain browser and never invokes the backend', async () => {
    await expect(initTauriFileStore()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stores in the installation folder when it is writable (probe write + delete)', async () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const fileStore = await initTauriFileStore();
    expect(fileStore?.location).toBe('install');
    expect(fileStore?.dir).toBe(INSTALL_DIR);
    expect(invoke).toHaveBeenCalledWith('write_app_data', { location: 'install', file: 'storage-write-test.json', contents: '' });
    expect(invoke).toHaveBeenCalledWith('remove_app_data', { location: 'install', file: 'storage-write-test.json' });
    // The probe leaves no stray file behind.
    expect(fakeFiles.has('install/storage-write-test.json')).toBe(false);
  });

  it('falls back to the app-data dir when the install folder is read-only', async () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    installWritable = false;
    const fileStore = await initTauriFileStore();
    expect(fileStore?.location).toBe('appdata');
    expect(fileStore?.dir).toBe(APPDATA_DIR);
  });
});

describe('TauriFileStore file access', () => {
  beforeEach(resetStorageInvoke);

  async function openStore() {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const fileStore = await initTauriFileStore();
    if (!fileStore) throw new Error('Expected a desktop file store');
    return fileStore;
  }

  it('lists the file names in a folder, sorted', async () => {
    const fileStore = await openStore();
    fakeFiles.set('install/palettes/Zeta.hex', '000000\nffffff\n');
    fakeFiles.set('install/palettes/Alpha.hex', '112233\n445566\n');
    fakeFiles.set('install/config/settings.json', '{}');
    await expect(fileStore.list('palettes')).resolves.toEqual(['Alpha.hex', 'Zeta.hex']);
    await expect(fileStore.list('config')).resolves.toEqual(['settings.json']);
    await expect(fileStore.list('empty')).resolves.toEqual([]);
  });

  it('reads, writes and removes folder-qualified files', async () => {
    const fileStore = await openStore();
    await fileStore.write('config/settings.json', '{}');
    expect(invoke).toHaveBeenCalledWith('write_app_data', { location: 'install', file: 'config/settings.json', contents: '{}' });
    await expect(fileStore.preload('config/settings.json')).resolves.toBe('{}');
    await fileStore.remove('config/settings.json');
    expect(fakeFiles.has('install/config/settings.json')).toBe(false);
  });

  it('write() rejects with the backend error and never swallows it', async () => {
    const fileStore = await openStore();
    installWritable = false; // the install dir turned read-only after boot
    await expect(fileStore.write('config/settings.json', '{}')).rejects.toThrow('read-only file system');
  });
});
