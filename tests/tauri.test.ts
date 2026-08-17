import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTauriApp, openExternalLink, saveBlobViaTauri, saveTextViaTauri } from '../src/lib/tauri';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import { installDomStubs } from './helpers/domStubs';

// Desktop shell: the webview lacks target="_blank" navigation and blob-anchor
// downloads, so these helpers route through the opener/dialog/fs plugins.
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: vi.fn(), writeFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

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
