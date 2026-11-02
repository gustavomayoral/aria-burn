// SPDX-License-Identifier: GPL-3.0-or-later
//! GRBL laser G-code → the v1 contract's `JobModel` (COD-263).
//!
//! One parser serves both intakes: a file is fed as one byte slice, the GRBL
//! emulator feeds bytes as they arrive from the socket. Both go through the
//! same line splitter, so a streamed job parses exactly like the same file.
//!
//! What it normalises (see the contract's job.ts): G91 relative moves become
//! absolute, G92 offsets are applied, arcs become G1 chords, and modal F/S/M3/M4/M5
//! are resolved onto every move. G20 (inches) is rejected in v1. Z is ignored.
//!
//! Lines are atomic as in GRBL: a line with an error changes no state and adds
//! no moves, and the error carries the GRBL `error:N` code for the emulator.

mod arc;
mod lex;
mod passes;

use std::{collections::HashSet, ops::Range};

use aria_burn_contract::{
    BoundsMm, Diagnostic, DiagnosticSeverity, JobModel, JobSource, JobSourceKind, LaserMode, Move, MoveKind, Vec2Mm,
};

use arc::Center;
use lex::lex;
use passes::Marker;

/// Error diagnostics kept per job; past this one `too-many-errors` closes the list.
pub const MAX_ERRORS: usize = 100;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ParseOptions {
    /// Max chord deviation when flattening arcs (GRBL `$12`, default 0.002 mm).
    pub arc_tolerance_mm: f64,
    /// Head position before the first move (work coordinates, mm).
    pub start_mm: (f64, f64),
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self { arc_tolerance_mm: 0.002, start_mm: (0.0, 0.0) }
    }
}

/// A rejected line. `grbl_error` is what the emulator answers (`error:N`).
#[derive(Clone, Debug, PartialEq)]
pub struct LineError {
    /// Stable diagnostic code.
    pub code: &'static str,
    pub grbl_error: u8,
    pub message: String,
}

impl LineError {
    fn new(code: &'static str, grbl_error: u8, message: impl Into<String>) -> Self {
        Self { code, grbl_error, message: message.into() }
    }
    fn expected_letter(c: char) -> Self {
        Self::new("expected-letter", 1, format!("Expected a command letter, found '{c}'"))
    }
    fn bad_number(letter: char, number: &str) -> Self {
        Self::new("bad-number", 2, format!("Bad number '{number}' after {letter}"))
    }
    fn unsupported(what: &str) -> Self {
        Self::new("unsupported-command", 20, format!("{what} is not supported"))
    }
    fn unsupported_word(letter: char) -> Self {
        Self::new("unsupported-word", 20, format!("Word {letter} is not supported"))
    }
    fn negative(letter: char) -> Self {
        Self::new("negative-value", 4, format!("{letter} cannot be negative"))
    }
    fn arc(message: &str) -> Self {
        Self::new("invalid-arc", 33, format!("Invalid arc: {message}"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Motion {
    None,
    Rapid,
    Linear,
    ArcCw,
    ArcCcw,
}

/// GRBL modal state that affects the job model.
#[derive(Clone, Copy, Debug)]
struct Modal {
    motion: Motion,
    absolute: bool,
    plane_xy: bool,
    inches: bool,
    feed: f64,
    s: f64,
    laser: LaserMode,
}

impl Default for Modal {
    fn default() -> Self {
        // GRBL power-up: G0 G54 G17 G21 G90 G94 M5, F0 S0.
        Self {
            motion: Motion::Rapid,
            absolute: true,
            plane_xy: true,
            inches: false,
            feed: 0.0,
            s: 0.0,
            laser: LaserMode::Off,
        }
    }
}

/// What one line asks for once its words are collected.
#[derive(Default)]
struct Words {
    motion: Option<Motion>,
    machine_coords: bool,
    g92: Option<bool>, // Some(true) set, Some(false) clear (G92.1)
    program_end: bool,
    x: Option<f64>,
    y: Option<f64>,
    z: bool,
    i: Option<f64>,
    j: Option<f64>,
    r: Option<f64>,
}

/// Incremental parser. Feed lines or raw bytes, then [`Parser::finish`].
pub struct Parser {
    opts: ParseOptions,
    kind: JobSourceKind,
    name: String,
    line: u32,
    pending: Vec<u8>,
    modal: Modal,
    /// Head position, work coordinates.
    pos: (f64, f64),
    /// G92 offset: work = program + offset.
    offset: (f64, f64),
    moves: Vec<Move>,
    markers: Vec<Marker>,
    diagnostics: Vec<Diagnostic>,
    warned: HashSet<&'static str>,
    errors: usize,
}

impl Parser {
    pub fn new(kind: JobSourceKind, name: impl Into<String>, opts: ParseOptions) -> Self {
        Self {
            opts,
            kind,
            name: name.into(),
            line: 0,
            pending: Vec::new(),
            modal: Modal::default(),
            pos: opts.start_mm,
            offset: (0.0, 0.0),
            moves: Vec::new(),
            markers: Vec::new(),
            diagnostics: Vec::new(),
            warned: HashSet::new(),
            errors: 0,
        }
    }

    /// Moves parsed so far.
    pub fn moves(&self) -> &[Move] {
        &self.moves
    }

    /// Lines parsed so far (the last line's 1-based number).
    pub fn line_count(&self) -> u32 {
        self.line
    }

    /// Feeds raw bytes, splitting on `\n` (a trailing `\r` is dropped). A
    /// partial last line waits for more bytes or [`Parser::finish`]. Returns
    /// each completed line's outcome in order.
    pub fn feed_bytes(&mut self, bytes: &[u8]) -> Vec<Result<Range<usize>, LineError>> {
        let mut outcomes = Vec::new();
        let mut rest = bytes;
        while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
            self.pending.extend_from_slice(&rest[..nl]);
            rest = &rest[nl + 1..];
            let line = std::mem::take(&mut self.pending);
            outcomes.push(self.feed_raw(&line));
        }
        self.pending.extend_from_slice(rest);
        outcomes
    }

    /// Parses one line (no line terminator). Returns the range of moves it added.
    pub fn feed_line(&mut self, line: &str) -> Result<Range<usize>, LineError> {
        self.line += 1;
        let first = self.moves.len();
        match self.parse_line(line) {
            Ok(()) => Ok(first..self.moves.len()),
            Err(e) => {
                self.moves.truncate(first);
                self.push_error(&e);
                Err(e)
            }
        }
    }

    fn feed_raw(&mut self, line: &[u8]) -> Result<Range<usize>, LineError> {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        self.feed_line(&String::from_utf8_lossy(line))
    }

    /// Flushes a partial last line and builds the job model.
    pub fn finish(mut self) -> JobModel {
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            let _ = self.feed_raw(&line);
        }
        self.take_job()
    }

    /// Ends the current job on a live stream and starts the next one: builds the
    /// model of the lines fed since the last call, then resets the per-job
    /// state (moves, diagnostics, line count). Modal state, head position and
    /// the G92 offset carry over, as they do on the machine, and the next job
    /// starts where this one ended. A partial line waits for more bytes.
    pub fn take_job(&mut self) -> JobModel {
        let (passes, repeated) = passes::split(&self.moves, std::mem::take(&mut self.markers));
        if let Some((line, count)) = repeated {
            self.warn(
                "multi-pass",
                line,
                format!(
                    "Same geometry is burned in {count} passes; v1 simulates all passes as one deposit, so multi-pass jobs will over-darken"
                ),
            );
        }
        let (bounds, burn_bounds) = self.bounds();
        let job = JobModel {
            contract_version: 1.0.try_into().expect("contract version 1"),
            source: JobSource { kind: self.kind, name: self.name.clone(), line_count: self.line },
            start_mm: Vec2Mm { x_mm: self.opts.start_mm.0, y_mm: self.opts.start_mm.1 },
            moves: std::mem::take(&mut self.moves),
            passes,
            bounds,
            burn_bounds,
            diagnostics: std::mem::take(&mut self.diagnostics),
        };
        self.line = 0;
        self.warned.clear();
        self.errors = 0;
        self.opts.start_mm = self.pos;
        job
    }

    /// Moves the head without a G-code move (the emulator's jogs and resets),
    /// so later relative moves start from the right place.
    pub fn set_position(&mut self, (x_mm, y_mm): (f64, f64)) {
        self.pos = (x_mm, y_mm);
        if self.moves.is_empty() {
            self.opts.start_mm = self.pos;
        }
    }

    /// Head position after the last parsed move.
    pub fn position(&self) -> (f64, f64) {
        self.pos
    }

    /// Renames the job being parsed (the emulator names network jobs as they start).
    pub fn set_name(&mut self, name: impl Into<String>) {
        self.name = name.into();
    }

    fn bounds(&self) -> (BoundsMm, Option<BoundsMm>) {
        let mut all = Bounds::default();
        let mut burn = Bounds::default();
        let mut prev = self.opts.start_mm;
        all.add(prev);
        for m in &self.moves {
            let end = (m.x_mm, m.y_mm);
            all.add(end);
            if beam_on(m) {
                burn.add(prev);
                burn.add(end);
            }
            prev = end;
        }
        (all.into_contract().expect("start point is always in bounds"), burn.into_contract())
    }

    fn parse_line(&mut self, line: &str) -> Result<(), LineError> {
        let lexed = lex(line)?;
        // `$H`, `$$`, `$32=1`… are system commands, not part of the toolpath.
        if lexed.system.is_some() {
            return Ok(());
        }
        let mut modal = self.modal;
        let mut w = Words::default();
        let mut warnings: Vec<(&'static str, String)> = Vec::new();
        for &(letter, value) in &lexed.words {
            match letter {
                'G' => self.g_word(value, &mut modal, &mut w, &mut warnings)?,
                'M' => match code(value) {
                    (3, 0) => modal.laser = LaserMode::M3,
                    (4, 0) => modal.laser = LaserMode::M4,
                    (5, 0) => modal.laser = LaserMode::Off,
                    (7..=9, 0) => {
                        warnings.push(("ignored-coolant", "Air assist / coolant (M7/M8/M9) is ignored in v1".into()))
                    }
                    (0 | 1, 0) => warnings.push(("ignored-pause", "Program pause (M0/M1) is ignored".into())),
                    (2 | 30, 0) => w.program_end = true,
                    _ => return Err(LineError::unsupported(&format!("M{}", fmt_code(value)))),
                },
                'X' => w.x = Some(value),
                'Y' => w.y = Some(value),
                'Z' => w.z = true,
                'I' => w.i = Some(value),
                'J' => w.j = Some(value),
                'R' => w.r = Some(value),
                'F' if value < 0.0 => return Err(LineError::negative('F')),
                'F' => modal.feed = value,
                'S' if value < 0.0 => return Err(LineError::negative('S')),
                'S' => modal.s = value,
                // Dwell time; the dwell itself is reported where G4 is read.
                'P' => {}
                'T' => warnings.push(("ignored-tool", "Tool changes (T) are ignored".into())),
                other => return Err(LineError::unsupported_word(other)),
            }
        }
        if let Some(m) = w.motion {
            modal.motion = m;
        }
        if w.z {
            warnings.push(("ignored-z", "Z moves are ignored in v1".into()));
        }

        let has_xy = w.x.is_some() || w.y.is_some();
        let has_arc_words = w.i.is_some() || w.j.is_some() || w.r.is_some();
        let mut offset = self.offset;
        let mut chords: Vec<((f64, f64), bool)> = Vec::new();
        if let Some(set) = w.g92 {
            // G92 consumes the axis words: no motion on this line.
            offset = if set {
                (w.x.map_or(offset.0, |x| self.pos.0 - x), w.y.map_or(offset.1, |y| self.pos.1 - y))
            } else {
                (0.0, 0.0)
            };
        } else if modal.inches {
            // Already reported where G20 was read; nothing is moved until G21.
        } else if has_arc_words && !has_xy {
            return Err(LineError::new("invalid-arc", 26, "Arc needs an X or Y end point"));
        } else if has_xy {
            let target = (
                self.target(w.x, self.pos.0, offset.0, &modal, &w),
                self.target(w.y, self.pos.1, offset.1, &modal, &w),
            );
            match modal.motion {
                Motion::None => {
                    return Err(LineError::new("invalid-motion", 31, "Axis words with no motion mode (G80)"));
                }
                Motion::Rapid => chords.push((target, false)),
                Motion::Linear | Motion::ArcCw | Motion::ArcCcw if modal.feed <= 0.0 => {
                    return Err(LineError::new("undefined-feed", 22, "Feed move with no feed rate set (F)"));
                }
                Motion::Linear => chords.push((target, false)),
                Motion::ArcCw | Motion::ArcCcw => {
                    if !modal.plane_xy {
                        return Err(LineError::unsupported("Arcs outside the XY plane (G18/G19)"));
                    }
                    let center = match (w.r, w.i, w.j) {
                        (Some(r), None, None) => Center::Radius(r),
                        (None, None, None) => {
                            return Err(LineError::new("invalid-arc", 26, "Arc needs I/J or R"));
                        }
                        (None, i, j) => Center::Offset(i.unwrap_or(0.0), j.unwrap_or(0.0)),
                        _ => return Err(LineError::arc("both R and I/J given")),
                    };
                    let points = arc::flatten(
                        self.pos,
                        target,
                        center,
                        modal.motion == Motion::ArcCw,
                        self.opts.arc_tolerance_mm,
                    )?;
                    chords.extend(points.into_iter().map(|p| (p, true)));
                }
            }
        }

        // The line is valid: commit.
        for comment in &lexed.comments {
            if let Some(marker) = Marker::from_comment(comment, self.moves.len(), self.line) {
                self.markers.push(marker);
            }
        }
        for (code, message) in warnings {
            self.warn(code, self.line, message);
        }
        let kind = if modal.motion == Motion::Rapid { MoveKind::G0 } else { MoveKind::G1 };
        for (end, arc) in chords {
            if end == self.pos {
                continue;
            }
            self.moves.push(Move {
                kind,
                x_mm: end.0,
                y_mm: end.1,
                feed_mm_per_min: modal.feed,
                s: modal.s,
                laser: modal.laser,
                line: self.line,
                arc: arc.then_some(true),
            });
            self.pos = end;
        }
        self.offset = offset;
        if w.program_end {
            // GRBL program end: G1 G17 G90 G94 G54 M5 M9; F, S and G92 persist.
            modal.motion = Motion::Linear;
            modal.plane_xy = true;
            modal.absolute = true;
            modal.laser = LaserMode::Off;
        }
        self.modal = modal;
        Ok(())
    }

    fn g_word(
        &mut self,
        value: f64,
        modal: &mut Modal,
        w: &mut Words,
        warnings: &mut Vec<(&'static str, String)>,
    ) -> Result<(), LineError> {
        match code(value) {
            (0, 0) => w.motion = Some(Motion::Rapid),
            (1, 0) => w.motion = Some(Motion::Linear),
            (2, 0) => w.motion = Some(Motion::ArcCw),
            (3, 0) => w.motion = Some(Motion::ArcCcw),
            (80, 0) => w.motion = Some(Motion::None),
            (4, 0) => warnings.push((
                "ignored-dwell",
                "Dwell (G4) is ignored; a dwell with the beam on burns more than shown".into(),
            )),
            (17, 0) => modal.plane_xy = true,
            (18 | 19, 0) => modal.plane_xy = false,
            (20, 0) => {
                // Rejected, but the units state sticks so later inch moves are skipped, not misread as mm.
                self.modal.inches = true;
                return Err(LineError::new(
                    "unsupported-units",
                    20,
                    "Inch units (G20) are not supported in v1; export the job in millimetres (G21)",
                ));
            }
            (21, 0) => modal.inches = false,
            (90, 0) => modal.absolute = true,
            (91, 0) => modal.absolute = false,
            (91, 1) => {}
            (92, 0) => w.g92 = Some(true),
            (92, 1) => w.g92 = Some(false),
            (53, 0) => w.machine_coords = true,
            (54, 0) => {}
            (55..=59, 0) => warnings.push((
                "ignored-work-offset",
                "Work coordinate systems G55–G59 are treated as G54 (offsets unknown)".into(),
            )),
            // Cutter comp off, tool length off, units/min, exact path: GRBL defaults, no effect here.
            (40 | 49 | 94 | 61, 0) => {}
            _ => return Err(LineError::unsupported(&format!("G{}", fmt_code(value)))),
        }
        Ok(())
    }

    /// Work-coordinate target for one axis.
    fn target(&self, word: Option<f64>, current: f64, offset: f64, modal: &Modal, w: &Words) -> f64 {
        match word {
            None => current,
            // G53 is machine coordinates; with no work offsets known, machine = work zero.
            Some(v) if w.machine_coords => v,
            Some(v) if modal.absolute => v + offset,
            Some(v) => current + v,
        }
    }

    fn warn(&mut self, code: &'static str, line: u32, message: String) {
        // One warning per code per job; the first line it happens on.
        if self.warned.insert(code) {
            self.diagnostics.push(diagnostic(DiagnosticSeverity::Warning, code, line, message));
        }
    }

    fn push_error(&mut self, e: &LineError) {
        self.errors += 1;
        if self.errors <= MAX_ERRORS {
            self.diagnostics.push(diagnostic(DiagnosticSeverity::Error, e.code, self.line, e.message.clone()));
        } else if self.errors == MAX_ERRORS + 1 {
            self.diagnostics.push(diagnostic(
                DiagnosticSeverity::Error,
                "too-many-errors",
                self.line,
                format!("More than {MAX_ERRORS} errors; further errors are not listed"),
            ));
        }
    }
}

/// Parses a whole file (or any complete byte buffer) into a job model.
pub fn parse(kind: JobSourceKind, name: impl Into<String>, bytes: &[u8], opts: ParseOptions) -> JobModel {
    let mut parser = Parser::new(kind, name, opts);
    parser.feed_bytes(bytes);
    parser.finish()
}

/// Same rule as the contract's `beamOn`.
pub fn beam_on(m: &Move) -> bool {
    m.kind == MoveKind::G1 && m.laser != LaserMode::Off && m.s > 0.0
}

/// `G91.1` → (91, 1).
fn code(value: f64) -> (u32, u32) {
    let tenths = (value * 10.0).round();
    if tenths < 0.0 || (value * 10.0 - tenths).abs() > 1e-6 {
        return (u32::MAX, 0);
    }
    let tenths = tenths as u32;
    (tenths / 10, tenths % 10)
}

fn fmt_code(value: f64) -> String {
    let s = format!("{value:.1}");
    s.strip_suffix(".0").map(str::to_owned).unwrap_or(s)
}

fn diagnostic(severity: DiagnosticSeverity, code: &str, line: u32, message: String) -> Diagnostic {
    Diagnostic { severity, code: code.try_into().expect("non-empty code"), message, line }
}

#[derive(Default)]
struct Bounds(Option<(f64, f64, f64, f64)>);

impl Bounds {
    fn add(&mut self, (x, y): (f64, f64)) {
        self.0 = Some(match self.0 {
            None => (x, y, x, y),
            Some((a, b, c, d)) => (a.min(x), b.min(y), c.max(x), d.max(y)),
        });
    }
    fn into_contract(self) -> Option<BoundsMm> {
        self.0.map(|(min_x_mm, min_y_mm, max_x_mm, max_y_mm)| BoundsMm { min_x_mm, min_y_mm, max_x_mm, max_y_mm })
    }
}

#[cfg(test)]
mod tests;
