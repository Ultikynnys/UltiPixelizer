/// The desktop shell is deliberately minimal: UltiPixelizer is a pure
/// client-side web app (no native IPC), so the builder only needs to mount the
/// web assets from ../dist (see tauri.conf.json -> build.frontendDist).
pub fn run() {
    tauri::Builder::default()
        .on_navigation(|url| {
            // Pure client-side app: never navigate away from the bundled page.
            // This is the hard stop for the webview's default action when a
            // file is dropped onto a non-drop area, which would otherwise open
            // the file inside the window. Downloads use blob:/data: anchors
            // with the download attribute and never hit this path.
            matches!(url.scheme(), "http" | "https" | "tauri" | "blob" | "data" | "about")
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
