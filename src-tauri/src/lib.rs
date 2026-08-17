/// The desktop shell is deliberately minimal: UltiPixelizer is a pure
/// client-side web app (no native IPC). The window is created here in Rust —
/// instead of tauri.conf.json — so the navigation guard and the drag-drop
/// handler setting can be attached to the WebviewWindowBuilder.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("UltiPixelizer")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
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
