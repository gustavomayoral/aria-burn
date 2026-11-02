// SPDX-License-Identifier: GPL-3.0-or-later
//! Splits a job's moves into passes and spots repeated geometry, for the
//! multi-pass warning (v1 deposits every pass at once, so repeats over-darken).
//!
//! Pass boundaries come from sender comments when there are any:
//! - `; Layer C00` names the layer for the passes that follow.
//! - `; Cut @ 600 mm/min, 50% power` (LightBurn writes one per layer pass; also
//!   Scan/Fill/Image …) and `; Pass 2 of 3` start a new pass.
//!
//! Without such comments, a job whose burned geometry is one block repeated k
//! times is split into k passes.
//!
//! The comment forms are a heuristic from LightBurn's GRBL output and need
//! checking against real exports.

use aria_burn_contract::{Move, Pass};

use crate::beam_on;

#[derive(Clone, Debug, PartialEq)]
pub struct Marker {
    /// Index of the first move after the comment.
    pub move_index: usize,
    pub line: u32,
    /// `Some` for a `Layer` comment: the layer name.
    pub layer: Option<String>,
}

impl Marker {
    pub fn from_comment(comment: &str, move_index: usize, line: u32) -> Option<Self> {
        let lower = comment.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("layer").filter(|r| r.starts_with([' ', ':'])) {
            let name = comment[comment.len() - rest.len()..].trim_start_matches([' ', ':']).trim();
            return Some(Self { move_index, line, layer: Some(name.to_owned()) });
        }
        let settings = lower.contains(" @ ") && lower.contains("mm/");
        let pass = lower.strip_prefix("pass ").is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()));
        (settings || pass).then_some(Self { move_index, line, layer: None })
    }
}

/// Passes covering `moves` in order, and `(line, count)` when some pass's
/// burned geometry is repeated: the line where the first repeat starts and how
/// many times the most-repeated geometry is burned.
pub fn split(moves: &[Move], markers: Vec<Marker>) -> (Vec<Pass>, Option<(u32, usize)>) {
    if moves.is_empty() {
        return (Vec::new(), None);
    }
    let mut starts: Vec<(usize, Option<String>)> = vec![(0, None)];
    let mut layer: Option<String> = None;
    for m in markers {
        if m.layer.is_some() {
            layer = m.layer;
        }
        if m.move_index >= moves.len() {
            continue;
        }
        let last = starts.last_mut().unwrap();
        if last.0 == m.move_index {
            last.1 = layer.clone();
        } else {
            starts.push((m.move_index, layer.clone()));
        }
    }
    if starts.len() == 1 {
        starts.extend(repeated_blocks(moves).into_iter().map(|s| (s, None)));
    }

    let passes: Vec<Pass> = starts
        .iter()
        .enumerate()
        .map(|(index, (first, label))| {
            let end = starts.get(index + 1).map_or(moves.len(), |s| s.0);
            Pass {
                index: index as u32,
                first_move: *first as u32,
                move_count: (end - first) as u32,
                label: label.clone(),
            }
        })
        .collect();

    // Compare burned geometry pass by pass.
    let keys: Vec<Vec<Key>> = passes
        .iter()
        .map(|p| {
            burned(&moves[p.first_move as usize..(p.first_move + p.move_count) as usize]).map(|(_, k)| k).collect()
        })
        .collect();
    let mut repeated: Option<(u32, usize)> = None;
    for (i, key) in keys.iter().enumerate() {
        if key.is_empty() || keys[..i].contains(key) {
            continue;
        }
        let copies: Vec<usize> = (i + 1..keys.len()).filter(|&j| keys[j] == *key).collect();
        if let Some(&second) = copies.first() {
            let p = &passes[second];
            let pass_moves = &moves[p.first_move as usize..(p.first_move + p.move_count) as usize];
            let line = burned(pass_moves).next().map_or(0, |(i, _)| pass_moves[i].line);
            let count = copies.len() + 1;
            repeated = Some(match repeated {
                Some((l, c)) => (l.min(line), c.max(count)),
                None => (line, count),
            });
        }
    }
    (passes, repeated)
}

/// Move end quantised to 0.1 µm, so float noise doesn't hide a repeat.
type Key = (i64, i64);

fn burned(moves: &[Move]) -> impl Iterator<Item = (usize, Key)> + '_ {
    moves
        .iter()
        .enumerate()
        .filter(|(_, m)| beam_on(m))
        .map(|(i, m)| (i, ((m.x_mm * 1e4).round() as i64, (m.y_mm * 1e4).round() as i64)))
}

/// Pass starts (excluding 0) when the burned geometry is one block repeated.
fn repeated_blocks(moves: &[Move]) -> Vec<usize> {
    let (index, keys): (Vec<usize>, Vec<Key>) = burned(moves).unzip();
    let n = keys.len();
    let Some(block) = (1..=n / 2).find(|&b| n % b == 0 && (b..n).all(|k| keys[k] == keys[k % b])) else {
        return Vec::new();
    };
    // Each new pass starts right after the previous block's last burned move.
    (1..n / block).map(|t| index[t * block - 1] + 1).collect()
}
