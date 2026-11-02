// SPDX-License-Identifier: GPL-3.0-or-later
//! Dummy motion-sample stream: stands in for the GRBL planner port (COD-255)
//! until it lands, so the Rust → webview path can be exercised end to end.
//!
//! Samples go out as binary batches (sample-batch layout) on one Channel and
//! contract events (plan.started / plan.done) as JSON on another, per COD-252:
//! batched, never one message per G-code line.

use aria_burn_contract::{
    ChannelEvent, Event, PlanDoneEvent, PlanDoneEventType, PlanStartedEvent, PlanStartedEventType,
    sample_batch::{self, MotionSample, SAMPLE_BATCH_MAX_SAMPLES, SampleBatchHeader},
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

/// Raster parameters of the dummy job: a serpentine fill of a 40 × 30 mm area.
const ORIGIN_MM: (f32, f32) = (10.0, 10.0);
const WIDTH_MM: f32 = 40.0;
const LINE_SPACING_MM: f32 = 0.1;
const SPEED_MM_PER_S: f32 = 50.0;
const DT_S: f32 = 0.0005;
const MAX_POWER_W: f32 = 10.0;
const SPOT_SIGMA_MM: f64 = 0.03;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamRequest {
    pub job_id: u32,
    pub batch_count: u32,
    pub samples_per_batch: u32,
    /// Delay between batches; `None` sends as fast as the IPC allows.
    #[serde(default)]
    pub pace_ms: Option<u64>,
}

impl StreamRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.batch_count == 0 {
            return Err("batchCount must be at least 1".into());
        }
        if self.samples_per_batch == 0 || self.samples_per_batch as usize > SAMPLE_BATCH_MAX_SAMPLES {
            return Err(format!("samplesPerBatch must be 1..={SAMPLE_BATCH_MAX_SAMPLES}"));
        }
        Ok(())
    }
}

/// What the stream sent; mirrors plan.done so the webview can check it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StreamTotals {
    pub batch_count: u32,
    pub sample_count: u32,
    pub energy_j: f64,
    pub duration_s: f64,
}

/// Sample `index` of the dummy job: deterministic, so both ends can agree.
pub fn dummy_sample(index: u64) -> MotionSample {
    let step_mm = SPEED_MM_PER_S * DT_S;
    let per_row = (WIDTH_MM / step_mm) as u64;
    let row = index / per_row;
    let col = index % per_row;
    // Serpentine: odd rows run right to left.
    let along = if row.is_multiple_of(2) { col } else { per_row - 1 - col };
    let x = ORIGIN_MM.0 + (along as f32 + 0.5) * step_mm;
    let y = ORIGIN_MM.1 + row as f32 * LINE_SPACING_MM;
    // Power pattern: concentric rings around the area's centre.
    let (cx, cy) = (ORIGIN_MM.0 + WIDTH_MM / 2.0, ORIGIN_MM.1 + 15.0);
    let r = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
    let ring = 0.5 + 0.5 * (r * 0.8).cos();
    MotionSample {
        t_rel_s: 0.0, // filled per batch
        x_mm: x,
        y_mm: y,
        dt_s: DT_S,
        speed_mm_per_s: SPEED_MM_PER_S,
        power_w: MAX_POWER_W * ring,
        line: row as u32 + 1,
    }
}

/// Builds batch `sequence` of the job into `out` (reused between batches).
pub fn dummy_batch(req: &StreamRequest, sequence: u32, out: &mut Vec<MotionSample>) -> SampleBatchHeader {
    let n = req.samples_per_batch as u64;
    let first = sequence as u64 * n;
    let t0_s = first as f64 * DT_S as f64;
    out.clear();
    out.extend((0..n).map(|i| {
        let mut s = dummy_sample(first + i);
        s.t_rel_s = (i as f32 + 0.5) * DT_S;
        s
    }));
    SampleBatchHeader { sequence, t0_s, job_id: req.job_id, last: sequence + 1 == req.batch_count }
}

/// Generates and encodes every batch, handing each encoded buffer to `send`.
pub fn run_stream(
    req: &StreamRequest,
    mut send: impl FnMut(Vec<u8>) -> Result<(), String>,
) -> Result<StreamTotals, String> {
    req.validate()?;
    let mut samples = Vec::with_capacity(req.samples_per_batch as usize);
    let mut totals = StreamTotals::default();
    for sequence in 0..req.batch_count {
        let header = dummy_batch(req, sequence, &mut samples);
        // Same order and precision as the webview's check: f32 fields, f64 sum.
        for s in &samples {
            totals.energy_j += s.power_w as f64 * s.dt_s as f64;
        }
        totals.sample_count += samples.len() as u32;
        totals.batch_count += 1;
        send(sample_batch::encode_sample_batch(&header, &samples))?;
        if let Some(ms) = req.pace_ms {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
    }
    totals.duration_s = totals.sample_count as f64 * DT_S as f64;
    Ok(totals)
}

/// Streams the dummy job to the webview. Returns once everything is queued.
pub fn stream_to_webview(
    req: StreamRequest,
    events: &Channel<ChannelEvent>,
    batches: &Channel<InvokeResponseBody>,
) -> Result<StreamTotals, String> {
    req.validate()?;
    let mut seq = 0u32;
    let mut emit = |event: Event| {
        let msg = ChannelEvent { seq, event };
        seq += 1;
        events.send(msg).map_err(|e| e.to_string())
    };
    emit(Event::PlanStartedEvent(PlanStartedEvent {
        type_: PlanStartedEventType::PlanStarted,
        job_id: req.job_id,
        grid_pitch_mm: SPOT_SIGMA_MM / 3.0,
        dt_max_s: DT_S as f64,
    }))?;
    let totals = run_stream(&req, |bytes| batches.send(InvokeResponseBody::Raw(bytes)).map_err(|e| e.to_string()))?;
    emit(Event::PlanDoneEvent(PlanDoneEvent {
        type_: PlanDoneEventType::PlanDone,
        job_id: req.job_id,
        duration_s: totals.duration_s,
        batch_count: totals.batch_count,
        sample_count: totals.sample_count,
        energy_j: totals.energy_j,
    }))?;
    Ok(totals)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn req(batch_count: u32, samples_per_batch: u32) -> StreamRequest {
        StreamRequest { job_id: 1, batch_count, samples_per_batch, pace_ms: None }
    }

    #[test]
    fn batches_decode_and_are_contiguous() {
        let mut decoded = Vec::new();
        let totals = run_stream(&req(5, 1000), |bytes| {
            decoded.push(sample_batch::decode_sample_batch(&bytes).map_err(|e| e.to_string())?);
            Ok(())
        })
        .unwrap();
        assert_eq!(totals.batch_count, 5);
        assert_eq!(totals.sample_count, 5000);
        for (i, (header, samples)) in decoded.iter().enumerate() {
            assert_eq!(header.sequence, i as u32);
            assert_eq!(header.last, i == 4);
            assert_eq!(samples.len(), 1000);
        }
        let energy: f64 = decoded.iter().flat_map(|(_, s)| s).map(|s| s.power_w as f64 * s.dt_s as f64).sum();
        assert_eq!(energy, totals.energy_j);
        assert!(totals.energy_j > 0.0);
    }

    #[test]
    fn rejects_bad_requests() {
        assert!(run_stream(&req(0, 10), |_| Ok(())).is_err());
        assert!(run_stream(&req(1, SAMPLE_BATCH_MAX_SAMPLES as u32 + 1), |_| Ok(())).is_err());
    }

    /// Rust half of the throughput smoke test: generating + encoding must stay
    /// far ahead of what the IPC carries (the webview half runs in `pnpm smoke`).
    #[test]
    fn encode_throughput_smoke() {
        let r = req(64, SAMPLE_BATCH_MAX_SAMPLES as u32);
        let start = Instant::now();
        let mut bytes = 0usize;
        run_stream(&r, |b| {
            bytes += b.len();
            Ok(())
        })
        .unwrap();
        let secs = start.elapsed().as_secs_f64();
        let mb_s = bytes as f64 / 1e6 / secs;
        eprintln!("encode: {:.1} MB in {:.3}s = {mb_s:.0} MB/s", bytes as f64 / 1e6, secs);
        // Debug builds on CI runners are slow; this only catches pathological regressions.
        assert!(mb_s > 20.0, "encode throughput {mb_s:.1} MB/s");
    }
}
