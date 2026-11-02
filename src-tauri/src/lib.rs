// SPDX-License-Identifier: GPL-3.0-or-later
//! Laser Sim desktop shell. Owns the machine side (GRBL emulator, planner)
//! and streams to the webview over Tauri Channels.

mod emulator;
mod smoke;
mod stream;

use std::sync::Arc;

use aria_burn_contract::ChannelEvent;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(smoke)
        .manage(Arc::new(emulator::EmulatorState::default()))
        .invoke_handler(tauri::generate_handler![
            start_dummy_stream,
            smoke::smoke_config,
            smoke::smoke_report,
            emulator::emulator_subscribe,
            emulator::emulator_configure
        ])
        .run(tauri::generate_context!())
        .expect("error while running Laser Sim");
}
