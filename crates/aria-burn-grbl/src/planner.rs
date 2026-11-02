// SPDX-License-Identifier: GPL-3.0-or-later
//! Interim motion planner and sampler. Stands in for the GRBL planner port
//! (COD-255) behind the small [`Planner`] trait, which COD-255 replaces.
//!
//! [`InterimPlanner`] is written from scratch and only aims to be close enough
//! for live previews, `?` positions and job progress:
//! - each block is a trapezoid (accelerate, cruise, decelerate) with the
//!   profile's axis-limited acceleration and max rate;
//! - junction speeds use GRBL's junction-deviation formula, and a backward pass
//!   over the next [`LOOKAHEAD_BLOCKS`] queued blocks keeps every block able to
//!   stop at the end of the queue;
//! - a block's profile is fixed when it starts (no replanning mid-block), so an
//!   override takes effect from the next block;
//! - a feed hold stops at once, with no deceleration.
//!
//! Samples follow the contract's sampling rule (samples.ts): only beam-on time
//! is sampled, each constant-acceleration phase is split into
//! n = max(1, ceil(T / SAMPLE_DT_MAX_S), ceil(L / grid pitch)) equal-time
//! intervals, one sample at each interval's midpoint.

use std::collections::VecDeque;

use aria_burn_contract::{LaserMode, MachineProfile, Move, MoveKind, PowerCurvePoint, sample_batch::MotionSample};

/// `SAMPLE_DT_MAX_S` from the contract's sample-batch layout (`dtMaxS`).
pub const SAMPLE_DT_MAX_S: f64 = 0.0005;

/// Queued blocks the backward pass looks at, as GRBL's 16-block buffer does.
pub const LOOKAHEAD_BLOCKS: usize = 16;

const EPS: f64 = 1e-9;

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

    fn beam_on(&self) -> bool {
        !self.rapid && !self.jog && self.laser != LaserMode::Off && self.s > 0.0
    }
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
    pub position_mm: (f64, f64),
    pub speed_mm_per_s: f64,
    /// Line of the block executing; 0 when idle.
    pub line: u32,
    /// S of the block executing, after the spindle override; 0 when idle.
    pub s: f64,
    pub laser: LaserMode,
    pub jog: bool,
}

/// What the emulator needs from a planner. COD-255's port implements this.
pub trait Planner: Send {
    fn set_profile(&mut self, profile: &MachineProfile);
    /// Blocks queued, including the one executing (GRBL's planner buffer use).
    fn queued(&self) -> usize;
    fn push(&mut self, block: Block);
    /// Runs up to `dt_s` of motion, calling `emit(t_s, sample)` for each sample
    /// with its time on the planner clock. Returns the time actually run, which
    /// is less than `dt_s` when the queue empties. `f64::INFINITY` runs it dry.
    fn advance(&mut self, dt_s: f64, ov: Overrides, emit: &mut dyn FnMut(f64, MotionSample)) -> f64;
    /// Drops every block; the head stays where it is now.
    fn stop(&mut self);
    /// Moves the head without motion (start-up, tests).
    fn set_position(&mut self, position_mm: (f64, f64));
    fn snapshot(&self) -> Snapshot;
    /// Motion time so far: advances only while blocks execute.
    fn clock_s(&self) -> f64;
}

#[derive(Clone, Copy, Debug)]
struct Limits {
    max_rate: (f64, f64),
    accel: (f64, f64),
    junction_deviation_mm: f64,
    optical_power_w: f64,
    s_max: f64,
    laser_mode: bool,
    step_mm: f64,
}

/// One constant-acceleration piece of a block.
#[derive(Clone, Copy, Debug, Default)]
struct Phase {
    t: f64,
    v0: f64,
    a: f64,
    /// Distance along the block where the phase starts.
    d0: f64,
    /// Sample intervals; 0 for beam-off blocks.
    n: u32,
}

impl Phase {
    fn at(&self, t: f64) -> (f64, f64) {
        (self.d0 + self.v0 * t + 0.5 * self.a * t * t, self.v0 + self.a * t)
    }
}

#[derive(Clone, Debug)]
struct Active {
    block: Block,
    start: (f64, f64),
    dir: (f64, f64),
    exit: f64,
    /// Programmed speed (after overrides), for M4 power scaling.
    v_prog: f64,
    spindle_ov: u16,
    phases: [Phase; 3],
    phase: usize,
    t_in_phase: f64,
    phase_clock: f64,
    next_interval: u32,
}

pub struct InterimPlanner {
    limits: Limits,
    curve: Vec<PowerCurvePoint>,
    queue: VecDeque<Block>,
    active: Option<Active>,
    /// Head position at the end of the last finished block.
    pos: (f64, f64),
    /// Speed at the end of the last finished block.
    speed: f64,
    clock: f64,
}

impl InterimPlanner {
    pub fn new(profile: &MachineProfile) -> Self {
        let mut p = Self {
            limits: limits(profile),
            curve: profile.power_curve.clone(),
            queue: VecDeque::new(),
            active: None,
            pos: (0.0, 0.0),
            speed: 0.0,
            clock: 0.0,
        };
        p.set_profile(profile);
        p
    }

    /// Axis-limited max speed (mm/s) along `dir`, before overrides.
    fn rate_limit(&self, dir: (f64, f64)) -> f64 {
        axis_limit(dir, self.limits.max_rate)
    }

    fn nominal(&self, b: &Block, dir: (f64, f64), ov: Overrides) -> f64 {
        let max = self.rate_limit(dir);
        let v = if b.rapid {
            max * ov.rapid as f64 / 100.0
        } else if b.jog {
            b.feed_mm_per_min / 60.0
        } else {
            b.feed_mm_per_min / 60.0 * ov.feed as f64 / 100.0
        };
        v.min(max).max(EPS)
    }

    fn junction(&self, prev: (f64, f64), dir: (f64, f64), accel: f64) -> f64 {
        let cos = -(prev.0 * dir.0 + prev.1 * dir.1);
        if cos > 0.999_999 {
            0.0
        } else if cos < -0.999_999 {
            f64::INFINITY
        } else {
            let sin_half = (0.5 * (1.0 - cos)).sqrt();
            (accel * self.limits.junction_deviation_mm * sin_half / (1.0 - sin_half)).sqrt()
        }
    }

    /// Exit speed for a block starting now: the highest speed from which the
    /// queued blocks (up to the lookahead) can still stop at the queue's end.
    fn planned_exit(&self, end: (f64, f64), dir: (f64, f64), nominal: f64, ov: Overrides) -> f64 {
        let mut entries = Vec::with_capacity(LOOKAHEAD_BLOCKS);
        let (mut prev_end, mut prev_dir, mut prev_nom) = (end, dir, nominal);
        for b in self.queue.iter().take(LOOKAHEAD_BLOCKS) {
            let Some((len, d)) = segment(prev_end, (b.x_mm, b.y_mm)) else { continue };
            let a = axis_limit(d, self.limits.accel);
            let nom = self.nominal(b, d, ov);
            let max_entry = self.junction(prev_dir, d, a).min(nom).min(prev_nom);
            entries.push((len, a, max_entry));
            (prev_end, prev_dir, prev_nom) = ((b.x_mm, b.y_mm), d, nom);
        }
        entries.iter().rev().fold(0.0, |exit, &(len, a, max_entry)| max_entry.min((exit * exit + 2.0 * a * len).sqrt()))
    }

    /// Pops the next block and fixes its speed profile. False when the queue is empty.
    fn start_next(&mut self, ov: Overrides) -> bool {
        while let Some(block) = self.queue.pop_front() {
            let Some((len, dir)) = segment(self.pos, (block.x_mm, block.y_mm)) else {
                continue; // zero length
            };
            let a = axis_limit(dir, self.limits.accel);
            let v_nom = self.nominal(&block, dir, ov);
            let v0 = self.speed;
            let reach = (v0 * v0 + 2.0 * a * len).sqrt();
            let v1 = self.planned_exit((block.x_mm, block.y_mm), dir, v_nom, ov).min(v_nom).min(reach);
            let phases = self.phases(&block, len, a, v0, v_nom, v1);
            self.active = Some(Active {
                block,
                start: self.pos,
                dir,
                exit: v1,
                v_prog: v_nom,
                spindle_ov: ov.spindle,
                phases,
                phase: 0,
                t_in_phase: 0.0,
                phase_clock: self.clock,
                next_interval: 0,
            });
            return true;
        }
        false
    }

    fn phases(&self, block: &Block, len: f64, a: f64, v0: f64, v_nom: f64, v1: f64) -> [Phase; 3] {
        let vc = v_nom.min(((2.0 * a * len + v0 * v0 + v1 * v1) / 2.0).sqrt());
        let d1 = (vc * vc - v0 * v0).abs() / (2.0 * a);
        let d3 = (vc * vc - v1 * v1).max(0.0) / (2.0 * a);
        let mut phases = if d1 + d3 > len * (1.0 + 1e-9) || vc <= EPS {
            // Can't slow from v0 to v1 within the block at this acceleration
            // (an override dropped the feed, say): one ramp, braking harder.
            let t = if v0 + v1 > EPS { 2.0 * len / (v0 + v1) } else { 0.0 };
            [Phase { t, v0, a: (v1 * v1 - v0 * v0) / (2.0 * len), d0: 0.0, n: 0 }, Phase::default(), Phase::default()]
        } else {
            let d2 = (len - d1 - d3).max(0.0);
            [
                Phase { t: (vc - v0).abs() / a, v0, a: if vc >= v0 { a } else { -a }, d0: 0.0, n: 0 },
                Phase { t: d2 / vc, v0: vc, a: 0.0, d0: d1, n: 0 },
                Phase { t: (vc - v1) / a, v0: vc, a: -a, d0: d1 + d2, n: 0 },
            ]
        };
        if block.beam_on() {
            for p in phases.iter_mut().filter(|p| p.t > 0.0) {
                let len = p.at(p.t).0 - p.d0;
                let n = (p.t / SAMPLE_DT_MAX_S).ceil().max((len / self.limits.step_mm).ceil()).max(1.0);
                p.n = n.min(u32::MAX as f64) as u32;
            }
        }
        phases
    }

    fn power_w(&self, act: &Active, speed: f64) -> f64 {
        let b = &act.block;
        if !b.beam_on() {
            return 0.0;
        }
        let l = &self.limits;
        let mut s = (b.s * act.spindle_ov as f64 / 100.0).min(l.s_max) / l.s_max;
        if b.laser == LaserMode::M4 && l.laser_mode && act.v_prog > 0.0 {
            s *= (speed / act.v_prog).clamp(0.0, 1.0);
        }
        l.optical_power_w * interpolate(&self.curve, s)
    }
}

impl Planner for InterimPlanner {
    fn set_profile(&mut self, profile: &MachineProfile) {
        self.limits = limits(profile);
        self.curve = profile.power_curve.clone();
    }

    fn queued(&self) -> usize {
        self.queue.len() + usize::from(self.active.is_some())
    }

    fn push(&mut self, block: Block) {
        self.queue.push_back(block);
    }

    fn advance(&mut self, dt_s: f64, ov: Overrides, emit: &mut dyn FnMut(f64, MotionSample)) -> f64 {
        let mut left = dt_s;
        let mut ran = 0.0;
        while left > 0.0 {
            if self.active.is_none() && !self.start_next(ov) {
                break;
            }
            let mut act = self.active.take().expect("a block is active");
            let ph = act.phases[act.phase];
            let remain = ph.t - act.t_in_phase;
            let step = left.min(remain);
            if left >= remain {
                act.t_in_phase = ph.t;
            } else {
                act.t_in_phase += step;
            }
            left -= step;
            ran += step;
            self.clock += step;

            // Emit every interval that has ended by now.
            if ph.n > 0 {
                let h = ph.t / ph.n as f64;
                while act.next_interval < ph.n && (act.next_interval + 1) as f64 * h <= act.t_in_phase + EPS * h {
                    let t_mid = (act.next_interval as f64 + 0.5) * h;
                    let (d, v) = ph.at(t_mid);
                    let power = self.power_w(&act, v);
                    if power > 0.0 {
                        let sample = MotionSample {
                            t_rel_s: 0.0,
                            x_mm: (act.start.0 + act.dir.0 * d) as f32,
                            y_mm: (act.start.1 + act.dir.1 * d) as f32,
                            dt_s: h as f32,
                            speed_mm_per_s: v as f32,
                            power_w: power as f32,
                            line: act.block.line,
                        };
                        emit(act.phase_clock + t_mid, sample);
                    }
                    act.next_interval += 1;
                }
            }

            if act.t_in_phase >= ph.t {
                act.phase_clock += ph.t;
                act.phase += 1;
                act.t_in_phase = 0.0;
                act.next_interval = 0;
                if act.phase == act.phases.len() {
                    self.pos = (act.block.x_mm, act.block.y_mm);
                    self.speed = act.exit;
                    continue;
                }
            }
            self.active = Some(act);
        }
        ran
    }

    fn stop(&mut self) {
        let snap = self.snapshot();
        self.queue.clear();
        self.active = None;
        self.pos = snap.position_mm;
        self.speed = 0.0;
    }

    fn set_position(&mut self, position_mm: (f64, f64)) {
        self.stop();
        self.pos = position_mm;
    }

    fn snapshot(&self) -> Snapshot {
        match &self.active {
            None => Snapshot {
                position_mm: self.pos,
                speed_mm_per_s: 0.0,
                line: 0,
                s: 0.0,
                laser: LaserMode::Off,
                jog: false,
            },
            Some(act) => {
                let (d, v) = act.phases[act.phase].at(act.t_in_phase);
                let b = &act.block;
                Snapshot {
                    position_mm: (act.start.0 + act.dir.0 * d, act.start.1 + act.dir.1 * d),
                    speed_mm_per_s: v,
                    line: b.line,
                    s: if b.laser == LaserMode::Off { 0.0 } else { b.s * act.spindle_ov as f64 / 100.0 },
                    laser: b.laser,
                    jog: b.jog,
                }
            }
        }
    }

    fn clock_s(&self) -> f64 {
        self.clock
    }
}

fn limits(p: &MachineProfile) -> Limits {
    Limits {
        max_rate: (p.max_rate_mm_per_min.x / 60.0, p.max_rate_mm_per_min.y / 60.0),
        accel: (p.accel_mm_per_s2.x, p.accel_mm_per_s2.y),
        junction_deviation_mm: p.junction_deviation_mm,
        optical_power_w: p.optical_power_w,
        s_max: p.s_max,
        laser_mode: p.laser_mode,
        // Grid pitch: spot ÷ 3 (deposit.ts), on the narrow axis.
        step_mm: p.spot.sigma_x_mm.min(p.spot.sigma_y_mm) / 3.0,
    }
}

/// The grid pitch a profile samples at (plan.started's gridPitchMm).
pub fn grid_pitch_mm(profile: &MachineProfile) -> f64 {
    limits(profile).step_mm
}

/// Length and unit direction from `a` to `b`; `None` if they coincide.
fn segment(a: (f64, f64), b: (f64, f64)) -> Option<(f64, (f64, f64))> {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx.hypot(dy);
    (len > EPS).then(|| (len, (dx / len, dy / len)))
}

/// Largest value along `dir` that keeps each axis component within `limit`.
fn axis_limit(dir: (f64, f64), limit: (f64, f64)) -> f64 {
    let x = if dir.0.abs() > EPS { limit.0 / dir.0.abs() } else { f64::INFINITY };
    let y = if dir.1.abs() > EPS { limit.1 / dir.1.abs() } else { f64::INFINITY };
    x.min(y)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_profile;

    fn block(x: f64, y: f64, feed: f64, s: f64) -> Block {
        Block { x_mm: x, y_mm: y, feed_mm_per_min: feed, rapid: false, s, laser: LaserMode::M3, line: 1, jog: false }
    }

    fn run(p: &mut InterimPlanner) -> Vec<(f64, MotionSample)> {
        let mut out = Vec::new();
        p.advance(f64::INFINITY, Overrides::default(), &mut |t, s| out.push((t, s)));
        out
    }

    #[test]
    fn trapezoid_timing_and_energy() {
        let profile = test_profile();
        let mut p = InterimPlanner::new(&profile);
        // 100 mm at 6000 mm/min (100 mm/s), accel 1000 mm/s²: 0.1 s ramps of 5 mm each.
        p.push(block(100.0, 0.0, 6000.0, 1000.0));
        let samples = run(&mut p);
        let expected_t = 0.1 + 90.0 / 100.0 + 0.1;
        assert!((p.clock_s() - expected_t).abs() < 1e-9, "{}", p.clock_s());
        assert_eq!(p.snapshot().position_mm, (100.0, 0.0));
        let energy: f64 = samples.iter().map(|(_, s)| s.power_w as f64 * s.dt_s as f64).sum();
        // M3 at full S: 10 W for the whole move.
        assert!((energy - 10.0 * expected_t).abs() < 1e-4, "{energy}");
        // Samples are in time order and within the contract's step limits.
        assert!(samples.windows(2).all(|w| w[0].0 < w[1].0));
        assert!(samples.iter().all(|(_, s)| s.dt_s as f64 <= SAMPLE_DT_MAX_S + 1e-9));
        // n ≥ L / pitch per phase; equal-time intervals while accelerating can
        // be up to twice the average apart at the fast end.
        let pitch = grid_pitch_mm(&profile);
        assert!(samples.windows(2).all(|w| ((w[1].1.x_mm - w[0].1.x_mm) as f64) < 2.0 * pitch + 1e-4));
    }

    #[test]
    fn collinear_blocks_keep_speed_and_corners_slow_down() {
        let profile = test_profile();
        let mut straight = InterimPlanner::new(&profile);
        for i in 1..=10 {
            straight.push(block(i as f64 * 10.0, 0.0, 6000.0, 0.0));
        }
        run(&mut straight);
        // Same as one 100 mm block.
        assert!((straight.clock_s() - 1.1).abs() < 1e-9, "{}", straight.clock_s());

        let mut zigzag = InterimPlanner::new(&profile);
        for i in 1..=10 {
            zigzag.push(block(i as f64 * 10.0, if i % 2 == 0 { 0.0 } else { 10.0 }, 6000.0, 0.0));
        }
        run(&mut zigzag);
        assert!(zigzag.clock_s() > 10.0 * 14.14 / 100.0 + 0.2, "{}", zigzag.clock_s());
    }

    #[test]
    fn advance_stops_mid_block_and_resumes() {
        let mut p = InterimPlanner::new(&test_profile());
        p.push(block(100.0, 0.0, 6000.0, 1000.0));
        let mut n = 0;
        let ran = p.advance(0.5, Overrides::default(), &mut |_, _| n += 1);
        assert_eq!(ran, 0.5);
        let snap = p.snapshot();
        assert!((snap.position_mm.0 - (5.0 + 0.4 * 100.0)).abs() < 1e-9);
        assert_eq!((snap.speed_mm_per_s, snap.line), (100.0, 1));
        let rest = run(&mut p).len();
        let mut whole = InterimPlanner::new(&test_profile());
        whole.push(block(100.0, 0.0, 6000.0, 1000.0));
        assert_eq!(n + rest, run(&mut whole).len());
    }

    #[test]
    fn m4_scales_with_speed_and_overrides_apply() {
        let profile = test_profile();
        let mut p = InterimPlanner::new(&profile);
        p.push(Block { laser: LaserMode::M4, ..block(10.0, 0.0, 600.0, 500.0) });
        let mut powers = Vec::new();
        p.advance(f64::INFINITY, Overrides { spindle: 200, ..Default::default() }, &mut |_, s| powers.push(s.power_w));
        // S500 × 200 % = S1000 = full power at cruise, less while ramping.
        let max = powers.iter().cloned().fold(0.0, f32::max);
        assert!((max - 10.0).abs() < 1e-4, "{max}");
        assert!(powers[0] < max);

        let mut slow = InterimPlanner::new(&profile);
        slow.push(block(10.0, 0.0, 600.0, 0.0));
        slow.advance(f64::INFINITY, Overrides { feed: 50, ..Default::default() }, &mut |_, _| {});
        assert!(slow.clock_s() > 10.0 / 5.0, "{}", slow.clock_s());
    }

    #[test]
    fn rapids_and_beam_off_moves_are_not_sampled() {
        let mut p = InterimPlanner::new(&test_profile());
        p.push(Block { rapid: true, ..block(50.0, 0.0, 0.0, 1000.0) });
        p.push(Block { laser: LaserMode::Off, ..block(60.0, 0.0, 600.0, 1000.0) });
        p.push(block(70.0, 0.0, 600.0, 0.0));
        assert!(run(&mut p).is_empty());
        assert!(p.clock_s() > 0.0);
    }

    #[test]
    fn stop_keeps_the_current_position() {
        let mut p = InterimPlanner::new(&test_profile());
        p.push(block(100.0, 0.0, 6000.0, 0.0));
        p.push(block(100.0, 100.0, 6000.0, 0.0));
        p.advance(0.3, Overrides::default(), &mut |_, _| {});
        let at = p.snapshot().position_mm;
        p.stop();
        assert_eq!((p.queued(), p.snapshot().position_mm), (0, at));
    }

    #[test]
    fn curve_lookup_matches_the_contract() {
        let curve = test_profile().power_curve;
        assert_eq!(interpolate(&curve, 0.0), 0.0);
        assert_eq!(interpolate(&curve, 0.05), 0.0);
        assert!((interpolate(&curve, 0.15) - 0.09).abs() < 1e-12);
        assert_eq!(interpolate(&curve, 1.5), 1.0);
    }
}
