// SPDX-License-Identifier: GPL-3.0-or-later
//! GRBL 1.1h motion planner, ported to Rust (COD-255; port per COD-261).
//!
//! Ported from Grbl's `planner.c` (`plan_buffer_line`, `planner_recalculate`,
//! `plan_compute_profile_*`, `plan_update_velocity_profile_parameters`,
//! `plan_cycle_reinitialize`) and the velocity-profile part of `stepper.c`
//! (`st_prep_buffer`, `st_update_plan_block_parameters`), plus the laser-mode
//! PWM update and `spindle_compute_pwm_value`.
//! Grbl: Copyright (c) 2011-2016 Sungeun K. Jeon for Gnea Research LLC,
//! Copyright (c) 2009-2011 Simen Svale Skogsrud. GPLv3 or later.
//!
//! What carries over unchanged:
//! - a 16-slot block ring with 15 usable blocks, the executing block included;
//!   blocks beyond that wait outside the planner, as GRBL's serial buffer holds
//!   them, so lookahead is GRBL's even when the emulator answers instantly;
//! - targets in whole steps ($100/$101); a move shorter than a step is dropped;
//! - junction deviation ($11) with the junction acceleration limited along the
//!   junction vector, per-axis acceleration and max rate, the reverse and
//!   forward passes and the `block_buffer_planned` pointer;
//! - the executing block is replanned from its current speed and remaining
//!   distance whenever the planner reaches it (`st_update_plan_block_parameters`),
//!   on feed/rapid overrides, and on hold and resume;
//! - the stepper's ramp types (accel, cruise, decel, and decel-override for
//!   override reductions) and its forced deceleration for feed holds, carried
//!   across blocks;
//! - M4 dynamic power: S × current speed / programmed rate (not the overridden
//!   rate, as in GRBL), then the spindle override, then the $30/$31 mapping;
//!   laser mode ($32) turns the beam off on G0;
//! - spindle syncs and G4 dwells (pushed as [`Item::Sync`]): motion stops and
//!   the buffer drains before the next block.
//!
//! What differs: time is continuous rather than 10 ms step segments, so the
//! profile is the stepper's ideal one without segment rounding; floats are f64
//! (GRBL uses f32); the PWM value is not quantised to 8 bits; the segment buffer
//! (motion committed ahead of the planner) is not modelled.
//!
//! Samples follow the contract's sampling rule (samples.ts): only beam-on time
//! is sampled, each constant-acceleration phase is split into
//! n = max(1, ceil(T / SAMPLE_DT_MAX_S), ceil(L / grid pitch)) equal-time
//! intervals, one sample at each interval's midpoint. A phase cut short by a
//! replan ends with one shorter interval.

use std::collections::VecDeque;

use aria_burn_contract::{
    JobModel, LaserMode, MachineProfile, Move, MoveKind, PowerCurvePoint, sample_batch::MotionSample,
};

use crate::settings::GrblSettings;

/// `SAMPLE_DT_MAX_S` from the contract's sample-batch layout (`dtMaxS`).
pub const SAMPLE_DT_MAX_S: f64 = 0.0005;

/// GRBL's `BLOCK_BUFFER_SIZE`; one slot stays free, so 15 blocks are usable.
pub const BLOCK_BUFFER_SIZE: usize = 16;
const USABLE_BLOCKS: usize = BLOCK_BUFFER_SIZE - 1;

/// GRBL's `MINIMUM_FEED_RATE` (1 mm/min), in mm/s.
const MINIMUM_FEED_RATE: f64 = 1.0 / 60.0;
/// GRBL's `MINIMUM_JUNCTION_SPEED` (mm/s).
const MINIMUM_JUNCTION_SPEED: f64 = 0.0;
const SOME_LARGE_VALUE: f64 = 1.0e38;

const EPS: f64 = 1e-12;

/// One straight move for the planner.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    pub x_mm: f64,
    pub y_mm: f64,
    /// Programmed feed (mm/min); ignored for rapids.
    pub feed_mm_per_min: f64,
    pub rapid: bool,
    pub s: f64,
    pub laser: LaserMode,
    /// 1-based job line; 0 for jogs.
    pub line: u32,
    /// `$J=` jog: runs at its own feed, ignores the feed override, never burns.
    pub jog: bool,
}

impl Block {
    pub fn from_move(m: &Move) -> Self {
        Self {
            x_mm: m.x_mm,
            y_mm: m.y_mm,
            feed_mm_per_min: m.feed_mm_per_min,
            rapid: m.kind == MoveKind::G0,
            s: m.s,
            laser: m.laser,
            line: m.line,
            jog: false,
        }
    }

    /// Whether the laser fires on this block (laser mode turns it off on G0).
    fn beam_on(&self, laser_mode: bool) -> bool {
        !self.jog && self.laser != LaserMode::Off && self.s > 0.0 && !(laser_mode && self.rapid)
    }
}

/// What goes into the planner, in order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Item {
    Block(Block),
    /// `protocol_buffer_synchronize`: motion stops and the buffer drains before
    /// anything after it, then the machine waits `dwell_s` (G4; 0 for a spindle sync).
    Sync {
        dwell_s: f64,
    },
}

/// GRBL real-time overrides, in percent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Overrides {
    pub feed: u16,
    pub rapid: u16,
    pub spindle: u16,
}

impl Default for Overrides {
    fn default() -> Self {
        Self { feed: 100, rapid: 100, spindle: 100 }
    }
}

/// The planner's state right now, for `?` and machine.status.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Snapshot {
    /// In whole steps, as GRBL reports it.
    pub position_mm: (f64, f64),
    pub speed_mm_per_s: f64,
    /// Line of the block executing; 0 when idle.
    pub line: u32,
    /// Effective S (GRBL's `sys.spindle_speed`: M4 scaling and the spindle
    /// override applied, capped at $30); 0 when the beam is off.
    pub s: f64,
    pub laser: LaserMode,
    pub jog: bool,
}

/// What the emulator needs from a planner.
pub trait Planner: Send {
    /// New settings: the profile plus $31/$100/$101.
    fn configure(&mut self, settings: &GrblSettings);
    /// Items queued, the executing block included. More than GRBL's 15 when the
    /// emulator answers instantly; the planner itself still holds 15 at most.
    fn queued(&self) -> usize;
    fn push(&mut self, item: Item);
    /// Runs up to `dt_s` of motion, calling `emit(t_s, sample)` for each sample
    /// with its time on the planner clock. Returns the time actually run, which
    /// is less than `dt_s` when the queue empties or a hold completes.
    /// `f64::INFINITY` runs it dry.
    fn advance(&mut self, dt_s: f64, ov: Overrides, emit: &mut dyn FnMut(f64, MotionSample)) -> f64;
    /// Runs while items wait outside the planner, and stops the moment it holds
    /// everything queued: motion as if the sender kept GRBL's buffers full, for
    /// instant pacing. Returns the time run.
    fn advance_fed(&mut self, ov: Overrides, emit: &mut dyn FnMut(f64, MotionSample)) -> f64;
    /// Feed hold on (decelerate to a stop along the path) or off (resume).
    fn set_hold(&mut self, hold: bool);
    /// True once a hold has brought motion to rest.
    fn hold_complete(&self) -> bool;
    /// Drops every item; the head stays where it is now.
    fn stop(&mut self);
    /// Moves the head without motion (start-up, tests).
    fn set_position(&mut self, position_mm: (f64, f64));
    fn snapshot(&self) -> Snapshot;
    /// Machine time so far (s): advances while blocks execute and during dwells.
    fn clock_s(&self) -> f64;
}

#[derive(Clone, Copy, Debug)]
struct Config {
    max_rate: (f64, f64),
    accel: (f64, f64),
    junction_deviation_mm: f64,
    optical_power_w: f64,
    s_max: f64,
    s_min: f64,
    laser_mode: bool,
    steps_per_mm: (f64, f64),
    pitch_mm: f64,
}

/// GRBL's `plan_block_t`, in mm and mm/s.
#[derive(Clone, Debug)]
struct PlanBlock {
    block: Block,
    /// Step-exact end point (mm).
    target: (f64, f64),
    unit: (f64, f64),
    /// Distance left (the executing block's shrinks as it runs).
    millimeters: f64,
    acceleration: f64,
    rapid_rate: f64,
    programmed_rate: f64,
    entry_speed_sqr: f64,
    max_entry_speed_sqr: f64,
    max_junction_speed_sqr: f64,
}

/// The stepper's `ramp_type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ramp {
    Accel,
    Cruise,
    Decel,
    DecelOverride,
}

/// One constant-acceleration piece of the executing block's profile.
#[derive(Clone, Copy, Debug)]
struct Phase {
    ramp: Ramp,
    /// Duration (s).
    t: f64,
    v0: f64,
    v1: f64,
    /// Distance left in the block at the start and the end of the phase.
    mm0: f64,
    mm1: f64,
    /// Time run so far.
    elapsed: f64,
    /// Planner clock at the phase start.
    clock0: f64,
    /// Sample intervals (0 for beam-off blocks) and the next one to emit.
    n: u32,
    next: u32,
}

impl Phase {
    fn accel(&self) -> f64 {
        if self.t > 0.0 { (self.v1 - self.v0) / self.t } else { 0.0 }
    }

    /// Distance left in the block, and speed, `t` into the phase.
    fn at(&self, t: f64) -> (f64, f64) {
        if t >= self.t {
            return (self.mm1, self.v1);
        }
        let a = self.accel();
        (self.mm0 - (self.v0 * t + 0.5 * a * t * t), self.v0 + a * t)
    }
}

/// The stepper's prep state for the executing block (`st_prep_t`).
#[derive(Clone, Copy, Debug)]
struct Prep {
    current_speed: f64,
    exit_speed: f64,
    accelerate_until: f64,
    decelerate_after: f64,
    maximum_speed: f64,
    mm_complete: f64,
    /// `PREP_FLAG_RECALCULATE`: the planner changed this block mid-execution.
    recalculate: bool,
    phase: Phase,
}

pub struct GrblPlanner {
    cfg: Config,
    curve: Vec<PowerCurvePoint>,
    /// Items not yet in the planner (GRBL's serial buffer).
    incoming: VecDeque<Item>,
    /// The block ring, tail (executing) first.
    buf: VecDeque<PlanBlock>,
    /// `block_buffer_planned`, as an index into `buf` (may equal `buf.len()`).
    planned: usize,
    /// `pl.position`, in steps.
    position_steps: (i64, i64),
    previous_unit: (f64, f64),
    previous_nominal_speed: f64,
    /// The executing block's profile, once loaded.
    prep: Option<Prep>,
    /// `prep.exit_speed` of the last block, carried into the next one after a
    /// hold or a deceleration override.
    last_exit_speed: f64,
    /// `PREP_FLAG_DECEL_OVERRIDE`.
    decel_override: bool,
    hold: bool,
    held: bool,
    dwell_left_s: f64,
    ov: Overrides,
    clock: f64,
    /// Head position when no block is executing.
    pos: (f64, f64),
}

impl GrblPlanner {
    pub fn new(settings: &GrblSettings) -> Self {
        Self {
            cfg: config(settings),
            curve: settings.profile().power_curve.clone(),
            incoming: VecDeque::new(),
            buf: VecDeque::new(),
            planned: 0,
            position_steps: (0, 0),
            previous_unit: (0.0, 0.0),
            previous_nominal_speed: 0.0,
            prep: None,
            last_exit_speed: 0.0,
            decel_override: false,
            hold: false,
            held: false,
            dwell_left_s: 0.0,
            ov: Overrides::default(),
            clock: 0.0,
            pos: (0.0, 0.0),
        }
    }

    fn to_steps(&self, (x, y): (f64, f64)) -> (i64, i64) {
        ((x * self.cfg.steps_per_mm.0).round() as i64, (y * self.cfg.steps_per_mm.1).round() as i64)
    }

    fn to_mm(&self, (x, y): (i64, i64)) -> (f64, f64) {
        (x as f64 / self.cfg.steps_per_mm.0, y as f64 / self.cfg.steps_per_mm.1)
    }

    /// `plan_compute_profile_nominal_speed`.
    fn nominal_speed(&self, b: &PlanBlock) -> f64 {
        let mut v = b.programmed_rate;
        if b.block.rapid {
            v *= 0.01 * self.ov.rapid as f64;
        } else {
            if !b.block.jog {
                v *= 0.01 * self.ov.feed as f64;
            }
            v = v.min(b.rapid_rate);
        }
        v.max(MINIMUM_FEED_RATE)
    }

    /// `plan_buffer_line`. False for a move shorter than one step.
    fn buffer_line(&mut self, block: Block) -> bool {
        let target_steps = self.to_steps((block.x_mm, block.y_mm));
        let d = (target_steps.0 - self.position_steps.0, target_steps.1 - self.position_steps.1);
        if d == (0, 0) {
            return false;
        }
        let delta = (d.0 as f64 / self.cfg.steps_per_mm.0, d.1 as f64 / self.cfg.steps_per_mm.1);
        let millimeters = delta.0.hypot(delta.1);
        let unit = (delta.0 / millimeters, delta.1 / millimeters);
        let rapid_rate = limit_by_axis_maximum(self.cfg.max_rate, unit);
        let mut b = PlanBlock {
            block,
            target: self.to_mm(target_steps),
            unit,
            millimeters,
            acceleration: limit_by_axis_maximum(self.cfg.accel, unit),
            rapid_rate,
            programmed_rate: if block.rapid { rapid_rate } else { block.feed_mm_per_min / 60.0 },
            entry_speed_sqr: 0.0,
            max_entry_speed_sqr: 0.0,
            max_junction_speed_sqr: 0.0,
        };

        // From rest (empty buffer) entry and junction speeds stay zero.
        if !self.buf.is_empty() {
            // Junction deviation: the corner speed at which the centripetal
            // acceleration on a circle tangent to both paths, `junction_deviation`
            // from the corner, reaches the limit along the junction vector.
            let prev = self.previous_unit;
            let cos_theta = -(prev.0 * unit.0 + prev.1 * unit.1);
            b.max_junction_speed_sqr = if cos_theta > 0.999999 {
                // Reversal.
                MINIMUM_JUNCTION_SPEED * MINIMUM_JUNCTION_SPEED
            } else if cos_theta < -0.999999 {
                // Straight on.
                SOME_LARGE_VALUE
            } else {
                let jv = (unit.0 - prev.0, unit.1 - prev.1);
                let jl = jv.0.hypot(jv.1);
                let junction_acceleration = limit_by_axis_maximum(self.cfg.accel, (jv.0 / jl, jv.1 / jl));
                let sin_theta_d2 = (0.5 * (1.0 - cos_theta)).sqrt();
                (MINIMUM_JUNCTION_SPEED * MINIMUM_JUNCTION_SPEED)
                    .max(junction_acceleration * self.cfg.junction_deviation_mm * sin_theta_d2 / (1.0 - sin_theta_d2))
            };
        }

        let nominal_speed = self.nominal_speed(&b);
        compute_profile_parameters(&mut b, nominal_speed, self.previous_nominal_speed);
        self.previous_nominal_speed = nominal_speed;
        self.previous_unit = unit;
        self.position_steps = target_steps;
        self.buf.push_back(b);
        self.recalculate();
        true
    }

    /// `st_update_plan_block_parameters`: the executing block becomes a block of
    /// its remaining distance, entered at the current speed.
    fn update_exec_block(&mut self) {
        if let Some(prep) = &mut self.prep {
            prep.recalculate = true;
            self.buf[0].entry_speed_sqr = prep.current_speed * prep.current_speed;
        }
    }

    /// `planner_recalculate`: a reverse pass from the newest block back to the
    /// planned pointer, then a forward pass that moves the pointer up to the
    /// last block whose entry speed can no longer change.
    fn recalculate(&mut self) {
        let head = self.buf.len();
        let mut idx = head - 1;
        if idx == self.planned {
            return;
        }
        let mut cur = idx;
        {
            let b = &mut self.buf[cur];
            b.entry_speed_sqr = b.max_entry_speed_sqr.min(2.0 * b.acceleration * b.millimeters);
        }
        idx -= 1;
        if idx == self.planned {
            if idx == 0 {
                self.update_exec_block();
            }
        } else {
            while idx != self.planned {
                let next = cur;
                cur = idx;
                idx -= 1;
                if idx == 0 {
                    self.update_exec_block();
                }
                let next_entry = self.buf[next].entry_speed_sqr;
                let b = &mut self.buf[cur];
                if b.entry_speed_sqr != b.max_entry_speed_sqr {
                    let entry_speed_sqr = next_entry + 2.0 * b.acceleration * b.millimeters;
                    b.entry_speed_sqr = entry_speed_sqr.min(b.max_entry_speed_sqr);
                }
            }
        }

        let mut next = self.planned;
        let mut idx = self.planned + 1;
        while idx != head {
            let cur = next;
            next = idx;
            let (cur_entry, cur_gain) = {
                let c = &self.buf[cur];
                (c.entry_speed_sqr, 2.0 * c.acceleration * c.millimeters)
            };
            let n = &mut self.buf[next];
            if cur_entry < n.entry_speed_sqr {
                let entry_speed_sqr = cur_entry + cur_gain;
                if entry_speed_sqr < n.entry_speed_sqr {
                    n.entry_speed_sqr = entry_speed_sqr;
                    self.planned = idx;
                }
            }
            if n.entry_speed_sqr == n.max_entry_speed_sqr {
                self.planned = idx;
            }
            idx += 1;
        }
    }

    /// `plan_update_velocity_profile_parameters` then `plan_cycle_reinitialize`:
    /// the feed or rapid override changed every block's nominal speed.
    fn reinitialize_for_overrides(&mut self) {
        let mut prev_nominal = SOME_LARGE_VALUE;
        for i in 0..self.buf.len() {
            let nominal = self.nominal_speed(&self.buf[i]);
            compute_profile_parameters(&mut self.buf[i], nominal, prev_nominal);
            prev_nominal = nominal;
        }
        self.previous_nominal_speed = prev_nominal;
        self.cycle_reinitialize();
    }

    /// `plan_cycle_reinitialize`: replan from where the machine is now.
    fn cycle_reinitialize(&mut self) {
        self.update_exec_block();
        self.planned = 0;
        if !self.buf.is_empty() {
            self.recalculate();
        }
    }

    /// Moves waiting items into the planner while it has room. A sync waits for
    /// the buffer to drain, then starts its dwell.
    fn fill(&mut self) {
        while self.dwell_left_s <= 0.0 {
            match self.incoming.front().copied() {
                Some(Item::Block(b)) if self.buf.len() < USABLE_BLOCKS => {
                    self.incoming.pop_front();
                    self.buffer_line(b);
                }
                Some(Item::Sync { dwell_s }) if self.buf.is_empty() => {
                    self.incoming.pop_front();
                    self.dwell_left_s = dwell_s;
                }
                _ => break,
            }
        }
    }

    /// `plan_get_exec_block_exit_speed_sqr`.
    fn exec_exit_speed_sqr(&self) -> f64 {
        self.buf.get(1).map_or(0.0, |b| b.entry_speed_sqr)
    }

    /// Loads the block at the tail (`st_prep_buffer`, new block).
    fn load_block(&mut self) {
        let current_speed = if self.hold || self.decel_override {
            // Loaded mid-hold or after a deceleration override: carry on from
            // the speed the last block ended at.
            self.decel_override = false;
            self.buf[0].entry_speed_sqr = self.last_exit_speed * self.last_exit_speed;
            self.last_exit_speed
        } else {
            self.buf[0].entry_speed_sqr.sqrt()
        };
        let mm = self.buf[0].millimeters;
        let mut prep = Prep {
            current_speed,
            exit_speed: 0.0,
            accelerate_until: 0.0,
            decelerate_after: 0.0,
            maximum_speed: 0.0,
            mm_complete: 0.0,
            recalculate: false,
            phase: Phase {
                ramp: Ramp::Accel,
                t: 0.0,
                v0: current_speed,
                v1: current_speed,
                mm0: mm,
                mm1: mm,
                elapsed: 0.0,
                clock0: self.clock,
                n: 0,
                next: 0,
            },
        };
        let ramp = self.compute_profile(&mut prep);
        prep.phase = self.start_phase(&prep, ramp, current_speed, mm);
        self.prep = Some(prep);
    }

    /// The executing block's velocity profile from its entry (or current) speed
    /// and remaining distance (`st_prep_buffer`). Returns the ramp to start in.
    fn compute_profile(&mut self, prep: &mut Prep) -> Ramp {
        let b = &self.buf[0];
        prep.mm_complete = 0.0;
        let inv_2_accel = 0.5 / b.acceleration;
        if self.hold {
            // Forced deceleration to zero speed.
            let decel_dist = b.millimeters - inv_2_accel * b.entry_speed_sqr;
            if decel_dist < 0.0 {
                // Decelerates through the whole block; the hold ends in a later one.
                prep.exit_speed = (b.entry_speed_sqr - 2.0 * b.acceleration * b.millimeters).max(0.0).sqrt();
            } else {
                prep.mm_complete = decel_dist;
                prep.exit_speed = 0.0;
            }
            return Ramp::Decel;
        }

        let mut ramp = Ramp::Accel;
        prep.accelerate_until = b.millimeters;
        prep.decelerate_after = 0.0;
        let exit_speed_sqr = self.exec_exit_speed_sqr();
        prep.exit_speed = exit_speed_sqr.sqrt();
        let nominal_speed = self.nominal_speed(b);
        let nominal_speed_sqr = nominal_speed * nominal_speed;
        let intersect_distance = 0.5 * (b.millimeters + inv_2_accel * (b.entry_speed_sqr - exit_speed_sqr));

        if b.entry_speed_sqr > nominal_speed_sqr {
            // Only after an override reduction.
            prep.accelerate_until = b.millimeters - inv_2_accel * (b.entry_speed_sqr - nominal_speed_sqr);
            if prep.accelerate_until <= 0.0 {
                // Deceleration only. The exit is faster than planned; the next
                // block starts from it.
                ramp = Ramp::Decel;
                prep.exit_speed = (b.entry_speed_sqr - 2.0 * b.acceleration * b.millimeters).max(0.0).sqrt();
                self.decel_override = true;
            } else {
                // Decelerate to cruise, then cruise or cruise-decelerate.
                prep.decelerate_after = inv_2_accel * (nominal_speed_sqr - exit_speed_sqr);
                prep.maximum_speed = nominal_speed;
                ramp = Ramp::DecelOverride;
            }
        } else if intersect_distance > 0.0 {
            if intersect_distance < b.millimeters {
                // Trapezoid or triangle.
                prep.decelerate_after = inv_2_accel * (nominal_speed_sqr - exit_speed_sqr);
                if prep.decelerate_after < intersect_distance {
                    prep.maximum_speed = nominal_speed;
                    if b.entry_speed_sqr == nominal_speed_sqr {
                        ramp = Ramp::Cruise;
                    } else {
                        prep.accelerate_until -= inv_2_accel * (nominal_speed_sqr - b.entry_speed_sqr);
                    }
                } else {
                    prep.accelerate_until = intersect_distance;
                    prep.decelerate_after = intersect_distance;
                    prep.maximum_speed = (2.0 * b.acceleration * intersect_distance + exit_speed_sqr).sqrt();
                }
            } else {
                ramp = Ramp::Decel;
            }
        } else {
            // Acceleration only.
            prep.accelerate_until = 0.0;
            prep.maximum_speed = prep.exit_speed;
        }
        ramp
    }

    /// A phase of `ramp` starting now at speed `v0` with `mm0` left in the block.
    fn start_phase(&self, prep: &Prep, ramp: Ramp, v0: f64, mm0: f64) -> Phase {
        let (mm1, v1) = match ramp {
            Ramp::Accel | Ramp::DecelOverride => (prep.accelerate_until, prep.maximum_speed),
            Ramp::Cruise => (prep.decelerate_after, prep.maximum_speed),
            Ramp::Decel => (prep.mm_complete, prep.exit_speed),
        };
        let mm1 = mm1.clamp(0.0, mm0);
        let d = mm0 - mm1;
        // The stepper's end-of-ramp time: distance over mean speed.
        let (v0, t) = match ramp {
            Ramp::Cruise => (v1, if v1 > EPS { d / v1 } else { 0.0 }),
            _ if v0 + v1 > EPS => (v0, 2.0 * d / (v0 + v1)),
            _ => (v0, 0.0),
        };
        let n = if self.buf[0].block.beam_on(self.cfg.laser_mode) && t > 0.0 {
            (t / SAMPLE_DT_MAX_S).ceil().max((d / self.cfg.pitch_mm).ceil()).clamp(1.0, u32::MAX as f64) as u32
        } else {
            0
        };
        Phase { ramp, t, v0, v1, mm0, mm1, elapsed: 0.0, clock0: self.clock, n, next: 0 }
    }

    /// The ramp after `phase`, or `None` when the block (or the hold) is done.
    fn next_ramp(prep: &Prep, phase: &Phase) -> Option<Ramp> {
        if phase.mm1 <= prep.mm_complete {
            return None;
        }
        match phase.ramp {
            Ramp::Accel if phase.mm1 == prep.decelerate_after => Some(Ramp::Decel),
            Ramp::Accel | Ramp::DecelOverride => Some(Ramp::Cruise),
            Ramp::Cruise => Some(Ramp::Decel),
            Ramp::Decel => None,
        }
    }

    /// The executing block was replanned: recompute its profile from where it
    /// is. The running phase carries on if the new profile continues it.
    fn replan_exec(&mut self, emit: &mut dyn FnMut(f64, MotionSample)) {
        let Some(mut prep) = self.prep.take() else { return };
        prep.recalculate = false;
        let old = prep.phase;
        let (mm, v) = old.at(old.elapsed);
        self.buf[0].millimeters = mm;
        let ramp = self.compute_profile(&mut prep);
        let fresh = self.start_phase(&prep, ramp, v, mm);
        if ramp == old.ramp && close(fresh.mm1, old.mm1) && close(fresh.v1, old.v1) {
            prep.phase = old;
        } else {
            self.emit_partial(&old, emit);
            prep.phase = fresh;
        }
        self.prep = Some(prep);
    }

    fn sample(&self, phase: &Phase, t_mid: f64, dt: f64) -> Option<(f64, MotionSample)> {
        let (mm, v) = phase.at(t_mid);
        let b = &self.buf[0];
        let power = self.power_w(b, v);
        (power > 0.0).then(|| {
            let sample = MotionSample {
                t_rel_s: 0.0,
                x_mm: (b.target.0 - b.unit.0 * mm) as f32,
                y_mm: (b.target.1 - b.unit.1 * mm) as f32,
                dt_s: dt as f32,
                speed_mm_per_s: v as f32,
                power_w: power as f32,
                line: b.block.line,
            };
            (phase.clock0 + t_mid, sample)
        })
    }

    /// Emits the running phase's intervals that have ended.
    fn emit_due(&self, phase: &mut Phase, emit: &mut dyn FnMut(f64, MotionSample)) {
        if phase.n == 0 {
            return;
        }
        let h = phase.t / phase.n as f64;
        while phase.next < phase.n && (phase.next + 1) as f64 * h <= phase.elapsed + 1e-9 * h {
            let t_mid = (phase.next as f64 + 0.5) * h;
            if let Some((t, s)) = self.sample(phase, t_mid, h) {
                emit(t, s);
            }
            phase.next += 1;
        }
    }

    /// A phase cut short: its unfinished interval ends now.
    fn emit_partial(&self, phase: &Phase, emit: &mut dyn FnMut(f64, MotionSample)) {
        if phase.n == 0 || phase.next >= phase.n {
            return;
        }
        let start = phase.next as f64 * phase.t / phase.n as f64;
        let dt = phase.elapsed - start;
        if dt > EPS
            && let Some((t, s)) = self.sample(phase, start + 0.5 * dt, dt)
        {
            emit(t, s);
        }
    }

    /// Effective S of a block at a speed (`rpm` in GRBL's laser PWM update,
    /// before the $30/$31 mapping).
    fn effective_s(&self, b: &PlanBlock, speed: f64) -> f64 {
        if !b.block.beam_on(self.cfg.laser_mode) {
            return 0.0;
        }
        let mut rpm = b.block.s;
        if b.block.laser == LaserMode::M4 && self.cfg.laser_mode {
            // Feed and rapid overrides don't change power: programmed rate, not nominal.
            rpm *= speed / b.programmed_rate;
        }
        rpm * 0.01 * self.ov.spindle as f64
    }

    /// Optical power (W): GRBL's `spindle_compute_pwm_value` mapping, through
    /// the profile's S → power curve.
    fn power_w(&self, b: &PlanBlock, speed: f64) -> f64 {
        let rpm = self.effective_s(b, speed);
        let (min, max) = (self.cfg.s_min, self.cfg.s_max);
        let fraction = if rpm <= 0.0 {
            return 0.0;
        } else if min >= max || rpm >= max {
            1.0
        } else if rpm <= min {
            0.0
        } else {
            (rpm - min) / (max - min)
        };
        self.cfg.optical_power_w * interpolate(&self.curve, fraction)
    }

    /// The executing block finished (`plan_discard_current_block`).
    fn discard_block(&mut self, exit_speed: f64) {
        self.last_exit_speed = exit_speed;
        self.prep = None;
        if let Some(b) = self.buf.pop_front() {
            self.pos = b.target;
        }
        self.planned = self.planned.saturating_sub(1);
        self.fill();
        // The stepper loads the next block straight away.
        if !self.buf.is_empty() && self.dwell_left_s <= 0.0 {
            self.load_block();
        }
    }

    /// `advance` and `advance_fed`.
    fn run(&mut self, dt_s: f64, ov: Overrides, fed_only: bool, emit: &mut dyn FnMut(f64, MotionSample)) -> f64 {
        if ov != self.ov {
            let replan = ov.feed != self.ov.feed || ov.rapid != self.ov.rapid;
            self.ov = ov;
            if replan {
                self.reinitialize_for_overrides();
            }
        }
        let mut left = dt_s;
        let mut ran = 0.0;
        while left > 0.0 {
            if fed_only && self.incoming.is_empty() {
                break;
            }
            if self.dwell_left_s > 0.0 {
                let step = left.min(self.dwell_left_s);
                self.dwell_left_s -= step;
                self.clock += step;
                left -= step;
                ran += step;
                if self.dwell_left_s <= 0.0 {
                    self.dwell_left_s = 0.0;
                    self.fill();
                }
                continue;
            }
            if self.held {
                break;
            }
            if self.prep.is_none() {
                self.fill();
                if self.dwell_left_s > 0.0 {
                    continue;
                }
                if self.buf.is_empty() {
                    self.held = self.hold;
                    break;
                }
                self.load_block();
            }
            if self.prep.as_ref().is_some_and(|p| p.recalculate) {
                self.replan_exec(emit);
            }

            let mut prep = self.prep.take().expect("a block is loaded");
            let remain = prep.phase.t - prep.phase.elapsed;
            let step = left.min(remain);
            prep.phase.elapsed = if left >= remain { prep.phase.t } else { prep.phase.elapsed + step };
            left -= step;
            ran += step;
            self.clock += step;
            self.emit_due(&mut prep.phase, emit);
            let (mm, v) = prep.phase.at(prep.phase.elapsed);
            self.buf[0].millimeters = mm;
            prep.current_speed = v;

            if prep.phase.elapsed < prep.phase.t {
                self.prep = Some(prep);
                continue;
            }
            match Self::next_ramp(&prep, &prep.phase) {
                Some(ramp) => {
                    prep.phase = self.start_phase(&prep, ramp, v, mm);
                    self.prep = Some(prep);
                }
                None if prep.phase.mm1 > 0.0 => {
                    // End of a feed hold, partway through the block.
                    self.prep = Some(prep);
                    self.finish_hold();
                    break;
                }
                None => self.discard_block(prep.exit_speed),
            }
        }
        ran
    }

    /// The hold brought motion to rest: replan from a stop, ready to resume.
    fn finish_hold(&mut self) {
        self.held = true;
        if let Some(prep) = &mut self.prep {
            prep.current_speed = 0.0;
        }
        self.cycle_reinitialize();
    }
}

impl Planner for GrblPlanner {
    fn configure(&mut self, settings: &GrblSettings) {
        self.cfg = config(settings);
        self.curve = settings.profile().power_curve.clone();
    }

    fn queued(&self) -> usize {
        self.buf.len() + self.incoming.len() + usize::from(self.dwell_left_s > 0.0)
    }

    fn push(&mut self, item: Item) {
        self.incoming.push_back(item);
        self.fill();
    }

    fn advance(&mut self, dt_s: f64, ov: Overrides, emit: &mut dyn FnMut(f64, MotionSample)) -> f64 {
        self.run(dt_s, ov, false, emit)
    }

    fn advance_fed(&mut self, ov: Overrides, emit: &mut dyn FnMut(f64, MotionSample)) -> f64 {
        self.run(f64::INFINITY, ov, true, emit)
    }

    fn set_hold(&mut self, hold: bool) {
        if hold == self.hold {
            return;
        }
        self.hold = hold;
        if hold {
            self.update_exec_block();
            self.held = self.prep.is_none() && self.buf.is_empty();
        } else {
            self.held = false;
            if let Some(prep) = &mut self.prep {
                prep.recalculate = true;
            }
        }
    }

    fn hold_complete(&self) -> bool {
        self.held
    }

    fn stop(&mut self) {
        let at = self.snapshot().position_mm;
        self.incoming.clear();
        self.buf.clear();
        self.prep = None;
        self.planned = 0;
        self.dwell_left_s = 0.0;
        self.hold = false;
        self.held = false;
        self.decel_override = false;
        self.last_exit_speed = 0.0;
        self.previous_unit = (0.0, 0.0);
        self.previous_nominal_speed = 0.0;
        self.pos = at;
        // plan_sync_position: plan on from where the head is.
        self.position_steps = self.to_steps(at);
    }

    fn set_position(&mut self, position_mm: (f64, f64)) {
        self.stop();
        self.position_steps = self.to_steps(position_mm);
        self.pos = position_mm;
    }

    fn snapshot(&self) -> Snapshot {
        match (&self.prep, self.buf.front()) {
            (Some(prep), Some(b)) => {
                let (mm, v) = prep.phase.at(prep.phase.elapsed);
                Snapshot {
                    // GRBL counts position in steps.
                    position_mm: self.to_mm(self.to_steps((b.target.0 - b.unit.0 * mm, b.target.1 - b.unit.1 * mm))),
                    speed_mm_per_s: v,
                    line: b.block.line,
                    s: self.effective_s(b, v).min(self.cfg.s_max),
                    laser: b.block.laser,
                    jog: b.block.jog,
                }
            }
            _ => Snapshot {
                position_mm: self.pos,
                speed_mm_per_s: 0.0,
                line: 0,
                s: 0.0,
                laser: LaserMode::Off,
                jog: false,
            },
        }
    }

    fn clock_s(&self) -> f64 {
        self.clock
    }
}

/// `plan_compute_profile_parameters`: max entry speed from this block's and
/// the previous block's nominal speeds, capped by the junction.
fn compute_profile_parameters(b: &mut PlanBlock, nominal_speed: f64, prev_nominal_speed: f64) {
    b.max_entry_speed_sqr = if nominal_speed > prev_nominal_speed {
        prev_nominal_speed * prev_nominal_speed
    } else {
        nominal_speed * nominal_speed
    };
    if b.max_entry_speed_sqr > b.max_junction_speed_sqr {
        b.max_entry_speed_sqr = b.max_junction_speed_sqr;
    }
}

/// `limit_value_by_axis_maximum`: the largest value along `unit` that keeps
/// every axis within its limit.
fn limit_by_axis_maximum(max: (f64, f64), unit: (f64, f64)) -> f64 {
    let x = if unit.0 != 0.0 { max.0 / unit.0.abs() } else { SOME_LARGE_VALUE };
    let y = if unit.1 != 0.0 { max.1 / unit.1.abs() } else { SOME_LARGE_VALUE };
    x.min(y)
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

fn config(s: &GrblSettings) -> Config {
    let p = s.profile();
    Config {
        max_rate: (p.max_rate_mm_per_min.x / 60.0, p.max_rate_mm_per_min.y / 60.0),
        accel: (p.accel_mm_per_s2.x, p.accel_mm_per_s2.y),
        junction_deviation_mm: p.junction_deviation_mm,
        optical_power_w: p.optical_power_w,
        s_max: p.s_max,
        s_min: s.s_min(),
        laser_mode: p.laser_mode,
        steps_per_mm: s.steps_per_mm(),
        pitch_mm: grid_pitch_mm(p),
    }
}

/// The grid pitch a profile samples at (plan.started's gridPitchMm): spot σ ÷ 3
/// (deposit.ts), on the narrow axis.
pub fn grid_pitch_mm(profile: &MachineProfile) -> f64 {
    profile.spot.sigma_x_mm.min(profile.spot.sigma_y_mm) / 3.0
}

/// The contract's S → power curve lookup (machine.ts `interpolateCurve`).
pub fn interpolate(curve: &[PowerCurvePoint], s: f64) -> f64 {
    let (Some(first), Some(last)) = (curve.first(), curve.last()) else { return 0.0 };
    if s <= first.s {
        return first.power;
    }
    if s >= last.s {
        return last.power;
    }
    for w in curve.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        if s <= b.s {
            return a.power + (s - a.s) / (b.s - a.s) * (b.power - a.power);
        }
    }
    last.power
}

/// Planner items for a parsed job. GRBL syncs the spindle between moves on any
/// M3/M4/M5 change, and with laser mode off on any S change while the laser is
/// on. (The emulator sees the lines themselves, so it also catches syncs on
/// lines without motion and G4 dwells, which a `JobModel` doesn't keep.)
pub fn job_items(moves: &[Move], laser_mode: bool) -> Vec<Item> {
    let mut items = Vec::with_capacity(moves.len());
    let (mut laser, mut s) = (LaserMode::Off, 0.0);
    for m in moves {
        if m.laser != laser || (!laser_mode && laser != LaserMode::Off && m.s != s) {
            items.push(Item::Sync { dwell_s: 0.0 });
        }
        (laser, s) = (m.laser, m.s);
        items.push(Item::Block(Block::from_move(m)));
    }
    items
}

/// Plans a whole job as GRBL would run it, calling `emit` for each sample.
/// Returns the job time (s), beam-off moves included.
pub fn plan_job(job: &JobModel, settings: &GrblSettings, emit: &mut dyn FnMut(f64, MotionSample)) -> f64 {
    let mut p = GrblPlanner::new(settings);
    p.set_position((job.start_mm.x_mm, job.start_mm.y_mm));
    for item in job_items(&job.moves, settings.profile().laser_mode) {
        p.push(item);
    }
    p.advance(f64::INFINITY, Overrides::default(), emit);
    p.clock_s()
}

#[cfg(test)]
mod tests;
