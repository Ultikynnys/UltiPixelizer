//! Headless CLI mode for the desktop binary.
//!
//! When the executable is launched with command-line arguments, `lib.rs::run`
//! takes this path instead of showing the app window: it opens a **hidden**
//! webview (`cli.html`) that runs the same JS pipeline the GUI uses, and hands
//! the process its input/output through the commands below. This keeps a single
//! artifact — no second Node bundle, no duplicated pipeline or codec/GPU deps.
//!
//! Data flow: `cli_args` delivers argv to the page; the page reads inputs with
//! `cli_read_file`, writes the result with `cli_write_file`, prints through
//! `cli_log` / `cli_error`, and finally calls `cli_exit` so the process returns
//! the pipeline's exit code.

use tauri::{AppHandle, State};

/// Command-line arguments (everything after argv[0]), captured at startup and
/// handed to the hidden CLI webview on request.
pub struct CliArgs(pub Vec<String>);

/// Returns the CLI arguments the process was launched with.
#[tauri::command]
pub fn cli_args(state: State<'_, CliArgs>) -> Vec<String> {
    state.0.clone()
}

/// Reads a file and returns its raw bytes. `tauri::ipc::Response` sends them
/// as an ArrayBuffer (no base64 / JSON-array blow-up), so large textures cross
/// the IPC cheaply.
#[tauri::command]
pub fn cli_read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("Could not read {}: {}", path, error))
}

/// Writes bytes to a file, creating parent directories as needed.
#[tauri::command]
pub fn cli_write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {}", parent.display(), error))?;
    }
    std::fs::write(&path, data).map_err(|error| format!("Could not write {}: {}", path, error))
}

/// Writes one chunk of CLI output to stdout (verbatim  no added newline, so the
/// caller controls line breaks exactly like a normal CLI).
#[tauri::command]
pub fn cli_log(text: String) {
    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// Writes one chunk of CLI diagnostics to stderr (verbatim).
#[tauri::command]
pub fn cli_error(text: String) {
    use std::io::Write;
    let mut err = std::io::stderr();
    let _ = err.write_all(text.as_bytes());
    let _ = err.flush();
}

/// The process working directory, so the page can resolve relative paths the
/// same way a normal CLI would (`std::env::current_dir`).
#[tauri::command]
pub fn cli_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .map_err(|error| format!("Could not resolve the working directory: {}", error))
}

/// Ends the CLI run, exiting the process with `code`.
#[tauri::command]
pub fn cli_exit(app: AppHandle, code: i32) {
    app.exit(code);
}

/// Attaches the process to the console it was launched from so `println!` /
/// `eprintln!` reach the terminal.
///
/// Release desktop builds are GUI-subsystem (`windows_subsystem = "windows"`),
/// so a CLI invocation from a shell owns no console and its stdout is dropped.
/// `AttachConsole(ATTACH_PARENT_PROCESS)` borrows the parent shell's console and
/// the freshly opened `CONOUT$` handle is wired into the std handles *before*
/// any output is written (Rust binds its cached stdio lazily on first use), so
/// subsequent prints land in the terminal. Best-effort: a failure (no parent
/// console) simply leaves output unwritten.
#[cfg(windows)]
pub fn attach_parent_console() {
    use std::ffi::c_void;

    // Minimal Win32 surface — declared inline so no new crate is needed.
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
        fn GetStdHandle(n_std_handle: u32) -> *mut c_void;
        fn SetStdHandle(n_std_handle: u32, handle: *mut c_void) -> i32;
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *mut c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: *mut c_void,
        ) -> *mut c_void;
    }

    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF; // (u32)(-1)
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5; // (u32)(-11)
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4; // (u32)(-12)
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;
    const INVALID_HANDLE_VALUE: *mut c_void = -1isize as *mut c_void;

    unsafe {
        // If a usable stdout was already handed to us (a pipe, or a redirected
        // file from `app > out.png` / `app | grep`), keep it: attaching to the
        // console and rebinding stdout would silently discard that output.
        let existing = GetStdHandle(STD_OUTPUT_HANDLE);
        if !existing.is_null() && existing != INVALID_HANDLE_VALUE {
            return;
        }
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        let name: Vec<u16> = "CONOUT$\0".encode_utf16().collect();
        let handle = CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        );
        if handle != INVALID_HANDLE_VALUE {
            SetStdHandle(STD_OUTPUT_HANDLE, handle);
            SetStdHandle(STD_ERROR_HANDLE, handle);
        }
    }
}

/// Non-Windows hosts inherit the shell's stdio directly; nothing to do.
#[cfg(not(windows))]
pub fn attach_parent_console() {}
