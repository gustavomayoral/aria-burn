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

/// A file name for a calibration record: plain, no path separators, no leading dot.
fn calibration_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Writes one file of a user calibration record (BURN-15: photo, G-code, machine
/// profile, fit) to `<app data>/calibrations/<id>/<name>` and returns its path.
/// The bytes are the raw invoke body; the record id and file name are the
/// `x-calibration-id` and `x-file-name` headers.
#[tauri::command]
pub fn calibration_save(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    use tauri::{Manager, ipc::InvokeBody};
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let (id, name) = (header("x-calibration-id"), header("x-file-name"));
    if !calibration_name_ok(&id) || !calibration_name_ok(&name) {
        return Err(format!("Bad calibration record name {id:?}/{name:?}"));
    }
    let InvokeBody::Raw(bytes) = request.body() else { return Err("Calibration body must be raw bytes".into()) };
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("calibrations").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
    let path = dir.join(&name);
    std::fs::write(&path, bytes).map_err(|e| format!("Can't write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_record_names() {
        assert!(calibration_name_ok("cal-birch-2026-11-06"));
        assert!(calibration_name_ok("photo.jpg"));
        assert!(!calibration_name_ok("../escape"));
        assert!(!calibration_name_ok("a/b"));
        assert!(!calibration_name_ok(".hidden"));
        assert!(!calibration_name_ok(""));
    }

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

    /// The Rust half of BURN-31's end-to-end test (`src/lib/machine-pick.test.ts`
    /// writes the profiles): the machine picked in the settings screen sets the
    /// planner's timing. Same G-code, two picked machines, different duration
    /// and energy, and every `$` setting the emulator reports follows the pick.
    #[test]
    fn picked_machines_change_planner_timing() {
        let json = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/fixtures/picked-machines.json"),
        )
        .unwrap();
        let picked: std::collections::BTreeMap<String, MachineProfile> = serde_json::from_str(&json).unwrap();
        let (default, falcon) = (&picked["default"], &picked["falcon2"]);
        // Long rapids and a cut faster than the default's $110 limit, then a square at engraving feed.
        let gcode = b"G21 G90\nM4 S0\nG0 X300 Y200\nG1 X100 Y200 F20000 S600\nG0 X0 Y0\nG1 X10 F1200 S600\nG1 Y10\nG1 X0\nG1 Y0\nM5\n";
        let run = |p: &MachineProfile| {
            let settings = GrblSettings::new(p.clone());
            let job = parse_file("picked.gcode", gcode, &settings);
            assert!(!has_errors(&job), "{:?}", job.diagnostics);
            let totals = plan_batches(1, &job, &settings, |_| true).unwrap();
            (settings, totals)
        };
        let (s_default, t_default) = run(default);
        let (s_falcon, t_falcon) = run(falcon);
        assert!(
            t_falcon.duration_s < t_default.duration_s * 0.8,
            "{} s vs {} s",
            t_falcon.duration_s,
            t_default.duration_s
        );
        // 40 W against 10 W, for less time.
        assert!(t_falcon.energy_j > 2.0 * t_default.energy_j, "{} J vs {} J", t_falcon.energy_j, t_default.energy_j);
        for n in [110, 111, 120, 121, 130, 131] {
            let expected = match n {
                110 => falcon.max_rate_mm_per_min.x,
                111 => falcon.max_rate_mm_per_min.y,
                120 => falcon.accel_mm_per_s2.x,
                121 => falcon.accel_mm_per_s2.y,
                130 => falcon.travel_mm.x,
                _ => falcon.travel_mm.y,
            };
            assert_eq!(s_falcon.get(n), Some(expected), "${n}");
        }
        assert_ne!(s_falcon.get(110), s_default.get(110));
    }

    /// BURN-32: every calibration pattern for every catalog frame + module and
    /// provisional material (written by `src/lib/calibration-patterns.test.ts`)
    /// parses with no diagnostics (but the v1 pause / Z warnings the core
    /// predicts for the focus pattern, BURN-47) into the moves the core's job-model twin
    /// predicts, and the GRBL planner keeps every sample on the bed.
    #[test]
    fn calibration_patterns_parse_and_plan_clean() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/calibration-patterns");
        let index = std::fs::read_to_string(dir.join("index.json")).unwrap_or_else(|e| {
            panic!(
                "{}: {e}. The patterns are generated by vitest: run `pnpm test` (or `pnpm check`) first.",
                dir.display()
            )
        });
        let index: serde_json::Value = serde_json::from_str(&index).unwrap();
        let profiles: std::collections::BTreeMap<String, MachineProfile> =
            serde_json::from_value(index["profiles"].clone()).unwrap();
        let jobs = index["jobs"].as_array().unwrap();
        assert!(jobs.len() >= profiles.len() * 9, "{} patterns for {} machines", jobs.len(), profiles.len());
        // One check per pattern, spread over the cores (a debug-build planner takes ~80 s for all of them on one).
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
        let failures: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = jobs
                .chunks(jobs.len().div_ceil(threads))
                .map(|chunk| {
                    scope.spawn(|| chunk.iter().flat_map(|e| check_pattern(&dir, &profiles, e)).collect::<Vec<_>>())
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
        });
        assert!(failures.is_empty(), "{} of {} patterns:\n{}", failures.len(), jobs.len(), failures.join("\n"));
    }

    fn check_pattern(
        dir: &Path,
        profiles: &std::collections::BTreeMap<String, MachineProfile>,
        entry: &serde_json::Value,
    ) -> Vec<String> {
        let mut failures = Vec::new();
        {
            let file = entry["file"].as_str().unwrap();
            let profile = &profiles[entry["machine"].as_str().unwrap()];
            let bed = (entry["bedMm"]["x"].as_f64().unwrap(), entry["bedMm"]["y"].as_f64().unwrap());
            assert!(bed.0 <= profile.travel_mm.x && bed.1 <= profile.travel_mm.y, "{file}: bed larger than travel");
            let settings = GrblSettings::new(profile.clone());
            let job = parse_file(file, &std::fs::read(dir.join(file)).unwrap(), &settings);
            // Only the v1 warnings the core predicts (BURN-47's focus pattern pauses or steps Z), at the same lines.
            let got: Vec<(String, u64)> =
                job.diagnostics.iter().map(|d| (d.code.to_string(), u64::from(d.line))).collect();
            let want: Vec<(String, u64)> = entry["diagnostics"]
                .as_array()
                .map(|a| {
                    a.iter().map(|d| (d["code"].as_str().unwrap().to_string(), d["line"].as_u64().unwrap())).collect()
                })
                .unwrap_or_default();
            if got != want {
                failures.push(format!("{file}: diagnostics {:?}, the core predicts {want:?}", job.diagnostics));
                return failures;
            }
            if job.moves.len() as u64 != entry["moveCount"].as_u64().unwrap() {
                failures.push(format!("{file}: {} moves, the core predicts {}", job.moves.len(), entry["moveCount"]));
            }
            let burn = job.burn_bounds.as_ref().expect("a pattern burns");
            let want = &entry["burnBounds"];
            for (got, key) in [
                (burn.min_x_mm, "minXMm"),
                (burn.min_y_mm, "minYMm"),
                (burn.max_x_mm, "maxXMm"),
                (burn.max_y_mm, "maxYMm"),
            ] {
                if (got - want[key].as_f64().unwrap()).abs() > 1e-9 {
                    failures.push(format!("{file}: burn bounds {key} {got} vs {}", want[key]));
                }
            }
            let mut beam_on_mm = 0.0;
            let mut prev = (0.0, 0.0);
            for m in &job.moves {
                if aria_burn_gcode::beam_on(m) {
                    beam_on_mm += (m.x_mm - prev.0).hypot(m.y_mm - prev.1);
                }
                prev = (m.x_mm, m.y_mm);
            }
            let want_mm = entry["beamOnMm"].as_f64().unwrap();
            if (beam_on_mm - want_mm).abs() > 1e-6 * want_mm.max(1.0) {
                failures.push(format!("{file}: beam on for {beam_on_mm} mm, the core predicts {want_mm}"));
            }
            let (mut off_bed, mut energy) = (0usize, 0.0);
            let duration = plan_job(&job, &settings, &mut |_, s| {
                let (x, y) = (s.x_mm as f64, s.y_mm as f64);
                // f32 sample positions: allow their rounding.
                if x < -1e-3 || y < -1e-3 || x > bed.0 + 1e-3 || y > bed.1 + 1e-3 {
                    off_bed += 1;
                }
                energy += s.power_w as f64 * s.dt_s as f64;
            });
            if off_bed > 0 {
                failures.push(format!("{file}: {off_bed} planned samples off the {} × {} mm bed", bed.0, bed.1));
            }
            if !(duration > 0.0 && energy > 0.0) {
                failures.push(format!("{file}: planned {duration} s, {energy} J"));
            }
        }
        failures
    }

    /// BURN-51: SVG import jobs (written by `src/lib/svg-jobs.test.ts`): every
    /// SVG fixture of the core at a few placements and layer setups on every
    /// catalog frame. The core writes the G-code and the JobModel together; the
    /// parser must make exactly that JobModel of the G-code (moves, passes and
    /// their layer labels, diagnostics), and the GRBL planner must keep every
    /// sample on the bed.
    #[test]
    fn svg_jobs_parse_into_the_core_job_model() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/svg-jobs");
        let index = std::fs::read_to_string(dir.join("index.json")).unwrap_or_else(|e| {
            panic!("{}: {e}. The jobs are generated by vitest: run `pnpm test` (or `pnpm check`) first.", dir.display())
        });
        let index: serde_json::Value = serde_json::from_str(&index).unwrap();
        let profiles: std::collections::BTreeMap<String, MachineProfile> =
            serde_json::from_value(index["profiles"].clone()).unwrap();
        let jobs = index["jobs"].as_array().unwrap();
        assert!(jobs.len() >= profiles.len() * 30, "{} SVG jobs for {} machines", jobs.len(), profiles.len());
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
        let failures: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = jobs
                .chunks(jobs.len().div_ceil(threads))
                .map(|chunk| {
                    scope.spawn(|| chunk.iter().flat_map(|e| check_svg_job(&dir, &profiles, e)).collect::<Vec<_>>())
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
        });
        assert!(failures.is_empty(), "{} of {} SVG jobs:\n{}", failures.len(), jobs.len(), failures.join("\n"));
    }

    fn check_svg_job(
        dir: &Path,
        profiles: &std::collections::BTreeMap<String, MachineProfile>,
        entry: &serde_json::Value,
    ) -> Vec<String> {
        let file = entry["file"].as_str().unwrap();
        let profile = &profiles[entry["machine"].as_str().unwrap()];
        let bed = (entry["bedMm"]["x"].as_f64().unwrap(), entry["bedMm"]["y"].as_f64().unwrap());
        let want: JobModel =
            serde_json::from_str(&std::fs::read_to_string(dir.join(entry["job"].as_str().unwrap())).unwrap()).unwrap();
        let settings = GrblSettings::new(profile.clone());
        let got = parse_file(file, &std::fs::read(dir.join(file)).unwrap(), &settings);

        let diagnostics = |j: &JobModel| j.diagnostics.iter().map(|d| (d.code.to_string(), d.line)).collect::<Vec<_>>();
        if diagnostics(&got) != diagnostics(&want) {
            return vec![format!("{file}: diagnostics {:?}, the core predicts {:?}", got.diagnostics, want.diagnostics)];
        }
        if got.source.line_count != want.source.line_count {
            return vec![format!("{file}: {} lines, the core predicts {}", got.source.line_count, want.source.line_count)];
        }
        if got.moves.len() != want.moves.len() {
            return vec![format!("{file}: {} moves, the core predicts {}", got.moves.len(), want.moves.len())];
        }
        // Exact: the core writes each coordinate as the decimal the parser reads back.
        for (i, (g, w)) in got.moves.iter().zip(&want.moves).enumerate() {
            let same = g.kind == w.kind
                && g.laser == w.laser
                && g.line == w.line
                && g.x_mm == w.x_mm
                && g.y_mm == w.y_mm
                && g.feed_mm_per_min == w.feed_mm_per_min
                && g.s == w.s
                && g.arc.unwrap_or(false) == w.arc.unwrap_or(false);
            if !same {
                return vec![format!("{file}: move {i} is {g:?}, the core predicts {w:?}")];
            }
        }
        let passes = |j: &JobModel| {
            j.passes.iter().map(|p| (p.index, p.first_move, p.move_count, p.label.clone())).collect::<Vec<_>>()
        };
        if passes(&got) != passes(&want) {
            return vec![format!("{file}: passes {:?}, the core predicts {:?}", got.passes, want.passes)];
        }
        let (Some(g), Some(w)) = (&got.burn_bounds, &want.burn_bounds) else {
            return vec![format!("{file}: burn bounds {:?}, the core predicts {:?}", got.burn_bounds, want.burn_bounds)];
        };
        if (g.min_x_mm, g.min_y_mm, g.max_x_mm, g.max_y_mm) != (w.min_x_mm, w.min_y_mm, w.max_x_mm, w.max_y_mm) {
            return vec![format!("{file}: burn bounds {g:?}, the core predicts {w:?}")];
        }

        let mut failures = Vec::new();
        let (mut off_bed, mut energy) = (0usize, 0.0);
        let duration = plan_job(&got, &settings, &mut |_, s| {
            let (x, y) = (s.x_mm as f64, s.y_mm as f64);
            // f32 sample positions: allow their rounding.
            if x < -1e-3 || y < -1e-3 || x > bed.0 + 1e-3 || y > bed.1 + 1e-3 {
                off_bed += 1;
            }
            energy += s.power_w as f64 * s.dt_s as f64;
        });
        if off_bed > 0 {
            failures.push(format!("{file}: {off_bed} planned samples off the {} × {} mm bed", bed.0, bed.1));
        }
        if !(duration > 0.0 && energy > 0.0) {
            failures.push(format!("{file}: planned {duration} s, {energy} J"));
        }
        failures
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
