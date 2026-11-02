// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;

fn job(text: &str) -> JobModel {
    parse(JobSourceKind::File, "test.gcode", text.as_bytes(), ParseOptions::default())
}

fn ends(job: &JobModel) -> Vec<(f64, f64)> {
    job.moves.iter().map(|m| (m.x_mm, m.y_mm)).collect()
}

fn codes(job: &JobModel) -> Vec<(&str, u32)> {
    job.diagnostics.iter().map(|d| (d.code.as_str(), d.line)).collect()
}

#[test]
fn modal_state_resolves_onto_moves() {
    let j = job("G21 G90\nF1000\nM4 S500\nG1 X10\nY5 S250\nG0 X0 Y0\nM5\nG1 X1 F300\n");
    let m = &j.moves;
    assert_eq!(ends(&j), vec![(10.0, 0.0), (10.0, 5.0), (0.0, 0.0), (1.0, 0.0)]);
    assert_eq!(
        (m[0].kind, m[0].laser, m[0].s, m[0].feed_mm_per_min, m[0].line),
        (MoveKind::G1, LaserMode::M4, 500.0, 1000.0, 4)
    );
    assert_eq!((m[1].s, m[1].line), (250.0, 5));
    assert_eq!(m[2].kind, MoveKind::G0);
    assert_eq!((m[3].laser, m[3].feed_mm_per_min), (LaserMode::Off, 300.0));
    assert_eq!(j.source.line_count, 8);
    assert!(j.diagnostics.is_empty());
}

#[test]
fn words_on_a_line_apply_before_its_motion() {
    let j = job("G1 X10 F600 S800 M3\n");
    assert_eq!((j.moves[0].laser, j.moves[0].s, j.moves[0].feed_mm_per_min), (LaserMode::M3, 800.0, 600.0));
}

#[test]
fn relative_moves_become_absolute() {
    let j = job("G0 X5 Y5\nG91\nG1 X1 F100\nY2\nX-3 Y-1\nG90\nG1 X0\n");
    assert_eq!(ends(&j), vec![(5.0, 5.0), (6.0, 5.0), (6.0, 7.0), (3.0, 6.0), (0.0, 6.0)]);
}

#[test]
fn g92_offsets_and_g53() {
    let j = job("G0 X10 Y10\nG92 X0 Y0\nG0 X5\nG53 G0 X1 Y1\nG92.1\nG0 X2\n");
    assert_eq!(ends(&j), vec![(10.0, 10.0), (15.0, 10.0), (1.0, 1.0), (2.0, 1.0)]);
}

#[test]
fn start_position_option() {
    let opts = ParseOptions { start_mm: (3.0, 4.0), ..Default::default() };
    let j = parse(JobSourceKind::File, "t", b"G91\nG0 X1\n", opts);
    assert_eq!(ends(&j), vec![(4.0, 4.0)]);
    assert_eq!((j.start_mm.x_mm, j.start_mm.y_mm), (3.0, 4.0));
    assert_eq!(j.bounds.min_x_mm, 3.0);
}

#[test]
fn arcs_become_flagged_chords_on_their_line() {
    let j = job("G0 X10 Y0\nM4 S100 F600\nG3 X0 Y10 I-10 J0\nG1 X0 Y20\n");
    let arc: Vec<_> = j.moves.iter().filter(|m| m.arc == Some(true)).collect();
    assert!(arc.len() > 10);
    assert!(arc.iter().all(|m| m.line == 3 && m.kind == MoveKind::G1 && m.s == 100.0));
    assert_eq!(j.moves.last().unwrap().arc, None);
    let last_arc = arc.last().unwrap();
    assert_eq!((last_arc.x_mm, last_arc.y_mm), (0.0, 10.0));
}

#[test]
fn bounds_and_burn_bounds() {
    let j = job("G0 X50 Y50\nG0 X10 Y10\nM3 S500 F1000\nG1 X20\nG1 Y15 S0\nM5\n");
    assert_eq!((j.bounds.min_x_mm, j.bounds.min_y_mm, j.bounds.max_x_mm, j.bounds.max_y_mm), (0.0, 0.0, 50.0, 50.0));
    let b = j.burn_bounds.unwrap();
    // The S0 move does not burn.
    assert_eq!((b.min_x_mm, b.min_y_mm, b.max_x_mm, b.max_y_mm), (10.0, 10.0, 20.0, 10.0));
    // G0 never burns, even in M3 with S set.
    assert!(job("M3 S1000\nG0 X10\n").burn_bounds.is_none());
}

#[test]
fn empty_job() {
    let j = job("; nothing\n\n$H\n%\n");
    assert!(j.moves.is_empty() && j.passes.is_empty() && j.diagnostics.is_empty());
    assert_eq!(j.source.line_count, 4);
    assert_eq!((j.bounds.min_x_mm, j.bounds.max_x_mm), (0.0, 0.0));
}

#[test]
fn errors_reject_the_whole_line() {
    let j = job("G1 X5 F100\nG1 X10 M3 S900 Q1\nG1 X20\n");
    // Line 2 is rejected entirely: no move, and its M3 S900 never takes effect.
    assert_eq!(ends(&j), vec![(5.0, 0.0), (20.0, 0.0)]);
    assert_eq!((j.moves[1].laser, j.moves[1].s), (LaserMode::Off, 0.0));
    assert_eq!(codes(&j), vec![("unsupported-word", 2)]);
    assert_eq!(j.diagnostics[0].severity, DiagnosticSeverity::Error);
}

#[test]
fn error_codes_for_the_emulator() {
    let mut p = Parser::new(JobSourceKind::Network, "live", ParseOptions::default());
    let grbl = |r: Result<Range<usize>, LineError>| r.map(|_| 0).unwrap_or_else(|e| e.grbl_error);
    assert_eq!(grbl(p.feed_line("G1 X1")), 22, "no feed rate yet");
    assert_eq!(grbl(p.feed_line("G28")), 20);
    assert_eq!(grbl(p.feed_line("M6")), 20);
    assert_eq!(grbl(p.feed_line("G1 X1 F-5")), 4);
    assert_eq!(grbl(p.feed_line("G1 X1 F100 ^")), 1);
    assert_eq!(grbl(p.feed_line("G2 X5 Y5 F100")), 26);
    assert_eq!(grbl(p.feed_line("G2 X5 Y5 R1 F100")), 33);
    assert_eq!(grbl(p.feed_line("G80 X3")), 31);
    assert_eq!(grbl(p.feed_line("G18 G2 X1 I1 F100")), 20);
    assert_eq!(p.feed_line("G1 X1 F100"), Ok(0..1));
}

#[test]
fn inches_are_rejected_once_and_nothing_moves_until_g21() {
    let j = job("G20\nG1 X1 F10\nG1 X2\nG21\nG1 X3\n");
    assert_eq!(codes(&j), vec![("unsupported-units", 1)]);
    assert_eq!(ends(&j), vec![(3.0, 0.0)]);
}

#[test]
fn warnings_are_listed_once_per_code() {
    let j = job("G0 Z5\nM8\nG1 X1 Z1 F100\nM9\nM7\nG4 P1\nG55\nT1\nM0\n");
    assert_eq!(
        codes(&j),
        vec![
            ("ignored-z", 1),
            ("ignored-coolant", 2),
            ("ignored-dwell", 6),
            ("ignored-work-offset", 7),
            ("ignored-tool", 8),
            ("ignored-pause", 9)
        ]
    );
    assert!(j.diagnostics.iter().all(|d| d.severity == DiagnosticSeverity::Warning));
    assert_eq!(ends(&j), vec![(1.0, 0.0)]);
}

#[test]
fn error_list_is_capped() {
    let text = "G28\n".repeat(MAX_ERRORS + 50);
    let j = job(&text);
    assert_eq!(j.diagnostics.len(), MAX_ERRORS + 1);
    assert_eq!(j.diagnostics.last().unwrap().code.as_str(), "too-many-errors");
}

#[test]
fn program_end_resets_modal_state() {
    let j = job("G91 M4 S500 F100\nG1 X1\nM2\nX5\n");
    // After M2: absolute again, laser off, still G1 with F/S kept.
    assert_eq!(ends(&j), vec![(1.0, 0.0), (5.0, 0.0)]);
    assert_eq!((j.moves[1].laser, j.moves[1].kind, j.moves[1].s), (LaserMode::Off, MoveKind::G1, 500.0));
}

#[test]
fn zero_length_moves_are_dropped() {
    let j = job("G1 X0 Y0 F100\nG1 X1\nG1 X1\n");
    assert_eq!(ends(&j), vec![(1.0, 0.0)]);
}

#[test]
fn line_endings_and_partial_last_line() {
    let a = job("G1 X1 F100\r\nG1 X2\r\nG1 X3");
    let b = job("G1 X1 F100\nG1 X2\nG1 X3\n");
    assert_eq!(ends(&a), ends(&b));
    assert_eq!(a.source.line_count, 3);
    assert_eq!(a.moves[2].line, 3);
}

#[test]
fn feed_bytes_reports_each_completed_line() {
    let mut p = Parser::new(JobSourceKind::Network, "live", ParseOptions::default());
    assert!(p.feed_bytes(b"G1 X1 F1").is_empty());
    let out = p.feed_bytes(b"00\nG28\nG1 X2\nG1 X");
    assert_eq!(out.len(), 3);
    assert_eq!(out[0], Ok(0..1));
    assert_eq!(out[1].as_ref().unwrap_err().grbl_error, 20);
    assert_eq!(out[2], Ok(1..2));
    assert_eq!(p.moves()[0].feed_mm_per_min, 100.0);
    assert_eq!(p.line_count(), 3);
    let j = p.finish();
    assert_eq!(j.moves.len(), 2, "the partial `G1 X` is flushed and rejected");
    assert_eq!(codes(&j), vec![("unsupported-command", 2), ("bad-number", 4)]);
}

mod passes {
    use super::*;

    fn summary(j: &JobModel) -> Vec<(u32, u32, Option<&str>)> {
        j.passes.iter().map(|p| (p.first_move, p.move_count, p.label.as_deref())).collect()
    }

    const SQUARE: &str = "G0 X0 Y0\nG1 X5 S500\nG1 Y5\nG1 X0\nG1 Y0\n";

    #[test]
    fn single_pass_without_markers() {
        let j = job(&format!("M4 F600\n{SQUARE}"));
        assert_eq!(summary(&j), vec![(0, 4, None)]);
        assert!(j.diagnostics.is_empty());
    }

    #[test]
    fn layer_and_settings_comments_split_passes() {
        let text = format!(
            "; Layer C00\n; Cut @ 600 mm/min, 50% power\nM4 F600\n{SQUARE}; Cut @ 600 mm/min, 50% power\n{SQUARE}; Layer C01\n; Cut @ 300 mm/min, 80% power\nG0 X10\nG1 X20 S800\n"
        );
        let j = job(&text);
        assert_eq!(summary(&j), vec![(0, 4, Some("C00")), (4, 4, Some("C00")), (8, 2, Some("C01"))]);
        assert_eq!(codes(&j), vec![("multi-pass", 11)]);
        assert!(j.diagnostics[0].message.contains("2 passes"));
    }

    #[test]
    fn repeated_geometry_without_markers() {
        let j = job(&format!("M4 F600\n{SQUARE}{SQUARE}{SQUARE}"));
        assert_eq!(summary(&j), vec![(0, 4, None), (4, 4, None), (8, 4, None)]);
        assert_eq!(codes(&j), vec![("multi-pass", 8)]);
        assert!(j.diagnostics[0].message.contains("3 passes"));
    }

    #[test]
    fn different_layers_are_not_a_repeat() {
        let j = job(&format!("M4 F600\n; Pass 1 of 2\n{SQUARE}; Pass 2 of 2\nG0 X10\nG1 X30 S500\n"));
        assert_eq!(j.passes.len(), 2);
        assert!(j.diagnostics.is_empty());
    }

    #[test]
    fn passes_tile_the_moves() {
        let j = job(&format!("; Layer A\nM4 F600\n{SQUARE}; Pass 2\n{SQUARE}; trailing\n"));
        let total: u32 = j.passes.iter().map(|p| p.move_count).sum();
        assert_eq!(total as usize, j.moves.len());
        for w in j.passes.windows(2) {
            assert_eq!(w[0].first_move + w[0].move_count, w[1].first_move);
        }
    }
}
