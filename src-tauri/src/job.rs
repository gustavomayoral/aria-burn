// SPDX-License-Identifier: GPL-3.0-or-later
//! File jobs (COD-259): G-code opened from disk or dropped on the window goes
//! through the same parser (`aria-burn-gcode`) and GRBL planner
//! (`aria-burn-grbl::planner::plan_job`) as a network job, so a file and the
//! same lines streamed over the emulator get identical timing and samples.
//!
//! Event order on the job's own Channels (contract messages.ts, file jobs):
//! `job.loaded` → `plan.started` → sample batches → `plan.done`. A job whose
//! parse has errors stops after `job.loaded` unless the webview asks to plan
//! it anyway: the webview shows the errors instead of a wrong burn.

use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
};

use aria_burn_contract::{
    ChannelEvent, DiagnosticSeverity, Event, JobLoadedEvent, JobLoadedEventType, JobModel, JobSourceKind,
    MachineProfile, PlanDoneEvent, PlanDoneEventType, PlanStartedEvent, PlanStartedEventType,
    sample_batch::{self, MotionSample, SAMPLE_BATCH_MAX_SAMPLES, SampleBatchHeader},
};
use aria_burn_gcode::ParseOptions;
use aria_burn_grbl::{
    GrblSettings,
    planner::{SAMPLE_DT_MAX_S, grid_pitch_mm, plan_job},
};
use serde::Deserialize;
use tauri::{
    State,
    ipc::{Channel, InvokeResponseBody},
};

/// Where the G-code comes from: a path (native file drop) or the text itself
/// (the webview's file picker, which has no path).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum JobInput {
    Path { path: String },
    Text { name: String, text: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
    pub job_id: u32,
    pub input: JobInput,
    /// The machine profile in effect (the webview's settings), i.e. the `$` settings the planner runs.
    pub profile: MachineProfile,
    /// Plan even when the parse reported errors (the failing lines are dropped, as GRBL drops them).
    #[serde(default)]
    pub plan_errors: bool,
}

/// What was planned; mirrors plan.done.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PlanTotals {
    pub batch_count: u32,
    pub sample_count: u32,
    pub energy_j: f64,
    pub duration_s: f64,
}

/// The job being planned; opening another file cancels it.
#[derive(Default)]
pub struct JobState {
    current: AtomicU32,
}

/// Parses G-code bytes with the arc tolerance the profile's `$12` sets.
pub fn parse_file(name: &str, bytes: &[u8], settings: &GrblSettings) -> JobModel {
    let opts = ParseOptions { arc_tolerance_mm: settings.arc_tolerance_mm(), ..ParseOptions::default() };
    aria_burn_gcode::parse(JobSourceKind::File, name, bytes, opts)
}

pub fn has_errors(job: &JobModel) -> bool {
    job.diagnostics.iter().any(|d| d.severity == DiagnosticSeverity::Error)
}

/// Plans `job` and hands each encoded batch to `send`, which returns false to
/// stop (the job was cancelled). Batches are full except the last, which is
/// flagged `last` and may be empty.
pub fn plan_batches(
    job_id: u32,
    job: &JobModel,
    settings: &GrblSettings,
    mut send: impl FnMut(Vec<u8>) -> bool,
) -> Option<PlanTotals> {
    let mut totals = PlanTotals::default();
    let mut buf: Vec<MotionSample> = Vec::with_capacity(SAMPLE_BATCH_MAX_SAMPLES);
    let mut t0 = 0.0;
    let mut open = true;
    let mut flush = |buf: &mut Vec<MotionSample>, t0: f64, last: bool, totals: &mut PlanTotals| {
        let header = SampleBatchHeader { sequence: totals.batch_count, t0_s: t0, job_id, last };
        totals.batch_count += 1;
        let ok = send(sample_batch::encode_sample_batch(&header, buf));
        buf.clear();
        ok
    };
    totals.duration_s = plan_job(job, settings, &mut |t, mut s| {
        if !open {
            return;
        }
        if buf.is_empty() {
            t0 = t;
        }
        s.t_rel_s = (t - t0) as f32;
        // Same order and precision as the webview's check: f32 fields, f64 sum.
        totals.energy_j += s.power_w as f64 * s.dt_s as f64;
        totals.sample_count += 1;
        buf.push(s);
        if buf.len() == SAMPLE_BATCH_MAX_SAMPLES {
            open = flush(&mut buf, t0, false, &mut totals);
        }
    });
    if !open || !flush(&mut buf, t0, true, &mut totals) {
        return None;
    }
    Some(totals)
}

/// Reads, parses and plans one file job onto the given Channels.
pub fn open_job(
    state: &JobState,
    req: OpenRequest,
    events: &Channel<ChannelEvent>,
    batches: &Channel<InvokeResponseBody>,
) -> Result<(), String> {
    state.current.store(req.job_id, Ordering::SeqCst);
    let (name, bytes) = match req.input {
        JobInput::Path { path } => {
            let name = Path::new(&path).file_name().map_or_else(|| path.clone(), |n| n.to_string_lossy().into_owned());
            let bytes = std::fs::read(&path).map_err(|e| format!("Can't read {name}: {e}"))?;
            (name, bytes)
        }
        JobInput::Text { name, text } => (name, text.into_bytes()),
    };
    let settings = GrblSettings::new(req.profile);
    let job = parse_file(&name, &bytes, &settings);
    let mut seq = 0u32;
    let mut emit = |event: Event| {
        let msg = ChannelEvent { seq, event };
        seq += 1;
        events.send(msg).map_err(|e| e.to_string())
    };
    let plan = job.burn_bounds.is_some() && (req.plan_errors || !has_errors(&job));
    emit(Event::JobLoadedEvent(JobLoadedEvent {
        type_: JobLoadedEventType::JobLoaded,
        job_id: req.job_id,
        job: job.clone(),
    }))?;
    if !plan {
        return Ok(());
    }
    emit(Event::PlanStartedEvent(PlanStartedEvent {
        type_: PlanStartedEventType::PlanStarted,
        job_id: req.job_id,
        grid_pitch_mm: grid_pitch_mm(settings.profile()),
        dt_max_s: SAMPLE_DT_MAX_S,
    }))?;
    let current = || state.current.load(Ordering::SeqCst) == req.job_id;
    let totals = plan_batches(req.job_id, &job, &settings, |bytes| {
        current() && batches.send(InvokeResponseBody::Raw(bytes)).is_ok()
    });
    // Cancelled by a newer open: the webview has already moved on.
    let Some(totals) = totals else { return Ok(()) };
    emit(Event::PlanDoneEvent(PlanDoneEvent {
        type_: PlanDoneEventType::PlanDone,
        job_id: req.job_id,
        duration_s: totals.duration_s,
        batch_count: totals.batch_count,
        sample_count: totals.sample_count,
        energy_j: totals.energy_j,
    }))
}

/// Opens a G-code file job: parse, plan with the GRBL planner, stream to the
/// webview. Runs on a worker thread; resolves once everything is queued.
#[tauri::command]
pub async fn job_open(
    state: State<'_, Arc<JobState>>,
    request: OpenRequest,
    events: Channel<ChannelEvent>,
    batches: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || open_job(&state, request, &events, &batches))
        .await
        .map_err(|e| e.to_string())?
}

/// A G-code file to open at startup: the first command-line argument (open
/// with / drag onto the app icon), or `ARIA_BURN_OPEN` for scripted runs.
#[tauri::command]
pub fn launch_file() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|a| !a.starts_with('-'))
        .or_else(|| std::env::var("ARIA_BURN_OPEN").ok())
        .filter(|p| !p.is_empty())
}

/// Writes an exported image to the user's Downloads folder and returns its path.
/// The bytes are the raw invoke body; the file name is the `x-export-name` header.
#[tauri::command]
pub fn export_save(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    use tauri::{Manager, ipc::InvokeBody};
    let name = request.headers().get("x-export-name").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(format!("Bad export file name {name:?}"));
    }
    let InvokeBody::Raw(bytes) = request.body() else { return Err("Export body must be raw bytes".into()) };
    let path = app.path().download_dir().map_err(|e| e.to_string())?.join(name);
    std::fs::write(&path, bytes).map_err(|e| format!("Can't write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> MachineProfile {
        let json = std::fs::read_to_string(
            Path::new(aria_burn_contract::CONTRACT_DIR).join("../profiles/provisional/machine-10w-diode.json"),
        )
        .unwrap();
        serde_json::from_str(&json).unwrap()
    }

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/aria-burn-gcode/tests/corpus").join(name))
            .unwrap()
    }

    fn decode(batches: &[Vec<u8>]) -> Vec<(f64, MotionSample)> {
        batches
            .iter()
            .flat_map(|b| {
                let (h, samples) = sample_batch::decode_sample_batch(b).unwrap();
                samples.into_iter().map(move |s| (h.t0_s + s.t_rel_s as f64, s))
            })
            .collect()
    }

    #[test]
    fn file_job_batches_match_plan_job() {
        let settings = GrblSettings::new(profile());
        let job = parse_file("lightburn-raster.gcode", &corpus("lightburn-raster.gcode"), &settings);
        assert!(!has_errors(&job));
        let mut batches = Vec::new();
        let totals = plan_batches(7, &job, &settings, |b| {
            batches.push(b);
            true
        })
        .unwrap();
        let mut direct = Vec::new();
        let duration = plan_job(&job, &settings, &mut |t, s| direct.push((t, s)));
        assert_eq!(totals.duration_s, duration);
        assert_eq!(totals.batch_count as usize, batches.len());
        let decoded = decode(&batches);
        assert_eq!(decoded.len(), direct.len());
        assert_eq!(totals.sample_count as usize, direct.len());
        for ((ta, a), (tb, b)) in decoded.iter().zip(&direct) {
            assert!((ta - tb).abs() < 1e-6 * tb.max(1.0), "t {ta} vs {tb}");
            assert_eq!((a.x_mm, a.y_mm, a.power_w, a.line), (b.x_mm, b.y_mm, b.power_w, b.line));
        }
        let (last, _) = sample_batch::decode_sample_batch(batches.last().unwrap()).unwrap();
        assert!(last.last);
        let energy: f64 = decoded.iter().map(|(_, s)| s.power_w as f64 * s.dt_s as f64).sum();
        assert_eq!(energy, totals.energy_j);
    }

    #[test]
    fn errors_stop_after_job_loaded() {
        let settings = GrblSettings::new(profile());
        let job = parse_file("inches.gcode", &corpus("inches.gcode"), &settings);
        assert!(has_errors(&job), "{:?}", job.diagnostics);
    }

    #[test]
    fn cancel_stops_batches() {
        let settings = GrblSettings::new(profile());
        let job = parse_file("r", &corpus("lightburn-raster.gcode"), &settings);
        let mut sent = 0;
        let r = plan_batches(1, &job, &settings, |_| {
            sent += 1;
            false
        });
        assert!(r.is_none());
        assert_eq!(sent, 1);
    }

    #[test]
    fn request_json() {
        let json = format!(
            r#"{{"jobId":3,"input":{{"kind":"text","name":"a.gcode","text":"G1 X1"}},"profile":{}}}"#,
            serde_json::to_string(&profile()).unwrap()
        );
        let r: OpenRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(r.input, JobInput::Text { name: "a.gcode".into(), text: "G1 X1".into() });
        assert!(!r.plan_errors);
    }
}
