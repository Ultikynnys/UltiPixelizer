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
