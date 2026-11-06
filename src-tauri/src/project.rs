// SPDX-License-Identifier: GPL-3.0-or-later
//! Aria Burn project files (`.ariaburn`, BURN-55). The webview builds and
//! parses the JSON (aria-burn-core `AriaBurnProject`); Rust only moves the
//! text to and from a path the user picked in a native dialog, and holds the
//! "unsaved changes" flag so closing the window or quitting asks first.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::job::{TEXT_FILE_MAX_BYTES, read_text_capped};

pub const PROJECT_EXTENSION: &str = "ariaburn";

/// Event sent to the webview when the user closes the window or quits with
/// unsaved changes; the webview asks, then calls `app_quit` (or doesn't).
pub const QUIT_REQUESTED_EVENT: &str = "quit-requested";

/// Whether the open project has unsaved changes (set by the webview).
#[derive(Default)]
pub struct UnsavedState(AtomicBool);

impl UnsavedState {
    pub fn get(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

fn has_project_extension(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(PROJECT_EXTENSION))
}

/// Writes project text: `.ariaburn` paths only, through a temporary file and a
/// rename so a failed write never leaves half a project behind.
pub fn write_project(path: &Path, text: &str) -> Result<(), String> {
    if !has_project_extension(path) {
        return Err(format!("{} is not a .{PROJECT_EXTENSION} file", path.display()));
    }
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    let tmp = path.with_extension(format!("{PROJECT_EXTENSION}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| format!("Can't save {name}: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Can't save {name}: {e}")
    })
}

/// Reads project text from a `.ariaburn` path (size-capped like SVGs).
pub fn read_project(path: &Path) -> Result<String, String> {
    if !has_project_extension(path) {
        return Err(format!("{} is not a .{PROJECT_EXTENSION} file", path.display()));
    }
    read_text_capped(path, TEXT_FILE_MAX_BYTES)
}

#[tauri::command]
pub async fn project_write(path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_project(Path::new(&path), &text)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_read(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_project(Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn set_unsaved(state: tauri::State<'_, UnsavedState>, unsaved: bool) {
    state.0.store(unsaved, Ordering::SeqCst);
}

/// Quits without asking again (the webview already asked).
#[tauri::command]
pub fn app_quit(app: AppHandle, state: tauri::State<'_, UnsavedState>) {
    state.0.store(false, Ordering::SeqCst);
    app.exit(0);
}

/// Id of the app menu's Quit item (macOS), which goes through `intercept_quit`.
pub const QUIT_MENU_ID: &str = "aria-burn-quit";

/// Tauri's default menu with its macOS Quit item replaced: the predefined one
/// terminates the app at once (no ExitRequested to stop), so Cmd+Q would skip
/// the unsaved-changes prompt.
#[cfg(target_os = "macos")]
pub fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_submenu)) = menu.items()?.into_iter().next() {
        if let Some(quit) = app_submenu.items()?.into_iter().last() {
            app_submenu.remove(&quit)?;
        }
        let label = format!("Quit {}", app.package_info().name);
        app_submenu.append(&MenuItem::with_id(app, QUIT_MENU_ID, label, true, Some("CmdOrCtrl+Q"))?)?;
    }
    Ok(menu)
}

/// The Quit menu item: ask first with unsaved changes, else quit.
pub fn quit_from_menu(app: &AppHandle) {
    if !intercept_quit(app) {
        app.exit(0);
    }
}

/// Window close or app quit: with unsaved changes, stop it and let the webview ask.
/// Returns true when the close was stopped.
pub fn intercept_quit(app: &AppHandle) -> bool {
    if !app.state::<UnsavedState>().get() {
        return false;
    }
    let _ = app.emit_to("main", QUIT_REQUESTED_EVENT, ());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_ariaburn_files_only() {
        let dir = std::env::temp_dir().join(format!("aria-burn-project-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Job.AriaBurn");
        write_project(&path, "{\"format\":\"aria-burn-project\"}\n").unwrap();
        assert_eq!(read_project(&path).unwrap(), "{\"format\":\"aria-burn-project\"}\n");
        write_project(&path, "{}").unwrap();
        assert_eq!(read_project(&path).unwrap(), "{}");
        assert!(!dir.join("Job.ariaburn.tmp").exists());
        assert!(write_project(&dir.join("job.svg"), "{}").unwrap_err().contains("not a .ariaburn"));
        assert!(read_project(&dir.join("job.json")).unwrap_err().contains("not a .ariaburn"));
        assert!(write_project(&dir.join("missing/job.ariaburn"), "{}").unwrap_err().contains("Can't save"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
