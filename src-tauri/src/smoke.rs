// SPDX-License-Identifier: GPL-3.0-or-later
//! IPC throughput smoke test, run in the real app (WebView2 on Windows, WKWebView
//! on macOS). With `ARIA_BURN_SMOKE=<batches>` set, the webview streams that many
//! full batches as soon as it loads, checks them against plan.done, reports back,
//! and the process exits 0 (pass) or 1 (fail). A watchdog exits 2 if no report
//! arrives in time, so a hung IPC fails CI instead of stalling it.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::stream::StreamRequest;

const DEFAULT_BATCHES: u32 = 256;
const TIMEOUT: Duration = Duration::from_secs(180);
pub const RESULT_PREFIX: &str = "ARIA_BURN_SMOKE_RESULT ";

pub struct SmokeMode {
    pub request: StreamRequest,
}

impl SmokeMode {
    pub fn from_env() -> Option<Self> {
        let value = std::env::var("ARIA_BURN_SMOKE").ok()?;
        let batch_count = value.trim().parse().ok().filter(|n| *n > 0).unwrap_or(DEFAULT_BATCHES);
        Some(Self {
            request: StreamRequest {
                job_id: 1,
                batch_count,
                samples_per_batch: aria_burn_contract::sample_batch::SAMPLE_BATCH_MAX_SAMPLES as u32,
                pace_ms: None,
            },
        })
    }

    pub fn start_watchdog(&self) {
        std::thread::spawn(|| {
            std::thread::sleep(TIMEOUT);
            println!("{RESULT_PREFIX}{{\"ok\":false,\"error\":\"timed out after {}s\"}}", TIMEOUT.as_secs());
            std::process::exit(2);
        });
    }
}

/// The stream the webview should run, or null outside smoke mode.
#[tauri::command]
pub fn smoke_config(mode: State<'_, Option<SmokeMode>>) -> Option<StreamRequest> {
    mode.as_ref().map(|m| m.request)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeReport {
    pub ok: bool,
    pub batches: u32,
    pub samples: u32,
    pub bytes: u64,
    pub seconds: f64,
    pub mb_per_s: f64,
    pub batches_per_s: f64,
    #[serde(default)]
    pub errors: Vec<String>,
    pub user_agent: String,
}

/// Prints the webview's verdict and exits. Ignored outside smoke mode.
#[tauri::command]
pub fn smoke_report(report: SmokeReport, mode: State<'_, Option<SmokeMode>>, app: tauri::AppHandle) {
    if mode.is_none() {
        return;
    }
    println!("{RESULT_PREFIX}{}", serde_json::to_string(&report).unwrap());
    app.exit(if report.ok { 0 } else { 1 });
}
