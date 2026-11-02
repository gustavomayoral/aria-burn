// SPDX-License-Identifier: GPL-3.0-or-later
//! G2/G3 arcs in the XY plane, flattened into chords within GRBL's arc
//! tolerance (`$12`), with GRBL's validity rules for the radius and R forms.

use std::f64::consts::TAU;

use crate::LineError;

/// GRBL's `ARC_ANGULAR_TRAVEL_EPSILON`: below this, start = end means a full circle.
const ANGULAR_EPSILON: f64 = 5e-7;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Center {
    /// I/J: centre offset from the start point (G91.1, GRBL's only mode).
    Offset(f64, f64),
    /// R: signed radius; negative selects the arc longer than 180°.
    Radius(f64),
}

/// Chord end points from `start` to `end` (the last one is `end` exactly).
pub fn flatten(
    start: (f64, f64),
    end: (f64, f64),
    center: Center,
    clockwise: bool,
    tolerance_mm: f64,
) -> Result<Vec<(f64, f64)>, LineError> {
    let (i, j) = match center {
        Center::Offset(i, j) => (i, j),
        Center::Radius(r) => radius_to_offset(start, end, r, clockwise)?,
    };
    let c = (start.0 + i, start.1 + j);
    let r0 = i.hypot(j);
    let r1 = (end.0 - c.0).hypot(end.1 - c.1);
    if r0 == 0.0 {
        return Err(LineError::arc("arc centre is the start point"));
    }
    let dr = (r1 - r0).abs();
    if dr > 0.005 && dr > 0.001 * r0 {
        return Err(LineError::arc(&format!(
            "end point is {dr:.4} mm off the arc radius ({r0:.4} at start, {r1:.4} at end)"
        )));
    }
    let a0 = (start.1 - c.1).atan2(start.0 - c.0);
    let mut travel = (end.1 - c.1).atan2(end.0 - c.0) - a0;
    if clockwise {
        if travel >= -ANGULAR_EPSILON {
            travel -= TAU;
        }
    } else if travel <= ANGULAR_EPSILON {
        travel += TAU;
    }
    // GRBL's segment count (floored, as the firmware does), so chords match the machine.
    let segments = if r0 > tolerance_mm {
        ((0.5 * travel * r0).abs() / (tolerance_mm * (2.0 * r0 - tolerance_mm)).sqrt()).floor() as usize
    } else {
        1
    }
    .max(1);
    let mut points: Vec<_> = (1..segments)
        .map(|k| {
            let a = a0 + travel * k as f64 / segments as f64;
            (c.0 + r0 * a.cos(), c.1 + r0 * a.sin())
        })
        .collect();
    points.push(end);
    Ok(points)
}

/// GRBL's R-form centre: the centre on the chord's perpendicular bisector.
fn radius_to_offset(start: (f64, f64), end: (f64, f64), r: f64, clockwise: bool) -> Result<(f64, f64), LineError> {
    let (dx, dy) = (end.0 - start.0, end.1 - start.1);
    let d = dx.hypot(dy);
    if d == 0.0 {
        return Err(LineError::arc("R-form arc needs an end point different from the start"));
    }
    let h2 = 4.0 * r * r - dx * dx - dy * dy;
    if h2 < 0.0 {
        return Err(LineError::arc(&format!("radius {} mm is too small for a {d:.4} mm chord", r.abs())));
    }
    let mut h = -h2.sqrt() / d;
    if !clockwise {
        h = -h;
    }
    if r < 0.0 {
        h = -h;
    }
    Ok((0.5 * (dx - dy * h), 0.5 * (dy + dx * h)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9
    }

    #[test]
    fn chords_stay_within_tolerance() {
        let tol = 0.002;
        let pts = flatten((10.0, 0.0), (0.0, 10.0), Center::Offset(-10.0, 0.0), false, tol).unwrap();
        assert!(pts.len() > 10);
        assert!(close(*pts.last().unwrap(), (0.0, 10.0)));
        let mut prev = (10.0, 0.0);
        for p in pts {
            assert!((p.0.hypot(p.1) - 10.0).abs() < 1e-9, "on the circle");
            let mid = ((prev.0 + p.0) / 2.0, (prev.1 + p.1) / 2.0);
            // GRBL floors the segment count, so the sagitta can overshoot $12 slightly.
            assert!(10.0 - mid.0.hypot(mid.1) <= tol * 1.05, "sagitta within tolerance");
            prev = p;
        }
    }

    #[test]
    fn direction_picks_the_side() {
        // CCW from (1,0) to (-1,0) about the origin passes through +Y, CW through -Y.
        let ccw = flatten((1.0, 0.0), (-1.0, 0.0), Center::Offset(-1.0, 0.0), false, 0.01).unwrap();
        let cw = flatten((1.0, 0.0), (-1.0, 0.0), Center::Offset(-1.0, 0.0), true, 0.01).unwrap();
        assert!(ccw[ccw.len() / 2].1 > 0.9);
        assert!(cw[cw.len() / 2].1 < -0.9);
    }

    #[test]
    fn full_circle_when_start_equals_end() {
        let pts = flatten((5.0, 0.0), (5.0, 0.0), Center::Offset(-5.0, 0.0), true, 0.002).unwrap();
        let min_y = pts.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let max_y = pts.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
        assert!(min_y < -4.99 && max_y > 4.99);
    }

    #[test]
    fn radius_form_matches_offset_form() {
        let ij = flatten((0.0, 0.0), (10.0, 0.0), Center::Offset(5.0, 0.0), true, 0.002).unwrap();
        let r = flatten((0.0, 0.0), (10.0, 0.0), Center::Radius(5.0), true, 0.002).unwrap();
        assert_eq!(ij.len(), r.len());
        assert!(ij.iter().zip(&r).all(|(a, b)| close(*a, *b)));
        // Negative R takes the long way round: more chords for the same chord ends.
        let short = flatten((0.0, 0.0), (6.0, 0.0), Center::Radius(5.0), false, 0.002).unwrap();
        let long = flatten((0.0, 0.0), (6.0, 0.0), Center::Radius(-5.0), false, 0.002).unwrap();
        assert!(long.len() > short.len());
    }

    #[test]
    fn invalid_arcs() {
        assert!(flatten((0.0, 0.0), (10.0, 0.0), Center::Offset(5.0, 0.0), true, 0.002).is_ok());
        assert_eq!(flatten((0.0, 0.0), (11.0, 0.0), Center::Offset(5.0, 0.0), true, 0.002).unwrap_err().grbl_error, 33);
        assert_eq!(flatten((0.0, 0.0), (20.0, 0.0), Center::Radius(5.0), true, 0.002).unwrap_err().grbl_error, 33);
        assert_eq!(flatten((1.0, 1.0), (1.0, 1.0), Center::Radius(5.0), true, 0.002).unwrap_err().grbl_error, 33);
        assert_eq!(flatten((1.0, 1.0), (2.0, 1.0), Center::Offset(0.0, 0.0), true, 0.002).unwrap_err().grbl_error, 33);
    }
}
