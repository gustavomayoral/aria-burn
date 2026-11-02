// SPDX-License-Identifier: GPL-3.0-or-later
//! GRBL 1.1 wire constants and fixed texts.

/// Serial RX buffer GRBL reports in `[OPT:…]` (character-counting senders use it).
pub const RX_BUFFER_SIZE: usize = 128;
/// Usable planner blocks (GRBL's 16-block ring keeps one slot free).
pub const PLANNER_BLOCKS: usize = 15;
/// GRBL's line buffer; a longer line (whitespace and comments removed) is error:11.
pub const LINE_BUFFER_SIZE: usize = 80;

pub const BANNER: &str = "\r\nGrbl 1.1h ['$' for help]\r\n";
pub const VERSION: &str = "[VER:1.1h.20190825:Laser Sim]\r\n";
pub const UNLOCK_HINT: &str = "[MSG:'$H'|'$X' to unlock]\r\n";
pub const HELP: &str = "[HLP:$$ $# $G $I $N $x=val $Nx=line $J=line $SLP $C $X $H ~ ! ? ctrl-x]\r\n";

/// Real-time commands: picked out of the stream wherever they appear.
pub mod rt {
    pub const STATUS: u8 = b'?';
    pub const HOLD: u8 = b'!';
    pub const RESUME: u8 = b'~';
    pub const RESET: u8 = 0x18;
    pub const SAFETY_DOOR: u8 = 0x84;
    pub const JOG_CANCEL: u8 = 0x85;
    pub const FEED_100: u8 = 0x90;
    pub const FEED_PLUS_10: u8 = 0x91;
    pub const FEED_MINUS_10: u8 = 0x92;
    pub const FEED_PLUS_1: u8 = 0x93;
    pub const FEED_MINUS_1: u8 = 0x94;
    pub const RAPID_100: u8 = 0x95;
    pub const RAPID_50: u8 = 0x96;
    pub const RAPID_25: u8 = 0x97;
    pub const SPINDLE_100: u8 = 0x99;
    pub const SPINDLE_PLUS_10: u8 = 0x9A;
    pub const SPINDLE_MINUS_10: u8 = 0x9B;
    pub const SPINDLE_PLUS_1: u8 = 0x9C;
    pub const SPINDLE_MINUS_1: u8 = 0x9D;
}

/// GRBL 1.1 `error:N` codes the emulator itself raises (the parser has its own).
pub mod error {
    pub const INVALID_STATEMENT: u8 = 3;
    pub const SETTING_DISABLED: u8 = 5;
    pub const IDLE_ERROR: u8 = 8;
    pub const SYSTEM_GC_LOCK: u8 = 9;
    pub const OVERFLOW: u8 = 11;
    pub const INVALID_JOG_COMMAND: u8 = 16;
    pub const UNDEFINED_FEED_RATE: u8 = 22;
}

/// ALARM:3, reset while in motion.
pub const ALARM_ABORT_CYCLE: u8 = 3;

/// GRBL 1.1 `$` settings in `$$` order, with GRBL's defaults. The profile-backed
/// ones ($11, $30, $32, $110/$111, $120/$121, $130/$131) are filled from the
/// machine profile. Placeholder until COD-255 emulates `$` settings for real.
pub const DEFAULT_SETTINGS: &[(u16, f64)] = &[
    (0, 10.0),
    (1, 25.0),
    (2, 0.0),
    (3, 0.0),
    (4, 0.0),
    (5, 0.0),
    (6, 0.0),
    (10, 1.0),
    (11, 0.010),
    (12, 0.002),
    (13, 0.0),
    (20, 0.0),
    (21, 0.0),
    (22, 0.0),
    (23, 0.0),
    (24, 25.0),
    (25, 500.0),
    (26, 250.0),
    (27, 1.0),
    (30, 1000.0),
    (31, 0.0),
    (32, 1.0),
    (100, 80.0),
    (101, 80.0),
    (102, 250.0),
    (110, 500.0),
    (111, 500.0),
    (112, 500.0),
    (120, 10.0),
    (121, 10.0),
    (122, 10.0),
    (130, 200.0),
    (131, 200.0),
    (132, 200.0),
];

/// Settings GRBL prints as integers; the rest get three decimals.
pub fn is_integer_setting(n: u16) -> bool {
    matches!(n, 0..=6 | 10 | 13 | 20..=23 | 26 | 30..=32)
}

pub const OFFSETS_REPORT: &str = "[G54:0.000,0.000,0.000]\r\n[G55:0.000,0.000,0.000]\r\n[G56:0.000,0.000,0.000]\r\n\
[G57:0.000,0.000,0.000]\r\n[G58:0.000,0.000,0.000]\r\n[G59:0.000,0.000,0.000]\r\n[G28:0.000,0.000,0.000]\r\n\
[G30:0.000,0.000,0.000]\r\n[G92:0.000,0.000,0.000]\r\n[TLO:0.000]\r\n[PRB:0.000,0.000,0.000:0]\r\n";

/// Length GRBL stores for a line: whitespace and comments dropped.
pub fn stored_len(line: &[u8]) -> usize {
    let mut n = 0;
    let mut in_paren = false;
    for &b in line {
        match b {
            b')' if in_paren => in_paren = false,
            _ if in_paren => {}
            b'(' => in_paren = true,
            b';' => break,
            b if b.is_ascii_whitespace() => {}
            _ => n += 1,
        }
    }
    n
}

/// True if a G-code line ends the program (M2 / M30).
pub fn is_program_end(line: &[u8]) -> bool {
    let mut letters = Vec::new();
    let mut in_paren = false;
    for &b in line {
        match b {
            b')' if in_paren => in_paren = false,
            _ if in_paren => {}
            b'(' => in_paren = true,
            b';' => break,
            b if b.is_ascii_whitespace() => {}
            b => letters.push(b.to_ascii_uppercase()),
        }
    }
    let text = String::from_utf8_lossy(&letters).into_owned();
    let mut rest = text.as_str();
    while let Some(i) = rest.find('M') {
        rest = &rest[i + 1..];
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        if let Ok(v) = rest[..end].parse::<f64>()
            && (v == 2.0 || v == 30.0)
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_length_skips_spaces_and_comments() {
        assert_eq!(stored_len(b"G1 X10 (move) Y2 ; done"), 7);
        assert_eq!(stored_len(b"   "), 0);
    }

    #[test]
    fn program_end() {
        assert!(is_program_end(b"M2"));
        assert!(is_program_end(b"g0 x0 m30 ; end"));
        assert!(is_program_end(b"M02"));
        assert!(!is_program_end(b"M3 S20"));
        assert!(!is_program_end(b"(M2) M5"));
    }
}
