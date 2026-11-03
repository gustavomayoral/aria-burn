// SPDX-License-Identifier: GPL-3.0-or-later
//! The emulated GRBL controller: bytes in from the sender, replies out, plus
//! contract events and sample batches for the webview. No I/O and no clock of
//! its own: the server feeds it bytes and wall time, tests drive it directly.
//!
//! Protocol model (GRBL 1.1):
//! - Real-time bytes (`?` `!` `~` Ctrl-X, 0x80+ overrides) act the moment they
//!   arrive, wherever they sit in the stream; everything else goes to the RX
//!   buffer.
//! - Lines run one at a time, in order. A motion line is answered `ok` once all
//!   its moves are in the planner, so with real-time pacing a full planner
//!   (15 blocks) holds back `ok`s, which is what paces both character-counting
//!   and send-response senders. Instant pacing never fills the planner.
//! - A rejected line gets `error:N` with the parser's GRBL code and changes nothing.
//! - Spindle syncs as in GRBL's `gc_execute_line`: any M3/M4/M5 change, and an
//!   S change while the laser is on unless the line moves in laser mode, stop
//!   motion before the line runs; so does G4, which then dwells.
//! - `!` and jog cancel decelerate along the path (the planner's feed hold).
//! - `$$` reads the emulated settings and `$x=` writes them; writes to profile
//!   settings change the machine profile, which goes to the webview to save.
//!
//! Network jobs: a job opens with the first G-code line after the last job
//! closed, and closes on M2/M30 once motion ends, on Ctrl-X, on disconnect, or
//! after `job_idle_end_s` with nothing to do. The webview hears about a job only
//! once its first beam-on sample exists, so framing or jogging leaves the last
//! preview in place. Then, per the contract: job.streaming → plan.started →
//! batches with job.progress (≤ JOB_PROGRESS_HZ, each after the batches it
//! counts) → [error, if cut short by Ctrl-X or a disconnect] → job.loaded →
//! plan.done.

use std::collections::VecDeque;

use aria_burn_contract::{
    ErrorEvent, ErrorEventCode, ErrorEventType, Event, JobLoadedEvent, JobLoadedEventType, JobModel, JobProgressEvent,
    JobProgressEventType, JobSourceKind, JobStreamingEvent, JobStreamingEventType, LaserMode, MachineProfile,
    MachineState, MachineStatusEvent, MachineStatusEventType, PlanDoneEvent, PlanDoneEventType, PlanStartedEvent,
    PlanStartedEventType, Vec2Mm,
    sample_batch::{self, MotionSample, SAMPLE_BATCH_MAX_SAMPLES, SampleBatchHeader},
};
use aria_burn_gcode::{ParseOptions, Parser};

use crate::planner::{Block, GrblPlanner, Item, Overrides, Planner, SAMPLE_DT_MAX_S, grid_pitch_mm};
use crate::protocol::{self, error, rt};
use crate::settings::{GrblSettings, Written, parse_write};

/// When `ok`s go out.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Pacing {
    /// Motion runs on the wall clock and a full planner holds back `ok`s, as on the machine.
    #[default]
    Realtime,
    /// Every line is answered as soon as it is parsed and motion runs ahead
    /// without waiting for the wall clock, as if the sender kept GRBL's buffers
    /// full. The planner drains when the job ends or the sender goes quiet.
    Instant,
}

#[derive(Clone, Debug)]
pub struct MachineConfig {
    pub pacing: Pacing,
    pub profile: MachineProfile,
    /// Wall time with nothing to do after which an open job closes (s).
    pub job_idle_end_s: f64,
}

impl MachineConfig {
    pub fn new(profile: MachineProfile) -> Self {
        Self { pacing: Pacing::Realtime, profile, job_idle_end_s: 5.0 }
    }
}

/// Something for the webview.
#[derive(Clone, Debug)]
pub enum Output {
    Event(Box<Event>),
    /// One encoded sample batch (contract sample-batch layout).
    Batch(Vec<u8>),
    /// A `$x=` write changed the machine profile.
    Profile(Box<MachineProfile>),
}

/// Longest wall-clock step real-time motion takes at once, so a stalled thread
/// (or a laptop waking up) doesn't jump the job forward.
const MAX_STEP_S: f64 = 0.25;
/// Partial batches go out at least this often (s), so the preview builds live.
const BATCH_FLUSH_S: f64 = 0.05;
/// Instant pacing: wall time without input after which queued motion runs out (s).
const INSTANT_QUIET_S: f64 = 0.2;
/// job.progress interval (s): contract JOB_PROGRESS_HZ = 10.
const PROGRESS_S: f64 = 0.1;
/// Status reports between WCO / Ov fields, as GRBL's refresh counters.
const REPORT_REFRESH: u32 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GrblState {
    Idle,
    Run,
    Hold,
    Jog,
    Alarm,
}

/// A network job being streamed.
struct LiveJob {
    id: u32,
    name: String,
    clock0: f64,
    started: bool,
    sequence: u32,
    buf: Vec<MotionSample>,
    t0: f64,
    batch_age_s: f64,
    progress_age_s: f64,
    sample_count: u32,
    energy_j: f64,
}

impl LiveJob {
    fn new(id: u32, name: String, clock0: f64) -> Self {
        Self {
            id,
            name,
            clock0,
            started: false,
            sequence: 0,
            buf: Vec::new(),
            t0: 0.0,
            batch_age_s: 0.0,
            progress_age_s: 0.0,
            sample_count: 0,
            energy_j: 0.0,
        }
    }

    fn push(&mut self, t: f64, mut s: MotionSample, profile: &MachineProfile, out: &mut Vec<Output>) {
        if !self.started {
            self.started = true;
            out.push(event(Event::JobStreamingEvent(JobStreamingEvent {
                type_: JobStreamingEventType::JobStreaming,
                job_id: self.id,
                name: self.name.clone(),
            })));
            out.push(event(Event::PlanStartedEvent(PlanStartedEvent {
                type_: PlanStartedEventType::PlanStarted,
                job_id: self.id,
                grid_pitch_mm: grid_pitch_mm(profile),
                dt_max_s: SAMPLE_DT_MAX_S,
            })));
        }
        let t_job = t - self.clock0;
        if self.buf.is_empty() {
            self.t0 = t_job;
        }
        s.t_rel_s = (t_job - self.t0) as f32;
        // Same order and precision as the webview's check: f32 fields, f64 sum.
        self.energy_j += s.power_w as f64 * s.dt_s as f64;
        self.sample_count += 1;
        self.buf.push(s);
        if self.buf.len() == SAMPLE_BATCH_MAX_SAMPLES {
            self.flush(false, out);
        }
    }

    fn flush(&mut self, last: bool, out: &mut Vec<Output>) {
        self.batch_age_s = 0.0;
        if !self.started || (self.buf.is_empty() && !last) {
            return;
        }
        let header = SampleBatchHeader { sequence: self.sequence, t0_s: self.t0, job_id: self.id, last };
        out.push(Output::Batch(sample_batch::encode_sample_batch(&header, &self.buf)));
        self.sequence += 1;
        self.buf.clear();
    }

    /// job.progress, after a flush so it never counts batches not yet sent.
    fn progress(&mut self, clock: f64, line_count: u32, out: &mut Vec<Output>) {
        self.progress_age_s = 0.0;
        if !self.started {
            return;
        }
        self.flush(false, out);
        out.push(event(Event::JobProgressEvent(JobProgressEvent {
            type_: JobProgressEventType::JobProgress,
            job_id: self.id,
            planned_s: clock - self.clock0,
            line_count,
            batch_count: self.sequence,
            sample_count: self.sample_count,
            energy_j: self.energy_j,
        })));
    }

    /// Closes the job: last batch, then (if it was cut short) an error, then
    /// job.loaded and plan.done for what was planned.
    fn end(mut self, job: JobModel, clock: f64, abort: Option<Abort>, out: &mut Vec<Output>) {
        if !self.started {
            return;
        }
        self.flush(true, out);
        if let Some(abort) = abort {
            out.push(event(Event::ErrorEvent(ErrorEvent {
                type_: ErrorEventType::Error,
                code: ErrorEventCode::try_from(abort.code()).expect("non-empty"),
                message: abort.message().into(),
                job_id: Some(self.id),
            })));
        }
        out.push(event(Event::JobLoadedEvent(JobLoadedEvent {
            type_: JobLoadedEventType::JobLoaded,
            job_id: self.id,
            job,
        })));
        out.push(event(Event::PlanDoneEvent(PlanDoneEvent {
            type_: PlanDoneEventType::PlanDone,
            job_id: self.id,
            duration_s: clock - self.clock0,
            batch_count: self.sequence,
            sample_count: self.sample_count,
            energy_j: self.energy_j,
        })));
    }
}

/// Why a job was cut short.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Abort {
    Reset,
    Disconnect,
}

impl Abort {
    fn code(self) -> &'static str {
        match self {
            Abort::Reset => "job-reset",
            Abort::Disconnect => "sender-disconnected",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Abort::Reset => {
                "The sender reset the controller (Ctrl-X) mid-job; the preview shows what burned before the stop."
            }
            Abort::Disconnect => {
                "The sender disconnected mid-job; the preview shows what it had sent (a held job stops where it was)."
            }
        }
    }
}

fn event(e: Event) -> Output {
    Output::Event(Box::new(e))
}

pub struct Machine {
    config: MachineConfig,
    /// The emulated `$` settings; they hold the machine profile.
    settings: GrblSettings,
    planner: Box<dyn Planner>,
    parser: Parser,
    /// Received line bytes not yet run (real-time bytes never land here).
    rx: Vec<u8>,
    /// Moves (and syncs) of the line being run that the planner can't take yet.
    pending: VecDeque<Item>,
    /// The line being run is waiting for `pending` to drain before its `ok`.
    pending_ok: bool,
    /// Where the last queued move ends: the base for jogs.
    target: (f64, f64),
    /// The planner holds a jog (jogs and G-code lines never share it).
    jogging: bool,
    hold: bool,
    /// Jog cancel: decelerating, then the jog is dropped.
    jog_cancel: bool,
    alarm: bool,
    overrides: Overrides,
    overrides_reported: bool,
    reports: u32,
    /// Last move queued, for `$G`.
    last_move: Option<Block>,
    job: Option<LiveJob>,
    next_job_id: u32,
    end_job_when_idle: bool,
    idle_s: f64,
    /// Wall time since the sender last sent anything.
    quiet_s: f64,
    rx_overflowed: bool,
    /// Bytes for the sender.
    out: Vec<u8>,
    /// Events and batches for the webview.
    outputs: Vec<Output>,
}

impl Machine {
    pub fn new(config: MachineConfig) -> Self {
        let settings = GrblSettings::new(config.profile.clone());
        let planner = Box::new(GrblPlanner::new(&settings));
        Self::with_planner(config, planner)
    }

    /// With another planner behind the [`Planner`] interface.
    pub fn with_planner(config: MachineConfig, mut planner: Box<dyn Planner>) -> Self {
        let settings = GrblSettings::new(config.profile.clone());
        planner.configure(&settings);
        Self {
            config,
            parser: new_parser((0.0, 0.0), &settings),
            settings,
            planner,
            rx: Vec::new(),
            pending: VecDeque::new(),
            pending_ok: false,
            target: (0.0, 0.0),
            jogging: false,
            hold: false,
            jog_cancel: false,
            alarm: false,
            overrides: Overrides::default(),
            overrides_reported: false,
            reports: 0,
            last_move: None,
            job: None,
            next_job_id: 1,
            end_job_when_idle: false,
            idle_s: 0.0,
            quiet_s: 0.0,
            rx_overflowed: false,
            out: Vec::new(),
            outputs: Vec::new(),
        }
    }

    pub fn set_pacing(&mut self, pacing: Pacing) {
        self.config.pacing = pacing;
    }

    /// The settings screen saved a profile. `$` writes to other settings stay.
    pub fn set_profile(&mut self, profile: MachineProfile) {
        self.settings.set_profile(profile.clone());
        self.planner.configure(&self.settings);
        self.config.profile = profile;
    }

    pub fn settings(&self) -> &GrblSettings {
        &self.settings
    }

    /// Replies for the sender since the last call.
    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }

    /// Events and batches for the webview since the last call.
    pub fn take_outputs(&mut self) -> Vec<Output> {
        std::mem::take(&mut self.outputs)
    }

    /// A sender connected: power-up state (head stays put), then the banner.
    pub fn connect(&mut self) {
        self.close_job();
        self.clear_motion();
        self.alarm = false;
        self.overrides = Overrides::default();
        self.rx_overflowed = false;
        self.reports = 0;
        self.parser = new_parser(self.target, &self.settings);
        self.out.extend_from_slice(protocol::BANNER.as_bytes());
    }

    /// The sender went away. Lines already received still run (instantly), as
    /// GRBL would run its buffers, unless the job was held; then it stops there.
    /// Either way the job closes and the preview keeps what was burned.
    pub fn disconnect(&mut self) {
        let abort = self.has_work().then_some(Abort::Disconnect);
        if !self.hold && !self.alarm {
            loop {
                self.process_lines();
                self.run_motion(f64::INFINITY);
                if self.pending.is_empty() && !self.rx.contains(&b'\n') && !self.rx.contains(&b'\r') {
                    break;
                }
            }
        }
        self.clear_motion();
        self.close_job_with(abort);
        self.hold = false;
        self.out.clear();
    }

    /// Bytes from the sender.
    pub fn receive(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.quiet_s = 0.0;
        }
        for &b in bytes {
            match b {
                rt::STATUS => self.status_report(),
                rt::HOLD => self.feed_hold(),
                rt::RESUME => self.resume(),
                rt::RESET => self.reset(),
                rt::JOG_CANCEL => self.jog_cancel(),
                rt::FEED_100..=rt::SPINDLE_MINUS_1 => self.override_command(b),
                // Safety door, coolant toggles and unknown extended codes: ignored.
                0x80.. => {}
                b'\n' | b'\r' => {
                    self.rx.push(b);
                    self.process_lines();
                }
                _ => self.rx.push(b),
            }
        }
        if self.rx.len() > protocol::RX_BUFFER_SIZE && !self.rx_overflowed {
            // Real GRBL would drop bytes here; the emulator keeps them but says so.
            self.rx_overflowed = true;
            self.outputs.push(event(Event::ErrorEvent(ErrorEvent {
                type_: ErrorEventType::Error,
                code: ErrorEventCode::try_from("rx-overflow").expect("non-empty"),
                message: format!(
                    "The sender has more than {} bytes unacknowledged; real GRBL would lose data. Check the sender's buffer settings.",
                    protocol::RX_BUFFER_SIZE
                ),
                job_id: self.job.as_ref().map(|j| j.id),
            })));
        }
    }

    /// Advances by `wall_dt_s` of wall time: motion, `ok`s it unblocks, job close.
    pub fn step(&mut self, wall_dt_s: f64) {
        self.quiet_s += wall_dt_s;
        match self.config.pacing {
            Pacing::Realtime => self.run_motion(wall_dt_s.min(MAX_STEP_S)),
            Pacing::Instant if self.end_job_when_idle || self.quiet_s >= INSTANT_QUIET_S => {
                self.run_motion(f64::INFINITY)
            }
            Pacing::Instant => self.run_motion_fed(),
        }
        if self.jog_cancel && self.planner.hold_complete() {
            self.jog_cancel = false;
            self.clear_motion();
        }
        self.process_lines();
        if let Some(job) = &mut self.job {
            job.batch_age_s += wall_dt_s;
            job.progress_age_s += wall_dt_s;
            if job.progress_age_s >= PROGRESS_S {
                job.progress(self.planner.clock_s(), self.parser.line_count(), &mut self.outputs);
            } else if job.batch_age_s >= BATCH_FLUSH_S {
                job.flush(false, &mut self.outputs);
            }
        }
        let idle = self.job.is_some()
            && !self.hold
            && self.planner.queued() == 0
            && self.pending.is_empty()
            && !self.rx.iter().any(|&b| b == b'\n' || b == b'\r');
        if idle {
            self.idle_s += wall_dt_s;
            if self.end_job_when_idle || self.idle_s >= self.config.job_idle_end_s {
                self.close_job();
            }
        } else {
            self.idle_s = 0.0;
        }
    }

    /// machine.status for the webview (pushed at STATUS_PUSH_HZ by the server).
    pub fn status_event(&self) -> Event {
        let snap = self.planner.snapshot();
        let state = match self.state() {
            GrblState::Idle => MachineState::Idle,
            GrblState::Run => MachineState::Run,
            GrblState::Hold => MachineState::Hold,
            GrblState::Jog => MachineState::Jog,
            GrblState::Alarm => MachineState::Alarm,
        };
        let job = self.job.as_ref();
        Event::MachineStatusEvent(MachineStatusEvent {
            type_: MachineStatusEventType::MachineStatus,
            state,
            position_mm: Vec2Mm { x_mm: snap.position_mm.0, y_mm: snap.position_mm.1 },
            feed_mm_per_min: snap.speed_mm_per_s * 60.0,
            s: snap.s,
            laser: snap.laser,
            line: snap.line,
            job_id: job.map(|j| j.id),
            t_s: job.map_or(0.0, |j| (self.planner.clock_s() - j.clock0).max(0.0)),
        })
    }

    fn state(&self) -> GrblState {
        if self.alarm {
            GrblState::Alarm
        } else if self.hold {
            GrblState::Hold
        } else if self.planner.queued() > 0 || !self.pending.is_empty() || self.jog_cancel {
            if self.jogging { GrblState::Jog } else { GrblState::Run }
        } else {
            GrblState::Idle
        }
    }

    fn reply(&mut self, text: &str) {
        self.out.extend_from_slice(text.as_bytes());
        self.out.extend_from_slice(b"\r\n");
    }

    fn ok(&mut self) {
        self.reply("ok");
    }

    fn error(&mut self, code: u8) {
        self.reply(&format!("error:{code}"));
    }

    fn status_report(&mut self) {
        let snap = self.planner.snapshot();
        let state = match self.state() {
            GrblState::Idle => "Idle",
            GrblState::Run => "Run",
            GrblState::Hold if self.planner.hold_complete() => "Hold:0",
            GrblState::Hold => "Hold:1",
            GrblState::Jog => "Jog",
            GrblState::Alarm => "Alarm",
        };
        let mask = self.settings.status_mask();
        let (x, y) = snap.position_mm;
        let pos = if mask & 1 != 0 { "MPos" } else { "WPos" };
        let mut s = format!("<{state}|{pos}:{x:.3},{y:.3},0.000");
        if mask & 2 != 0 {
            let blocks = protocol::PLANNER_BLOCKS.saturating_sub(self.planner.queued());
            let rx = protocol::RX_BUFFER_SIZE.saturating_sub(self.rx.len());
            s += &format!("|Bf:{blocks},{rx}");
        }
        s += &format!("|FS:{:.0},{:.0}", snap.speed_mm_per_s * 60.0, snap.s);
        if self.reports.is_multiple_of(REPORT_REFRESH) {
            s += "|WCO:0.000,0.000,0.000";
        } else if !self.overrides_reported || self.reports % REPORT_REFRESH == 1 {
            let o = self.overrides;
            s += &format!("|Ov:{},{},{}", o.feed, o.rapid, o.spindle);
            self.overrides_reported = true;
        }
        s.push('>');
        self.reports = self.reports.wrapping_add(1);
        self.reply(&s);
    }

    fn feed_hold(&mut self) {
        match self.state() {
            GrblState::Jog => self.jog_cancel(),
            GrblState::Alarm => {}
            _ => {
                self.hold = true;
                self.planner.set_hold(true);
            }
        }
    }

    fn resume(&mut self) {
        if self.hold {
            self.hold = false;
            self.planner.set_hold(false);
        }
    }

    /// Jog cancel: decelerate to a stop, then drop the rest of the jog.
    fn jog_cancel(&mut self) {
        if self.state() == GrblState::Jog {
            self.pending.clear();
            self.pending_ok = false;
            self.jog_cancel = true;
            self.planner.set_hold(true);
        }
    }

    fn override_command(&mut self, b: u8) {
        let o = &mut self.overrides;
        let step = |v: u16, d: i32| (v as i32 + d).clamp(10, 200) as u16;
        match b {
            rt::FEED_100 => o.feed = 100,
            rt::FEED_PLUS_10 => o.feed = step(o.feed, 10),
            rt::FEED_MINUS_10 => o.feed = step(o.feed, -10),
            rt::FEED_PLUS_1 => o.feed = step(o.feed, 1),
            rt::FEED_MINUS_1 => o.feed = step(o.feed, -1),
            rt::RAPID_100 => o.rapid = 100,
            rt::RAPID_50 => o.rapid = 50,
            rt::RAPID_25 => o.rapid = 25,
            rt::SPINDLE_100 => o.spindle = 100,
            rt::SPINDLE_PLUS_10 => o.spindle = step(o.spindle, 10),
            rt::SPINDLE_MINUS_10 => o.spindle = step(o.spindle, -10),
            rt::SPINDLE_PLUS_1 => o.spindle = step(o.spindle, 1),
            rt::SPINDLE_MINUS_1 => o.spindle = step(o.spindle, -1),
            _ => return,
        }
        self.overrides_reported = false;
    }

    /// Ctrl-X: stop now, drop every buffer, keep the head where it is. A reset
    /// while moving loses position on a real machine, so it raises ALARM:3.
    fn reset(&mut self) {
        let moving = match self.state() {
            GrblState::Run | GrblState::Jog => true,
            GrblState::Hold => !self.planner.hold_complete(),
            _ => false,
        };
        let abort = self.has_work().then_some(Abort::Reset);
        if moving {
            self.alarm = true;
            self.reply(&format!("ALARM:{}", protocol::ALARM_ABORT_CYCLE));
        }
        self.clear_motion();
        self.close_job_with(abort);
        self.rx.clear();
        self.hold = false;
        self.overrides = Overrides::default();
        self.overrides_reported = false;
        self.reports = 0;
        // gc_init: modal state back to power-up defaults.
        self.parser = new_parser(self.target, &self.settings);
        self.out.extend_from_slice(protocol::BANNER.as_bytes());
        if self.alarm {
            self.out.extend_from_slice(protocol::UNLOCK_HINT.as_bytes());
        }
    }

    /// Stops motion and drops queued moves; the head stays where it is.
    fn clear_motion(&mut self) {
        self.planner.stop();
        self.pending.clear();
        self.pending_ok = false;
        self.jog_cancel = false;
        self.end_job_when_idle = false;
        self.target = self.planner.snapshot().position_mm;
        self.parser.set_position(self.target);
    }

    fn run_motion(&mut self, dt: f64) {
        if self.alarm {
            return;
        }
        let (job, outputs, profile) = (&mut self.job, &mut self.outputs, self.settings.profile());
        self.planner.advance(dt, self.overrides, &mut |t, s| {
            if let Some(job) = job.as_mut() {
                job.push(t, s, profile, outputs);
            }
        });
    }

    /// Instant pacing: motion up to the point the planner holds everything received.
    fn run_motion_fed(&mut self) {
        if self.alarm {
            return;
        }
        let (job, outputs, profile) = (&mut self.job, &mut self.outputs, self.settings.profile());
        self.planner.advance_fed(self.overrides, &mut |t, s| {
            if let Some(job) = job.as_mut() {
                job.push(t, s, profile, outputs);
            }
        });
    }

    /// Runs complete lines from RX while the planner has room.
    fn process_lines(&mut self) {
        loop {
            self.queue_pending();
            if !self.pending.is_empty() {
                return;
            }
            let Some(end) = self.rx.iter().position(|&b| b == b'\n' || b == b'\r') else { return };
            let line: Vec<u8> = self.rx.drain(..=end).take(end).collect();
            self.run_line(&line);
        }
    }

    fn planner_has_room(&self) -> bool {
        self.config.pacing == Pacing::Instant || self.planner.queued() < protocol::PLANNER_BLOCKS
    }

    fn queue_pending(&mut self) {
        while self.planner_has_room() {
            let Some(&item) = self.pending.front() else { break };
            // A sync holds the line (and its `ok`) until motion has stopped, as
            // GRBL's protocol_buffer_synchronize does. Instant pacing lets the
            // planner do the waiting.
            if matches!(item, Item::Sync { .. }) && self.config.pacing == Pacing::Realtime && self.planner.queued() > 0
            {
                break;
            }
            self.pending.pop_front();
            self.planner.push(item);
            if let Item::Block(block) = item {
                self.target = (block.x_mm, block.y_mm);
                self.jogging = block.jog;
                if !block.jog {
                    self.last_move = Some(block);
                }
            }
        }
        if self.pending.is_empty() && self.pending_ok {
            self.pending_ok = false;
            self.ok();
        }
    }

    fn run_line(&mut self, line: &[u8]) {
        if protocol::stored_len(line) >= protocol::LINE_BUFFER_SIZE - 1 {
            return self.error(error::OVERFLOW);
        }
        let text = String::from_utf8_lossy(line);
        let trimmed = text.trim();
        if let Some(cmd) = trimmed.strip_prefix('$') {
            return self.system_command(cmd.trim());
        }
        if protocol::stored_len(line) == 0 {
            return self.ok();
        }
        if matches!(self.state(), GrblState::Alarm | GrblState::Jog) {
            return self.error(error::SYSTEM_GC_LOCK);
        }
        if self.job.is_none() {
            let id = self.next_job_id;
            self.next_job_id += 1;
            let name = format!("Network job {id}");
            self.parser.set_name(name.clone());
            self.job = Some(LiveJob::new(id, name, self.planner.clock_s()));
        }
        let mut bytes = line.to_vec();
        bytes.push(b'\n');
        let (laser0, s0) = self.parser.laser_state();
        let result = self.parser.feed_bytes(&bytes).pop().expect("one complete line in, one outcome out");
        match result {
            Ok(range) => {
                let (laser1, s1) = self.parser.laser_state();
                let moves_on_line = !range.is_empty();
                // gc_execute_line: spindle changes are synced, except an S change
                // that rides on a motion line in laser mode.
                let laser_mode = self.settings.profile().laser_mode;
                let spindle_sync =
                    laser1 != laser0 || (s1 != s0 && laser0 != LaserMode::Off && !(laser_mode && moves_on_line));
                if let Some(dwell_s) = protocol::dwell_s(line) {
                    self.pending.push_back(Item::Sync { dwell_s });
                } else if spindle_sync {
                    self.pending.push_back(Item::Sync { dwell_s: 0.0 });
                }
                let moves = &self.parser.moves()[range];
                self.pending.extend(moves.iter().map(|m| Item::Block(Block::from_move(m))));
                if protocol::is_program_end(line) {
                    self.end_job_when_idle = true;
                }
                self.pending_ok = true;
                self.queue_pending();
            }
            Err(e) => self.error(e.grbl_error),
        }
    }

    fn system_command(&mut self, cmd: &str) {
        let state = self.state();
        let upper = cmd.to_ascii_uppercase();
        if let Some(jog) = upper.strip_prefix("J=") {
            if !matches!(state, GrblState::Idle | GrblState::Jog) {
                return self.error(error::IDLE_ERROR);
            }
            return match self.parse_jog(jog) {
                Ok(block) => {
                    self.close_job();
                    self.pending.push_back(Item::Block(block));
                    self.pending_ok = true;
                    self.queue_pending();
                    self.parser.set_position((block.x_mm, block.y_mm));
                }
                Err(code) => self.error(code),
            };
        }
        match upper.as_str() {
            "" => {
                self.out.extend_from_slice(protocol::HELP.as_bytes());
                self.ok()
            }
            "$" => {
                if matches!(state, GrblState::Run | GrblState::Hold) {
                    return self.error(error::IDLE_ERROR);
                }
                for line in self.settings.report_lines() {
                    self.reply(&line);
                }
                self.ok()
            }
            "G" => {
                let m = self.last_move;
                let motion = if m.is_some_and(|m| m.rapid) || m.is_none() { 0 } else { 1 };
                let laser = match m.map(|m| m.laser) {
                    Some(LaserMode::M3) => 3,
                    Some(LaserMode::M4) => 4,
                    _ => 5,
                };
                let (f, s) = m.map_or((0.0, 0.0), |m| (m.feed_mm_per_min, m.s));
                self.reply(&format!("[GC:G{motion} G54 G17 G21 G90 G94 M{laser} M9 T0 F{f:.0} S{s:.0}]"));
                self.ok()
            }
            "X" => {
                if self.alarm {
                    self.alarm = false;
                    self.reply("[MSG:Caution: Unlocked]");
                }
                self.ok()
            }
            _ if !matches!(state, GrblState::Idle | GrblState::Alarm) => self.error(error::IDLE_ERROR),
            "#" => {
                self.out.extend_from_slice(protocol::OFFSETS_REPORT.as_bytes());
                self.ok()
            }
            "I" => {
                self.out.extend_from_slice(protocol::VERSION.as_bytes());
                self.reply(&format!("[OPT:V,{},{}]", protocol::PLANNER_BLOCKS, protocol::RX_BUFFER_SIZE));
                self.ok()
            }
            "N" => {
                self.reply("$N0=");
                self.reply("$N1=");
                self.ok()
            }
            // Homing isn't emulated: the same answer as GRBL with $22=0.
            "H" => self.error(error::SETTING_DISABLED),
            _ => match parse_write(&upper).map(|(n, v)| self.settings.set(n, v)) {
                Some(Ok(written)) => {
                    self.planner.configure(&self.settings);
                    if written == Written::Profile {
                        self.config.profile = self.settings.profile().clone();
                        self.outputs.push(Output::Profile(Box::new(self.config.profile.clone())));
                    }
                    self.ok()
                }
                Some(Err(code)) => self.error(code),
                None => self.error(error::INVALID_STATEMENT),
            },
        }
    }

    /// `$J=` words: G20/G21, G90/G91, G53, X, Y, Z (ignored), F (required).
    fn parse_jog(&self, words: &str) -> Result<Block, u8> {
        let text: String = words.chars().filter(|c| !c.is_whitespace()).collect();
        let (mut relative, mut inches) = (false, false);
        let (mut x, mut y, mut feed) = (None, None, None);
        let mut rest = text.as_str();
        while let Some(letter) = rest.chars().next() {
            rest = &rest[1..];
            let end =
                rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+')).unwrap_or(rest.len());
            let value: f64 = rest[..end].parse().map_err(|_| error::INVALID_JOG_COMMAND)?;
            rest = &rest[end..];
            match (letter, value) {
                ('G', 20.0) => inches = true,
                ('G', 21.0) => inches = false,
                ('G', 90.0 | 53.0) => relative = false,
                ('G', 91.0) => relative = true,
                ('X', v) => x = Some(v),
                ('Y', v) => y = Some(v),
                ('Z', _) => {}
                ('F', v) => feed = Some(v),
                _ => return Err(error::INVALID_JOG_COMMAND),
            }
        }
        let feed = feed.filter(|f| *f > 0.0).ok_or(error::UNDEFINED_FEED_RATE)?;
        let scale = if inches { 25.4 } else { 1.0 };
        let axis = |word: Option<f64>, base: f64| match word {
            None => base,
            Some(v) if relative => base + v * scale,
            Some(v) => v * scale,
        };
        Ok(Block {
            x_mm: axis(x, self.target.0),
            y_mm: axis(y, self.target.1),
            feed_mm_per_min: feed * scale,
            rapid: false,
            s: 0.0,
            laser: LaserMode::Off,
            line: 0,
            jog: true,
        })
    }

    fn close_job(&mut self) {
        self.close_job_with(None);
    }

    fn close_job_with(&mut self, abort: Option<Abort>) {
        self.end_job_when_idle = false;
        self.idle_s = 0.0;
        if let Some(job) = self.job.take() {
            let model = self.parser.take_job();
            job.end(model, self.planner.clock_s(), abort, &mut self.outputs);
        }
    }

    /// Motion queued or lines waiting: a job stopped now would be cut short.
    fn has_work(&self) -> bool {
        self.planner.queued() > 0 || !self.pending.is_empty() || self.rx.iter().any(|&b| b == b'\n' || b == b'\r')
    }
}

fn new_parser(start: (f64, f64), settings: &GrblSettings) -> Parser {
    let opts = ParseOptions { arc_tolerance_mm: settings.arc_tolerance_mm(), ..ParseOptions::default() };
    let mut p = Parser::new(JobSourceKind::Network, "Network job", opts);
    p.set_position(start);
    p
}
