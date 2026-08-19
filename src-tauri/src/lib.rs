use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Desktop app-data storage: settings and palettes live as files in the
/// installation folder (`resource_dir()`, e.g. next to UltiPixelizer.exe), so
/// users can see and back them up where the app is installed. Data is
/// organized in folders: `config/settings.json` and one `palettes/<name>.hex`
/// per custom palette. The webview probes writability at boot and switches to
/// the per-user app-data dir when the install folder isn't writable (Program
/// Files MSI installs, macOS app bundles, Linux AppImage mounts) — surfaced to
/// the user, never silently.
fn storage_dir(app: &tauri::AppHandle, location: &str) -> Result<PathBuf, String> {
    let dir = match location {
        // The install folder: where the executable/resources live.
        "install" => app.path().resource_dir().map_err(|error| error.to_string())?,
        // The per-user app-data dir (e.g. %APPDATA%/<identifier>).
        "appdata" => app.path().app_data_dir().map_err(|error| error.to_string())?,
        _ => return Err("Unknown storage location.".to_string()),
    };
    Ok(dir)
}

/// Storage paths are folder-qualified names: an optional known folder
/// ("config" | "palettes") plus a plain file name. The webview can only ever
/// reference a single file, so no deeper path, separator (backslash or extra
/// slash), dotfile, or Windows-forbidden character can sneak a traversal past
/// this check. Spaces are allowed — palette files are named after the palette
/// ("My Colors.hex").
fn validate_storage_file_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 160 || path.starts_with('.') || path.contains('\\') {
        return Err("Invalid storage file path.".to_string());
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() > 2 {
        return Err("Invalid storage file path.".to_string());
    }
    let file = match segments.as_slice() {
        [name] => *name,
        [folder, name] => {
            if !matches!(*folder, "config" | "palettes") {
                return Err("Invalid storage folder.".to_string());
            }
            *name
        }
        _ => return Err("Invalid storage file path.".to_string()),
    };
    if file.is_empty()
        || file.len() > 120
        || file.starts_with('.')
        || file
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err("Invalid storage file name.".to_string());
    }
    Ok(())
}

fn storage_file_path(app: &tauri::AppHandle, location: &str, file: &str) -> Result<PathBuf, String> {
    validate_storage_file_path(file)?;
    let dir = storage_dir(app, location)?;
    match file.split_once('/') {
        Some((folder, name)) => Ok(dir.join(folder).join(name)),
        None => Ok(dir.join(file)),
    }
}

/// Resolves the storage directory for a location ("install" | "appdata") —
/// used by the webview to tell the user where data actually lives.
#[tauri::command]
fn app_storage_dir(app: tauri::AppHandle, location: String) -> Result<String, String> {
    storage_dir(&app, &location).map(|dir| dir.to_string_lossy().to_string())
}

/// Reads one storage file; None when the file does not exist yet.
#[tauri::command]
fn read_app_data(app: tauri::AppHandle, location: String, file: String) -> Result<Option<String>, String> {
    let path = storage_file_path(&app, &location, &file)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {}", path.display(), error)),
    }
}

/// Writes one storage file (creating the location's directory when needed —
/// the app-data dir does not exist before the first run).
#[tauri::command]
fn write_app_data(app: tauri::AppHandle, location: String, file: String, contents: String) -> Result<(), String> {
    let path = storage_file_path(&app, &location, &file)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {}", parent.display(), error))?;
    }
    fs::write(&path, contents).map_err(|error| format!("Could not write {}: {}", path.display(), error))
}

/// Removes one storage file; absent files are a no-op.
#[tauri::command]
fn remove_app_data(app: tauri::AppHandle, location: String, file: String) -> Result<(), String> {
    let path = storage_file_path(&app, &location, &file)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove {}: {}", path.display(), error)),
    }
}

/// Lists the file names in one known storage folder ("config" | "palettes"),
/// sorted for deterministic loading. An absent folder lists empty — the first
/// palette save creates it.
#[tauri::command]
fn list_app_data(app: tauri::AppHandle, location: String, folder: String) -> Result<Vec<String>, String> {
    if !matches!(folder.as_str(), "config" | "palettes") {
        return Err("Unknown storage folder.".to_string());
    }
    let dir = storage_dir(&app, &location)?.join(&folder);
    let mut names: Vec<String> = Vec::new();
    match fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                if entry.file_type().map(|file_type| file_type.is_file()).unwrap_or(false) {
                    names.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not list {}: {}", dir.display(), error)),
    }
    names.sort();
    Ok(names)
}

/// The desktop shell is deliberately minimal: UltiPixelizer is a pure
/// client-side web app — the only IPC is the install-folder data store below.
/// The window is created here in Rust — instead of tauri.conf.json — so the
/// navigation guard and the drag-drop handler setting can be attached to the
/// WebviewWindowBuilder.
pub fn run() {
    tauri::Builder::default()
        // Plugins behind the desktop-only behaviors the webview lacks:
        // opener (GitHub/Ko-fi links open in the system browser), dialog +
        // fs (exports go through the native Save dialog instead of the
        // no-op blob-anchor download).
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Commands behind the install-folder data store (settings, palettes).
        .invoke_handler(tauri::generate_handler![
            app_storage_dir,
            read_app_data,
            write_app_data,
            remove_app_data,
            list_app_data
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("UltiPixelizer")
                .inner_size(1440.0, 900.0)
                .min_inner_size(750.0, 480.0)
                .resizable(true)
                // Mirrors the former `dragDropEnabled: false` config: Tauri's
                // own drop handler intercepts OS file drops on Windows, so it
                // must be off for HTML5 drag and drop to reach the frontend.
                .disable_drag_drop_handler()
                .on_navigation(|url| {
                    // Pure client-side app: never navigate away from the bundled
                    // page. This is the hard stop for the webview's default
                    // action when a file is dropped onto a non-drop area, which
                    // would otherwise open the file inside the window. Downloads
                    // use blob:/data: anchors with the download attribute and
                    // never hit this path.
                    matches!(url.scheme(), "http" | "https" | "tauri" | "blob" | "data" | "about")
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
