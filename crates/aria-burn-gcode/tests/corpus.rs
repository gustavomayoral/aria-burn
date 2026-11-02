// SPDX-License-Identifier: GPL-3.0-or-later
//! Parses every file in `tests/corpus/` and checks bounds, line numbers, passes
//! and diagnostics, and that a streamed parse (bytes in arbitrary chunks, as
//! from the emulator's socket) equals the whole-file parse.
//!
//! The corpus is synthetic for now (see `corpus/README.md`).

use std::{fs, path::PathBuf};

use aria_burn_contract::{BoundsMm, CONTRACT_DIR, DiagnosticSeverity, JobModel, JobSourceKind, LaserMode};
use aria_burn_gcode::{ParseOptions, Parser, beam_on, parse};
use serde_json::Value;

const FILES: &[&str] = &[
    "square-10mm.gcode",
    "lightburn-vector.gcode",
    "lightburn-raster.gcode",
    "lightburn-multipass.gcode",
    "lasergrbl-raster.gcode",
    "mixed.gcode",
    "inches.gcode",
];

fn read(name: &str) -> Vec<u8> {
    fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus").join(name)).unwrap()
}

fn load(name: &str) -> JobModel {
    parse(JobSourceKind::File, name, &read(name), ParseOptions::default())
}

/// 1-based line of the first source line containing `needle`.
fn line_of(name: &str, needle: &str) -> u32 {
    let text = String::from_utf8(read(name)).unwrap();
    text.lines().position(|l| l.contains(needle)).unwrap_or_else(|| panic!("{needle:?} not in {name}")) as u32 + 1
}

fn bounds(b: &BoundsMm) -> [f64; 4] {
    let r = |v: f64| (v * 1e9).round() / 1e9;
    [r(b.min_x_mm), r(b.min_y_mm), r(b.max_x_mm), r(b.max_y_mm)]
}

fn codes(job: &JobModel) -> Vec<(&str, u32)> {
    job.diagnostics.iter().map(|d| (d.code.as_str(), d.line)).collect()
}

fn passes(job: &JobModel) -> Vec<(u32, u32, Option<&str>)> {
    job.passes.iter().map(|p| (p.first_move, p.move_count, p.label.as_deref())).collect()
}

/// JSON equality with numbers equal to 1e-9 (arc chords come from cos/sin).
fn close_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() < 1e-9,
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| close_json(a, b)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| close_json(v, w)))
        }
        _ => a == b,
    }
}

#[test]
fn reproduces_the_contract_fixture() {
    let name = "square-10mm.gcode";
    let job =
        parse(JobSourceKind::File, name, &read(name), ParseOptions { arc_tolerance_mm: 1.0, ..Default::default() });
    let fixture: Value =
        serde_json::from_str(&fs::read_to_string(PathBuf::from(CONTRACT_DIR).join("fixtures/job-model.json")).unwrap())
            .unwrap();
    let ours = serde_json::to_value(&job).unwrap();
    assert!(close_json(&ours, &fixture), "parsed:\n{ours:#}\nfixture:\n{fixture:#}");
}

#[test]
fn lightburn_vector() {
    let name = "lightburn-vector.gcode";
    let job = load(name);
    assert_eq!(bounds(&job.bounds), [0.0, 0.0, 45.0, 35.0]);
    assert_eq!(bounds(job.burn_bounds.as_ref().unwrap()), [5.0, 5.0, 45.0, 35.0]);
    assert_eq!(codes(&job), vec![("ignored-coolant", line_of(name, "M8"))]);
    assert_eq!(passes(&job), vec![(0, job.moves.len() as u32, Some("C00"))]);
    let first_cut = job.moves.iter().find(|m| beam_on(m)).unwrap();
    assert_eq!((first_cut.line, first_cut.s, first_cut.laser), (line_of(name, "G1 X45S600F600"), 600.0, LaserMode::M4));
    // The full circle: many chords on one line, closing where it started.
    let circle: Vec<_> = job.moves.iter().filter(|m| m.arc == Some(true)).collect();
    assert!(circle.len() > 50);
    assert!(circle.iter().all(|m| m.line == line_of(name, "G2 X25Y20")));
    assert_eq!((circle.last().unwrap().x_mm, circle.last().unwrap().y_mm), (25.0, 20.0));
}

#[test]
fn lightburn_raster() {
    let name = "lightburn-raster.gcode";
    let job = load(name);
    assert_eq!(bounds(job.burn_bounds.as_ref().unwrap()), [10.0, 10.0, 14.0, 10.3]);
    assert_eq!(bounds(&job.bounds), [0.0, 0.0, 14.0, 10.3]);
    let burned: Vec<_> = job.moves.iter().filter(|m| beam_on(m)).map(|m| (m.x_mm, m.s, m.line)).collect();
    assert_eq!(burned[0], (11.0, 400.0, line_of(name, "G1 X1S400F3000")));
    assert_eq!(burned.len(), 6);
    // The last move is the absolute G0 home after G90.
    let last = job.moves.last().unwrap();
    assert_eq!((last.x_mm, last.y_mm), (0.0, 0.0));
    assert_eq!(passes(&job).len(), 1);
}

#[test]
fn lightburn_multipass() {
    let name = "lightburn-multipass.gcode";
    let job = load(name);
    // Pass 2's `G0 X20Y20` is zero-length (the head is already there), so it has 4 moves.
    assert_eq!(passes(&job), vec![(0, 5, Some("C02")), (5, 4, Some("C02")), (9, 3, Some("C03"))]);
    let second_pass_first_cut = job.moves[5].line;
    assert_eq!(codes(&job), vec![("ignored-coolant", line_of(name, "M8")), ("multi-pass", second_pass_first_cut)]);
    assert_eq!(bounds(job.burn_bounds.as_ref().unwrap()), [20.0, 20.0, 60.0, 30.0]);
}

#[test]
fn lasergrbl_raster() {
    let name = "lasergrbl-raster.gcode";
    let job = load(name);
    assert!(job.diagnostics.is_empty());
    assert_eq!(bounds(job.burn_bounds.as_ref().unwrap()), [2.0, 1.0, 6.0, 1.2]);
    assert!(job.moves.iter().filter(|m| beam_on(m)).all(|m| m.laser == LaserMode::M3 && m.feed_mm_per_min == 1500.0));
    assert_eq!(job.moves.iter().filter(|m| beam_on(m)).count(), 6);
    let s255 = job.moves.iter().find(|m| m.s == 255.0).unwrap();
    assert_eq!(s255.line, line_of(name, "X4 S255"));
}

#[test]
fn mixed() {
    let name = "mixed.gcode";
    let job = load(name);
    assert!(job.diagnostics.is_empty());
    // G92 shifts the program origin to (100, 100) until G92.1.
    assert_eq!(bounds(job.burn_bounds.as_ref().unwrap()), [100.0, 95.0, 120.0, 110.1]);
    assert_eq!(bounds(&job.bounds), [0.0, 0.0, 120.0, 110.1]);
    let r_arc = line_of(name, "G2 X20 Y0 R5");
    let top = job.moves.iter().filter(|m| m.line == r_arc).map(|m| m.y_mm).fold(f64::MIN, f64::max);
    assert!((top - 105.0).abs() < 0.01, "CW from left to right bulges up, reached {top}");
    assert!(job.moves.iter().filter(|m| m.line == line_of(name, "G3 X10")).all(|m| m.arc == Some(true)));
    let last = job.moves.last().unwrap();
    assert_eq!((last.x_mm, last.y_mm), (0.0, 0.0));
}

#[test]
fn inches_are_rejected() {
    let name = "inches.gcode";
    let job = load(name);
    assert_eq!(codes(&job), vec![("unsupported-units", line_of(name, "G20"))]);
    assert_eq!(job.diagnostics[0].severity, DiagnosticSeverity::Error);
    assert!(job.moves.is_empty() && job.passes.is_empty() && job.burn_bounds.is_none());
}

#[test]
fn line_count_matches_the_file() {
    for name in FILES {
        let job = load(name);
        assert_eq!(job.source.line_count as usize, String::from_utf8(read(name)).unwrap().lines().count(), "{name}");
    }
}

#[test]
fn streaming_equals_whole_file() {
    for name in FILES {
        let bytes = read(name);
        let whole = serde_json::to_value(load(name)).unwrap();
        for seed in 1..=8u64 {
            let mut parser = Parser::new(JobSourceKind::File, *name, ParseOptions::default());
            let mut rng = seed;
            let mut rest = &bytes[..];
            while !rest.is_empty() {
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let n = ((rng >> 33) % 17 + 1).min(rest.len() as u64) as usize;
                parser.feed_bytes(&rest[..n]);
                rest = &rest[n..];
            }
            assert_eq!(serde_json::to_value(parser.finish()).unwrap(), whole, "{name}, seed {seed}");
        }
        // CRLF line endings parse the same.
        let crlf = String::from_utf8(bytes.clone()).unwrap().replace('\n', "\r\n");
        let job = parse(JobSourceKind::File, *name, crlf.as_bytes(), ParseOptions::default());
        assert_eq!(serde_json::to_value(job).unwrap(), whole, "{name}, CRLF");
    }
}

#[test]
fn streaming_line_by_line_reports_moves_as_they_arrive() {
    let name = "lightburn-multipass.gcode";
    let text = String::from_utf8(read(name)).unwrap();
    let mut parser = Parser::new(JobSourceKind::Network, "live", ParseOptions::default());
    let mut seen = 0;
    for line in text.lines() {
        let added = parser.feed_line(line).unwrap();
        assert_eq!(added.start, seen);
        seen = added.end;
        assert_eq!(parser.moves().len(), seen);
    }
    let job = parser.finish();
    assert_eq!(job.moves.len(), seen);
    assert_eq!(job.source.kind, JobSourceKind::Network);
}
