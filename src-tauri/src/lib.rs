// SPDX-License-Identifier: GPL-3.0-or-later
//! Aria Burn desktop shell. Owns the machine side (G-code parser, GRBL
//! emulator and planner) and streams to the webview over Tauri Channels.

mod bench;
mod emulator;
mod job;
mod migrate;
mod project;
mod smoke;
mod stream;

use std::sync::Arc;

use aria_burn_contract::ChannelEvent;
use tauri::Manager;
use tauri::ipc::{Channel, InvokeResponseBody};

pub use stream::{StreamRequest, StreamTotals};

/// Streams the dummy job: JSON contract events on `events`, binary sample
/// batches on `batches`. Runs on a worker thread; resolves when all is queued.
#[tauri::command]
async fn start_dummy_stream(
    request: StreamRequest,
    events: Channel<ChannelEvent>,
    batches: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stream::stream_to_webview(request, &events, &batches).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let smoke = smoke::SmokeMode::from_env();
    if let Some(mode) = &smoke {
        mode.start_watchdog();
    }
    let bench_url = bench::url_from_env();
    let context = tauri::generate_context!();
    // Before the window exists: WebView2 opens its profile under the identifier's folder.
    migrate::run(&context.config().identifier);
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| {
            #[cfg(target_os = "macos")]
            return project::app_menu(app);
            #[cfg(not(target_os = "macos"))]
            tauri::menu::Menu::default(app)
        })
        .setup(move |app| {
            if let Some(url) = bench_url.clone() {
                bench::open(app, url)?;
            }
            Ok(())
        })
        .manage(smoke)
        .manage(Arc::new(emulator::EmulatorState::default()))
        .manage(Arc::new(job::JobState::default()))
        .manage(project::UnsavedState::default())
        .on_menu_event(|app, event| {
            if event.id() == project::QUIT_MENU_ID {
                project::quit_from_menu(app);
            }
        })
        .on_window_event(|window, event| {
            // Closing the window with unsaved project changes asks first (BURN-55).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && project::intercept_quit(window.app_handle())
            {
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_dummy_stream,
            smoke::smoke_config,
            smoke::smoke_report,
            emulator::emulator_subscribe,
            emulator::emulator_configure,
            job::job_open,
            job::launch_file,
            job::read_text_file,
            job::export_save,
            job::calibration_save,
            project::project_write,
            project::project_read,
            project::set_unsaved,
            project::app_quit
        ])
        .build(context)
        .expect("error while building Aria Burn")
        .run(|app, event| {
            // Quit (Cmd+Q, the app menu) with unsaved project changes asks first;
            // `app_quit` exits with a code, which isn't stopped.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event
                && project::intercept_quit(app)
            {
                api.prevent_exit();
            }
        });
}
