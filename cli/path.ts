/**
 * Separator-agnostic path helpers for the CLI core.
 *
 * The shared CLI runs in two hosts: Node (tests) and the Tauri webview (the
 * shipped built-in CLI). `node:path` is unavailable in the webview, so these
 * pure string helpers replace it. Both `/` and `\` are treated as separators
 * (the webview receives native Windows paths from Rust), and results use `/`,
 * which every file API on every platform accepts. Only `resolve` needs the
 * process cwd, so it lives on the host (see host.ts).
 */

export function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Directory part of a path (`/`-separated); `.` when there is no separator. */
export function dirname(path: string): string {
  const s = normalizeSeparators(path);
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}

/** Final path segment, with an optional extension stripped. */
export function basename(path: string, ext?: string): string {
  const s = normalizeSeparators(path);
  let base = s.slice(s.lastIndexOf('/') + 1);
  if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}

/** Extension including the dot (`.`-prefixed), or `''` when there is none. */
export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i) : '';
}

/** Joins path segments with `/` (empty segments dropped, runs collapsed). */
export function join(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .map(normalizeSeparators)
    .join('/')
    .replace(/\/{2,}/g, '/');
}
