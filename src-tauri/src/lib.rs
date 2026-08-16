/// The desktop shell is deliberately minimal: UltiPixelizer is a pure
/// client-side web app (no native IPC), so the builder only needs to mount the
/// web assets from ../dist (see tauri.conf.json -> build.frontendDist).
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
