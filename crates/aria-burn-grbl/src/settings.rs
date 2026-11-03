// SPDX-License-Identifier: GPL-3.0-or-later
//! Emulated GRBL `$` settings (COD-255). The machine profile *is* the settings
//! it covers ($11, $30, $32, $110/$111, $120/$121, $130/$131): a `$x=` write to
//! one of those changes the profile, and `$$` reads them from it. The other
//! settings keep GRBL's defaults and accept writes for the emulator's lifetime;
//! the planner uses $12 (arc tolerance), $31 (S min) and $100/$101 (steps/mm).
//!
//! Write rules follow GRBL's `settings_store_global_setting`: a negative value is
//! error:4, an unknown setting error:3, a step pulse under 3 µs error:6, and
//! integer settings are truncated. Profile settings must also stay valid in the
//! contract (positive), so a zero there is refused with error:3.

use std::collections::BTreeMap;

use aria_burn_contract::MachineProfile;

use crate::protocol::error;

/// GRBL 1.1h `$` settings in `$$` order, with GRBL's defaults. Profile-backed
/// ones are read from the profile instead.
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

/// Settings the machine profile holds.
pub const PROFILE_SETTINGS: &[u16] = &[11, 30, 32, 110, 111, 120, 121, 130, 131];

/// Settings GRBL stores as integers (truncated on write).
fn is_integer_setting(n: u16) -> bool {
    matches!(n, 0..=6 | 10 | 13 | 20..=23 | 26 | 32)
}

/// Settings GRBL prints without decimals ($30/$31 are floats printed as integers).
fn prints_as_integer(n: u16) -> bool {
    is_integer_setting(n) || matches!(n, 30 | 31)
}

/// What a `$x=` write changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Written {
    /// A profile-backed setting: the profile changed.
    Profile,
    /// Any other setting.
    Other,
}

#[derive(Clone, Debug)]
pub struct GrblSettings {
    profile: MachineProfile,
    /// Non-profile settings that were written, over the defaults.
    other: BTreeMap<u16, f64>,
}

impl GrblSettings {
    pub fn new(profile: MachineProfile) -> Self {
        Self { profile, other: BTreeMap::new() }
    }

    pub fn profile(&self) -> &MachineProfile {
        &self.profile
    }

    /// Replaces the profile (the settings screen saved); other writes are kept.
    pub fn set_profile(&mut self, profile: MachineProfile) {
        self.profile = profile;
    }

    /// The value of `$n`, or `None` if GRBL 1.1h has no such setting.
    pub fn get(&self, n: u16) -> Option<f64> {
        let p = &self.profile;
        Some(match n {
            11 => p.junction_deviation_mm,
            30 => p.s_max,
            32 => f64::from(u8::from(p.laser_mode)),
            110 => p.max_rate_mm_per_min.x,
            111 => p.max_rate_mm_per_min.y,
            120 => p.accel_mm_per_s2.x,
            121 => p.accel_mm_per_s2.y,
            130 => p.travel_mm.x,
            131 => p.travel_mm.y,
            _ => match self.other.get(&n) {
                Some(v) => *v,
                None => DEFAULT_SETTINGS.iter().find(|(k, _)| *k == n)?.1,
            },
        })
    }

    /// `$n=value`. Returns what changed, or GRBL's `error:N` code.
    pub fn set(&mut self, n: u16, value: f64) -> Result<Written, u8> {
        if self.get(n).is_none() || !value.is_finite() {
            return Err(error::INVALID_STATEMENT);
        }
        if value < 0.0 {
            return Err(error::NEGATIVE_VALUE);
        }
        let v = if is_integer_setting(n) { value.trunc() } else { value };
        if n == 0 && v < 3.0 {
            return Err(error::SETTING_STEP_PULSE_MIN);
        }
        if (PROFILE_SETTINGS.contains(&n) && n != 32 || matches!(n, 100..=102)) && v == 0.0 {
            return Err(error::INVALID_STATEMENT);
        }
        let p = &mut self.profile;
        match n {
            11 => p.junction_deviation_mm = v,
            30 => p.s_max = v,
            32 => p.laser_mode = v != 0.0,
            110 => p.max_rate_mm_per_min.x = v,
            111 => p.max_rate_mm_per_min.y = v,
            120 => p.accel_mm_per_s2.x = v,
            121 => p.accel_mm_per_s2.y = v,
            130 => p.travel_mm.x = v,
            131 => p.travel_mm.y = v,
            _ => {
                self.other.insert(n, v);
                return Ok(Written::Other);
            }
        }
        Ok(Written::Profile)
    }

    /// The `$$` reply, one `$n=value` line each, without the final `ok`.
    pub fn report_lines(&self) -> Vec<String> {
        DEFAULT_SETTINGS
            .iter()
            .map(|&(n, _)| {
                let v = self.get(n).expect("listed");
                if prints_as_integer(n) { format!("${n}={v:.0}") } else { format!("${n}={v:.3}") }
            })
            .collect()
    }

    /// `$10` status report mask.
    pub fn status_mask(&self) -> u32 {
        self.get(10).unwrap_or(1.0) as u32
    }

    /// `$12` arc tolerance (mm).
    pub fn arc_tolerance_mm(&self) -> f64 {
        self.get(12).unwrap_or(0.002)
    }

    /// `$31` minimum S.
    pub fn s_min(&self) -> f64 {
        self.get(31).unwrap_or(0.0)
    }

    /// `$100`/`$101` steps per mm.
    pub fn steps_per_mm(&self) -> (f64, f64) {
        (self.get(100).unwrap_or(80.0), self.get(101).unwrap_or(80.0))
    }
}

/// Parses a `$n=value` command body (after the `$`).
pub fn parse_write(cmd: &str) -> Option<(u16, f64)> {
    let (n, v) = cmd.split_once('=')?;
    Some((n.trim().parse().ok()?, v.trim().parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_profile;

    #[test]
    fn reads_profile_and_defaults() {
        let s = GrblSettings::new(test_profile());
        let lines = s.report_lines();
        assert_eq!(lines.len(), DEFAULT_SETTINGS.len());
        assert_eq!(lines[0], "$0=10");
        for expected in ["$11=0.010", "$30=1000", "$31=0", "$32=1", "$100=80.000", "$110=10000.000"] {
            assert!(lines.contains(&expected.to_owned()), "{expected} in {lines:?}");
        }
        assert_eq!(s.get(99), None);
    }

    #[test]
    fn writes_go_to_the_profile_or_the_side_table() {
        let mut s = GrblSettings::new(test_profile());
        assert_eq!(s.set(11, 0.02), Ok(Written::Profile));
        assert_eq!(s.set(120, 2500.0), Ok(Written::Profile));
        assert_eq!(s.set(32, 0.0), Ok(Written::Profile));
        assert_eq!(s.profile().junction_deviation_mm, 0.02);
        assert_eq!(s.profile().accel_mm_per_s2.x, 2500.0);
        assert!(!s.profile().laser_mode);
        assert_eq!(s.set(100, 160.0), Ok(Written::Other));
        assert_eq!(s.steps_per_mm(), (160.0, 80.0));
        // Integer settings truncate, as GRBL does.
        assert_eq!(s.set(10, 2.9), Ok(Written::Other));
        assert_eq!(s.status_mask(), 2);
        // A new profile from the settings screen keeps the other writes.
        s.set_profile(test_profile());
        assert_eq!((s.get(11), s.steps_per_mm().0), (Some(0.01), 160.0));
    }

    #[test]
    fn write_errors_match_grbl() {
        let mut s = GrblSettings::new(test_profile());
        assert_eq!(s.set(99, 1.0), Err(error::INVALID_STATEMENT));
        assert_eq!(s.set(110, -1.0), Err(error::NEGATIVE_VALUE));
        assert_eq!(s.set(0, 2.0), Err(error::SETTING_STEP_PULSE_MIN));
        assert_eq!(s.set(30, 0.0), Err(error::INVALID_STATEMENT), "profile settings stay positive");
        assert_eq!(s.set(100, 0.0), Err(error::INVALID_STATEMENT));
        assert_eq!(s.get(30), Some(1000.0), "a refused write changes nothing");
        assert_eq!(parse_write("110 = 6000"), Some((110, 6000.0)));
        assert_eq!(parse_write("110"), None);
    }
}
