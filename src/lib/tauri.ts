/**
 * Desktop bridge: the Tauri webview lacks two browser behaviors the app
 * relies on, so when running under Tauri these helpers route through the
 * native shell instead:
 *
 *  - external links (`target="_blank"`) are a no-op in the webview →
 *    opener plugin opens them in the system browser;
 *  - blob-anchor downloads are a no-op in the webview → the native Save
 *    dialog (dialog plugin) plus fs write persist the file.
 *
 * Everything falls back to the plain browser behavior in the web build, and
 * the plugin packages are dynamic imports so they never enter the browser
 * bundle.
 *
 * The save dialog auto-allows the picked path in the fs scope (the dialog
 * plugin calls fs_scope().allow_file on the selection), so the fs write
 * permissions need no explicit scope configuration.
 */

export function isTauriApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Suppresses the native browser context menu (Back / Refresh / Save As /
 * Print / Cut / Copy / Paste)  browser chrome that has no place in an app
 * window or tool UI. Right-clicking a control like a `<select>` dropdown
 * (UV map, LOD, upscale), a slider, a toggle, or a text field must never
 * surface the native menu, so the suppression is unconditional over the
 * whole document. The DOM `contextmenu` event fires before the native menu
 * on all three webview backends (WebView2, WebKitGTK, WKWebView), so
 * canceling it hides the menu; it also fires before the browser's own menu
 * in the web build, where the tool suppresses it for the same reason.
 */
export function disableWebviewContextMenu(): void {
  window.addEventListener(
    'contextmenu',
    (event) => event.preventDefault(),
    // Capture: run before any element handler could stop propagation, so a
    // future custom context menu can't be preempted by the native one.
    { capture: true },
  );
}

/** Opens a URL in the system browser (Tauri) or a new tab (web). */
export async function openExternalLink(url: string): Promise<void> {
  if (!isTauriApp()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/**
 * Saves text through the native Save dialog. Returns true when handled
 * (including a user cancel), false when not under Tauri so the caller can
 * fall back to the browser download.
 */
export async function saveTextViaTauri(defaultName: string, content: string): Promise<boolean> {
  if (!isTauriApp()) return false;
  const [{ save }, { writeTextFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const path = await save({ defaultPath: defaultName });
  if (!path) return true; // user cancelled the dialog
  await writeTextFile(path, content);
  return true;
}

/** Same as saveTextViaTauri, for binary content (PNG exports). */
export async function saveBlobViaTauri(defaultName: string, blob: Blob): Promise<boolean> {
  if (!isTauriApp()) return false;
  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const path = await save({ defaultPath: defaultName });
  if (!path) return true; // user cancelled the dialog
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

// ---------------------------------------------------------------------------
// Install-folder data store
// ---------------------------------------------------------------------------

/**
 * Persistent app data lives as files in the installation folder 
 * `resource_dir()`  organized in folders, so users can see and back up their
 * data where the app is installed, instead of inside the webview's opaque
 * profile storage. Layout: `config/settings.json` (the app settings) and
 * `palettes/<name>.hex` (one file per custom palette, named after the
 * palette). The Rust side (`read/write/remove/list_app_data`) resolves and
 * validates the folder-qualified paths; this module probes whether the
 * installation folder is writable and exposes the async file commands.
 *
 * The install folder is NOT writable on every platform (Program Files MSI
 * installs, macOS app bundles, Linux AppImage mounts). That case falls back to
 * the per-user app-data dir  never silently: `location` and `dir` come back to
 * the caller, which is expected to surface a visible notice.
 */

export type TauriStorageLocation = 'install' | 'appdata';

/** Known subfolders of the data directory. */
export const CONFIG_FOLDER = 'config';
export const CUSTOM_PALETTES_FOLDER = 'palettes';

export type TauriFileStore = {
  /** Where data is actually being stored ("install" = the installation folder). */
  location: TauriStorageLocation;
  /** Resolved absolute path of the storage directory (for user-facing notices). */
  dir: string;
  /** Reads one folder-qualified file; resolves the contents (null when absent). */
  preload(file: string): Promise<string | null>;
  /** Writes one folder-qualified file (cache + disk). */
  write(file: string, contents: string): Promise<void>;
  /** Deletes one folder-qualified file (cache + disk); absent files are a no-op. */
  remove(file: string): Promise<void>;
  /** Lists the file names in one known folder ("config" | "palettes"), sorted. */
  list(folder: string): Promise<string[]>;
};

// The probe must be a valid storage file name (the Rust side rejects leading
// dots), so no dotfile sneakiness in the install folder.
const STORAGE_PROBE_FILE = 'storage-write-test.json';

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function createTauriFileStore(invoke: TauriInvoke, location: TauriStorageLocation, dir: string): TauriFileStore {
  const cache = new Map<string, string>();

  async function preload(file: string): Promise<string | null> {
    const contents = await invoke<string | null>('read_app_data', { location, file });
    if (contents !== null) cache.set(file, contents);
    return contents;
  }

  async function write(file: string, contents: string): Promise<void> {
    cache.set(file, contents);
    await invoke('write_app_data', { location, file, contents });
  }

  async function remove(file: string): Promise<void> {
    cache.delete(file);
    await invoke('remove_app_data', { location, file });
  }

  async function list(folder: string): Promise<string[]> {
    return invoke<string[]>('list_app_data', { location, folder });
  }

  return { location, dir, preload, write, remove, list };
}

/**
 * Initializes the desktop data store: probes the installation folder's
 * writability with a real write+delete, falling back to the app-data dir when
 * it is read-only. Returns null in the plain browser (the web build keeps
 * localStorage). The caller must show the returned `location`/`dir` to the
 * user when the fallback is in use  the probe never fails silently.
 */
export async function initTauriFileStore(): Promise<TauriFileStore | null> {
  if (!isTauriApp()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  let location: TauriStorageLocation = 'install';
  try {
    await invoke('write_app_data', { location: 'install', file: STORAGE_PROBE_FILE, contents: '' });
  } catch {
    location = 'appdata';
  }
  if (location === 'install') {
    // The write is what proves writability; a failed cleanup just logs so the
    // probe leaves no stray file behind without losing the install folder.
    try {
      await invoke('remove_app_data', { location: 'install', file: STORAGE_PROBE_FILE });
    } catch (error) {
      console.error('Could not remove the storage probe file.', error);
    }
  }
  let dir: string = location;
  try {
    dir = await invoke<string>('app_storage_dir', { location });
  } catch {
    // The directory resolution is only for the user-facing notice; the store
    // itself still works. Keep the location label rather than failing boot.
  }
  return createTauriFileStore(invoke, location, dir);
}
