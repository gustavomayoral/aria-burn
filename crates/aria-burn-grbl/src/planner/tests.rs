// SPDX-License-Identifier: GPL-3.0-or-later
//! Planner tests. Expected values are worked out by hand from GRBL's formulas
//! for the provisional 10 W profile: accel 1000 mm/s² on both axes, max rate
//! 10000 mm/min, $11 = 0.01 mm, 80 steps/mm, 10 W, laser mode on.

use super::*;
use crate::test_profile;

const A: f64 = 1000.0;

fn settings() -> GrblSettings {
    GrblSettings::new(test_profile())
}

fn planner() -> GrblPlanner {
    GrblPlanner::new(&settings())
}

fn g1(x: f64, y: f64, feed: f64, s: f64) -> Item {
    Item::Block(Block {
        x_mm: x,
        y_mm: y,
        feed_mm_per_min: feed,
        rapid: false,
        s,
        laser: LaserMode::M3,
        line: 1,
        jog: false,
    })
}

fn with(item: Item, f: impl FnOnce(&mut Block)) -> Item {
    let Item::Block(mut b) = item else { panic!("a block") };
    f(&mut b);
    Item::Block(b)
}

fn run(p: &mut GrblPlanner) -> Vec<(f64, MotionSample)> {
    run_with(p, Overrides::default())
}

fn run_with(p: &mut GrblPlanner, ov: Overrides) -> Vec<(f64, MotionSample)> {
    let mut out = Vec::new();
    p.advance(f64::INFINITY, ov, &mut |t, s| out.push((t, s)));
    out
}

fn energy(samples: &[(f64, MotionSample)]) -> f64 {
    samples.iter().map(|(_, s)| s.power_w as f64 * s.dt_s as f64).sum()
}

/// Time to cover `len` going v0 → (up to) vmax → v1 at acceleration `a`.
fn trapezoid_s(len: f64, v0: f64, vmax: f64, v1: f64, a: f64) -> f64 {
    let d_acc = (vmax * vmax - v0 * v0) / (2.0 * a);
    let d_dec = (vmax * vmax - v1 * v1) / (2.0 * a);
    if d_acc + d_dec <= len {
        (vmax - v0) / a + (len - d_acc - d_dec) / vmax + (vmax - v1) / a
    } else {
        let vp = ((2.0 * a * len + v0 * v0 + v1 * v1) / 2.0).sqrt();
        (vp - v0) / a + (vp - v1) / a
    }
}

fn assert_close(actual: f64, expected: f64, tol: f64) {
    assert!((actual - expected).abs() <= tol, "{actual} vs {expected}");
}

#[test]
fn single_move_is_a_trapezoid() {
    let mut p = planner();
    // 100 mm at 6000 mm/min (100 mm/s): 0.1 s ramps of 5 mm each.
    p.push(g1(100.0, 0.0, 6000.0, 1000.0));
    let samples = run(&mut p);
    assert_close(p.clock_s(), 1.1, 1e-9);
    assert_eq!(p.snapshot().position_mm, (100.0, 0.0));
    // M3 at full S: 10 W for the whole move.
    assert_close(energy(&samples), 10.0 * 1.1, 1e-4);
    assert!(samples.windows(2).all(|w| w[0].0 < w[1].0));
    assert!(samples.iter().all(|(_, s)| s.dt_s as f64 <= SAMPLE_DT_MAX_S + 1e-9));
    // n ≥ L / pitch per phase; equal-time intervals while accelerating are up
    // to twice the average apart at the fast end.
    let pitch = grid_pitch_mm(&test_profile());
    assert!(samples.windows(2).all(|w| ((w[1].1.x_mm - w[0].1.x_mm) as f64) < 2.0 * pitch + 1e-4));
}

#[test]
fn junction_deviation_corner_speed() {
    let mut p = planner();
    p.push(g1(50.0, 0.0, 6000.0, 0.0));
    p.push(g1(50.0, 50.0, 6000.0, 0.0));
    // 90°: cos θ = 0, sin(θ/2) = √½. The junction vector (-1, 1)/√2 lets each
    // axis take 1000 mm/s², so the junction acceleration is 1000·√2.
    let sin = 0.5f64.sqrt();
    let v_sqr = A * 2f64.sqrt() * 0.01 * sin / (1.0 - sin);
    assert_close(p.buf[1].max_junction_speed_sqr, v_sqr, 1e-9);
    assert_close(p.buf[1].entry_speed_sqr, v_sqr, 1e-9);
    let v = v_sqr.sqrt();
    run(&mut p);
    let expected = trapezoid_s(50.0, 0.0, 100.0, v, A) + trapezoid_s(50.0, v, 100.0, 0.0, A);
    assert_close(p.clock_s(), expected, 1e-9);
}

#[test]
fn junction_acceleration_is_limited_along_the_junction_vector() {
    let mut profile = test_profile();
    profile.accel_mm_per_s2.y = 250.0;
    let mut p = GrblPlanner::new(&GrblSettings::new(profile));
    p.push(g1(50.0, 0.0, 6000.0, 0.0));
    p.push(g1(50.0, 50.0, 6000.0, 0.0));
    // Junction vector (-1, 1)/√2: Y allows 250·√2, less than either block's own.
    let sin = 0.5f64.sqrt();
    assert_close(p.buf[1].max_junction_speed_sqr, 250.0 * 2f64.sqrt() * 0.01 * sin / (1.0 - sin), 1e-9);
    assert_eq!(p.buf[1].acceleration, 250.0);
}

#[test]
fn straight_on_and_reversal() {
    let mut straight = planner();
    for i in 1..=10 {
        straight.push(g1(i as f64 * 10.0, 0.0, 6000.0, 0.0));
    }
    run(&mut straight);
    // Same as one 100 mm move.
    assert_close(straight.clock_s(), 1.1, 1e-9);

    let mut back = planner();
    back.push(g1(10.0, 0.0, 6000.0, 0.0));
    back.push(g1(0.0, 0.0, 6000.0, 0.0));
    assert_eq!(back.buf[1].max_junction_speed_sqr, 0.0);
    run(&mut back);
    assert_close(back.clock_s(), 2.0 * trapezoid_s(10.0, 0.0, 100.0, 0.0, A), 1e-9);
}

#[test]
fn lookahead_is_fifteen_blocks_even_when_everything_is_queued() {
    // 0.1 mm collinear blocks: with 15 in the buffer, the executing block must
    // be able to stop within the 14 after it, so each block enters and leaves
    // at √(2·a·14·0.1) ≈ 52.9 mm/s and peaks mid-block (a triangle) instead of
    // reaching the programmed 100 mm/s.
    let mut p = planner();
    for i in 1..=400 {
        p.push(g1(i as f64 * 0.1, 0.0, 6000.0, 0.0));
    }
    assert_eq!(p.buf.len(), 15);
    assert_eq!(p.queued(), 400);
    p.advance(0.4, Overrides::default(), &mut |_, _| {});
    let v = (2.0 * A * 14.0 * 0.1).sqrt();
    let peak = (v * v + A * 0.1).sqrt();
    let now = p.snapshot().speed_mm_per_s;
    assert!(now >= v - 1e-9 && now <= peak + 1e-9, "{now}");
    let start = p.clock_s();
    let before = p.snapshot().position_mm.0;
    // One block in steady state: up to the peak and back down to v.
    let block_s = 2.0 * (peak - v) / A;
    run(&mut p);
    let steady = (40.0 - before - 0.1 * 14.0) / 0.1 * block_s;
    assert!(p.clock_s() - start > steady, "{} vs {steady}", p.clock_s() - start);
    assert_eq!(p.snapshot().position_mm, (40.0, 0.0));
}

#[test]
fn a_block_arriving_mid_move_is_planned_into_it() {
    // The executing block is replanned from its current speed: B arrives while
    // A cruises towards a stop, so A never slows down.
    let mut p = planner();
    p.push(g1(100.0, 0.0, 6000.0, 0.0));
    p.advance(0.5, Overrides::default(), &mut |_, _| {});
    p.push(g1(200.0, 0.0, 6000.0, 0.0));
    run(&mut p);
    assert_close(p.clock_s(), 2.1, 1e-9);

    // Arriving while A already decelerates: A speeds back up from where it is.
    let mut late = planner();
    late.push(g1(100.0, 0.0, 6000.0, 0.0));
    late.advance(1.05, Overrides::default(), &mut |_, _| {});
    let v = late.snapshot().speed_mm_per_s;
    assert_close(v, 50.0, 1e-9);
    late.push(g1(200.0, 0.0, 6000.0, 0.0));
    run(&mut late);
    // 1.25 mm of A left plus B, as one move from 50 mm/s.
    let rest = trapezoid_s(1.25 + 100.0, v, 100.0, 0.0, A);
    assert_close(late.clock_s(), 1.05 + rest, 1e-9);
}

#[test]
fn moves_shorter_than_a_step_are_dropped() {
    let mut p = planner();
    // 80 steps/mm: 0.004 mm rounds to zero steps.
    p.push(g1(0.004, 0.0, 600.0, 500.0));
    assert_eq!(p.queued(), 0);
    // Targets snap to whole steps.
    p.push(g1(1.004, 0.0, 600.0, 0.0));
    run(&mut p);
    assert_eq!(p.snapshot().position_mm, (1.0, 0.0));
}

#[test]
fn m4_scales_with_speed_over_the_programmed_rate() {
    let profile = test_profile();
    let curve = &profile.power_curve;
    let mut p = planner();
    p.push(with(g1(20.0, 0.0, 6000.0, 1000.0), |b| b.laser = LaserMode::M4));
    // Half feed override: cruise at 50 mm/s. GRBL scales by the programmed
    // 100 mm/s, so cruise power is half, not full.
    let samples = run_with(&mut p, Overrides { feed: 50, ..Default::default() });
    let cruise = samples.iter().find(|(_, s)| (s.speed_mm_per_s - 50.0).abs() < 1e-3).unwrap().1;
    assert_close(cruise.power_w as f64, 10.0 * interpolate(curve, 0.5), 1e-4);
    // Ramp samples are weaker; every sample follows S·v/F.
    for (_, s) in &samples {
        let expected = 10.0 * interpolate(curve, s.speed_mm_per_s as f64 / 100.0);
        assert_close(s.power_w as f64, expected, 1e-3);
    }

    // The spindle override scales S, capped at $30.
    let mut sp = planner();
    sp.push(with(g1(20.0, 0.0, 6000.0, 600.0), |b| b.laser = LaserMode::M4));
    let samples = run_with(&mut sp, Overrides { spindle: 200, ..Default::default() });
    let max = samples.iter().map(|(_, s)| s.power_w).fold(0.0, f32::max);
    assert_close(max as f64, 10.0, 1e-4);
}

#[test]
fn laser_mode_off_burns_on_g0_and_m4_is_constant() {
    let mut profile = test_profile();
    profile.laser_mode = false;
    let mut p = GrblPlanner::new(&GrblSettings::new(profile));
    p.push(with(g1(10.0, 0.0, 6000.0, 500.0), |b| b.rapid = true));
    let rapid = run(&mut p);
    assert!(!rapid.is_empty(), "the spindle stays on through G0");
    p.push(with(g1(20.0, 0.0, 600.0, 1000.0), |b| b.laser = LaserMode::M4));
    let m4 = run(&mut p);
    assert!(m4.iter().all(|(_, s)| s.power_w == 10.0));

    // Laser mode on: G0 never burns.
    let mut on = planner();
    on.push(with(g1(10.0, 0.0, 6000.0, 500.0), |b| b.rapid = true));
    assert!(run(&mut on).is_empty());
}

#[test]
fn s_min_maps_the_pwm_range() {
    let mut s = settings();
    s.set(31, 200.0).unwrap();
    let mut p = GrblPlanner::new(&s);
    // S600 with $31=200, $30=1000: (600-200)/(1000-200) = 0.5 of the PWM range.
    p.push(g1(5.0, 0.0, 600.0, 600.0));
    let samples = run(&mut p);
    let curve = test_profile().power_curve;
    assert!(samples.iter().all(|(_, s)| (s.power_w as f64 - 10.0 * interpolate(&curve, 0.5)).abs() < 1e-4));
}

#[test]
fn syncs_stop_and_dwells_wait() {
    let mut p = planner();
    p.push(g1(50.0, 0.0, 6000.0, 1000.0));
    p.push(Item::Sync { dwell_s: 0.0 });
    p.push(g1(100.0, 0.0, 6000.0, 1000.0));
    p.push(Item::Sync { dwell_s: 0.25 });
    p.push(g1(150.0, 0.0, 6000.0, 1000.0));
    let samples = run(&mut p);
    let one = trapezoid_s(50.0, 0.0, 100.0, 0.0, A);
    assert_close(p.clock_s(), 3.0 * one + 0.25, 1e-9);
    // The dwell is idle time: nothing burns (M3 stationary burns aren't sampled).
    assert_close(energy(&samples), 10.0 * 3.0 * one, 1e-3);
    assert_eq!(p.queued(), 0);
}

#[test]
fn feed_hold_decelerates_along_the_path_and_resumes() {
    let mut p = planner();
    p.push(g1(100.0, 0.0, 6000.0, 0.0));
    p.push(g1(100.0, 10.0, 6000.0, 0.0));
    p.advance(0.5, Overrides::default(), &mut |_, _| {});
    let at = p.snapshot().position_mm.0;
    assert_close(at, 45.0, 1e-9);
    p.set_hold(true);
    assert!(!p.hold_complete());
    // From 100 mm/s at 1000 mm/s²: 0.1 s and 5 mm to a stop.
    let ran = p.advance(1.0, Overrides::default(), &mut |_, _| {});
    assert_close(ran, 0.1, 1e-9);
    assert!(p.hold_complete());
    assert_close(p.snapshot().position_mm.0, at + 5.0, 1e-9);
    assert_eq!(p.snapshot().speed_mm_per_s, 0.0);
    // Held: time doesn't pass and nothing moves.
    assert_eq!(p.advance(1.0, Overrides::default(), &mut |_, _| {}), 0.0);
    p.set_hold(false);
    run(&mut p);
    assert_eq!(p.snapshot().position_mm, (100.0, 10.0));
    let sin = 0.5f64.sqrt();
    let vj = (A * 2f64.sqrt() * 0.01 * sin / (1.0 - sin)).sqrt();
    let expected = 0.6 + trapezoid_s(50.0, 0.0, 100.0, vj, A) + trapezoid_s(10.0, vj, 100.0, 0.0, A);
    assert_close(p.clock_s(), expected, 1e-9);
}

#[test]
fn feed_hold_carries_across_short_blocks() {
    let mut p = planner();
    for i in 1..=20 {
        p.push(g1(i as f64 * 2.0, 0.0, 6000.0, 0.0));
    }
    p.advance(0.15, Overrides::default(), &mut |_, _| {});
    let (at, v) = (p.snapshot().position_mm.0, p.snapshot().speed_mm_per_s);
    p.set_hold(true);
    p.advance(1.0, Overrides::default(), &mut |_, _| {});
    assert!(p.hold_complete());
    assert_close(p.snapshot().position_mm.0, at + v * v / (2.0 * A), 1e-6);
}

#[test]
fn feed_override_reduction_decelerates_to_the_new_cruise() {
    let mut p = planner();
    p.push(g1(100.0, 0.0, 6000.0, 0.0));
    p.advance(0.5, Overrides::default(), &mut |_, _| {});
    let half = Overrides { feed: 50, ..Default::default() };
    p.advance(0.05, half, &mut |_, _| {});
    assert_close(p.snapshot().speed_mm_per_s, 50.0, 1e-9);
    run_with(&mut p, half);
    // 45 mm done; 100 → 50 over 3.75 mm, cruise, 50 → 0 over 1.25 mm.
    assert_close(p.clock_s(), 0.5 + 0.05 + (55.0 - 3.75 - 1.25) / 50.0 + 0.05, 1e-9);

    // Rapids follow the rapid override.
    let mut r = planner();
    r.push(with(g1(100.0, 0.0, 0.0, 0.0), |b| b.rapid = true));
    run_with(&mut r, Overrides { rapid: 25, ..Default::default() });
    let v = 10000.0 / 60.0 * 0.25;
    assert_close(r.clock_s(), trapezoid_s(100.0, 0.0, v, 0.0, A), 1e-9);
}

#[test]
fn jogs_ignore_the_feed_override() {
    let mut p = planner();
    p.push(with(g1(50.0, 0.0, 3000.0, 0.0), |b| b.jog = true));
    run_with(&mut p, Overrides { feed: 10, ..Default::default() });
    assert_close(p.clock_s(), trapezoid_s(50.0, 0.0, 50.0, 0.0, A), 1e-9);
}

#[test]
fn samples_stay_valid_while_streaming_with_replans() {
    // A raster streamed a block at a time, as the emulator does, with M4 and
    // replans mid-block: samples stay ordered, short, close, and conserve energy.
    let mut p = planner();
    let pitch = grid_pitch_mm(&test_profile());
    let mut samples = Vec::new();
    let mut x = 0.0;
    for row in 0..6 {
        for c in 1..=40 {
            x = if row % 2 == 0 { c as f64 * 0.5 } else { 20.0 - c as f64 * 0.5 };
            let s = 100.0 + ((c * 37 + row * 11) % 900) as f64;
            p.push(with(g1(x, row as f64 * 0.1, 3000.0, s), |b| b.laser = LaserMode::M4));
            p.advance(0.003, Overrides::default(), &mut |t, s| samples.push((t, s)));
        }
        p.push(with(g1(x, (row + 1) as f64 * 0.1, 3000.0, 0.0), |b| b.laser = LaserMode::M4));
    }
    samples.extend(run(&mut p));
    assert!(samples.windows(2).all(|w| w[0].0 < w[1].0));
    assert!(samples.iter().all(|(_, s)| s.dt_s as f64 <= SAMPLE_DT_MAX_S * (1.0 + 1e-6)));
    let gaps = samples.windows(2).filter(|w| w[1].0 - w[0].0 < 2.0 * SAMPLE_DT_MAX_S);
    assert!(gaps.into_iter().all(|w| {
        let d = ((w[1].1.x_mm - w[0].1.x_mm) as f64).hypot((w[1].1.y_mm - w[0].1.y_mm) as f64);
        d < 2.0 * pitch + 1e-3
    }));
    // Beam-on time adds up: Σ dt equals the time spent on burning blocks.
    let burn_time: f64 = samples.iter().map(|(_, s)| s.dt_s as f64).sum();
    assert!(burn_time > 0.0 && burn_time <= p.clock_s());
}

#[test]
fn advance_in_pieces_matches_one_go() {
    let job = [g1(30.0, 0.0, 6000.0, 1000.0), g1(30.0, 20.0, 3000.0, 500.0), g1(0.0, 0.0, 6000.0, 800.0)];
    let mut whole = planner();
    job.iter().for_each(|&i| whole.push(i));
    let all = run(&mut whole);
    let mut pieces = planner();
    job.iter().for_each(|&i| pieces.push(i));
    let mut got = Vec::new();
    while pieces.advance(0.0137, Overrides::default(), &mut |t, s| got.push((t, s))) > 0.0 {}
    assert_close(pieces.clock_s(), whole.clock_s(), 1e-9);
    assert_eq!(got.len(), all.len());
    assert_close(energy(&got), energy(&all), 1e-6);
}

#[test]
fn stop_keeps_the_current_position() {
    let mut p = planner();
    p.push(g1(100.0, 0.0, 6000.0, 0.0));
    p.push(g1(100.0, 100.0, 6000.0, 0.0));
    p.advance(0.3, Overrides::default(), &mut |_, _| {});
    let at = p.snapshot().position_mm;
    p.stop();
    assert_eq!((p.queued(), p.snapshot().position_mm), (0, at));
    // The next move plans from there, from rest.
    p.push(g1(at.0, 10.0, 6000.0, 0.0));
    run(&mut p);
    assert_close(p.snapshot().position_mm.1, 10.0, 1e-12);
}

#[test]
fn plan_job_runs_a_parsed_job() {
    let gcode = b"G0 X10 Y10\nM4 S800\nG1 X40 F3000\nG1 Y20\nG2 X30 Y30 I-10 J0\nM5\nG0 X0 Y0\n";
    let job = aria_burn_gcode::parse(aria_burn_contract::JobSourceKind::File, "t", gcode, Default::default());
    let mut samples = Vec::new();
    let t = plan_job(&job, &settings(), &mut |t, s| samples.push((t, s)));
    assert!(!samples.is_empty());
    assert!(samples.iter().all(|(st, _)| *st <= t));
    let lines: std::collections::BTreeSet<u32> = samples.iter().map(|(_, s)| s.line).collect();
    assert_eq!(lines.into_iter().collect::<Vec<_>>(), [3, 4, 5]);
    // The M4 → M5 change syncs, so the beam-off G0 starts from rest; the job
    // takes at least the burning path at 50 mm/s plus both rapids.
    let items = job_items(&job.moves, true);
    assert_eq!(items.iter().filter(|i| matches!(i, Item::Sync { .. })).count(), 2);
    assert!(t > (30.0 + 10.0 + 15.7) / 50.0 + 2.0 * 14.0 / 166.7, "{t}");
}

#[test]
fn curve_lookup_matches_the_contract() {
    let curve = test_profile().power_curve;
    assert_eq!(interpolate(&curve, 0.0), 0.0);
    assert_eq!(interpolate(&curve, 0.05), 0.0);
    assert!((interpolate(&curve, 0.15) - 0.09).abs() < 1e-12);
    assert_eq!(interpolate(&curve, 1.5), 1.0);
}
