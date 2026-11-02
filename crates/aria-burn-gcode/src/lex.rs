// SPDX-License-Identifier: GPL-3.0-or-later
//! Splits one G-code line into words and comments, the way GRBL 1.1 reads it:
//! whitespace is insignificant (even inside numbers), letters are
//! case-insensitive, `( … )` and `; …` are comments.

use crate::LineError;

#[derive(Debug, Default, PartialEq)]
pub struct Lexed {
    /// Words in source order, letter upper-cased. `N` line numbers are dropped.
    pub words: Vec<(char, f64)>,
    pub comments: Vec<String>,
    /// `$…` system line (`$H`, `$$`, `$32=1`): not G-code, passed through as is.
    pub system: Option<String>,
}

pub fn lex(line: &str) -> Result<Lexed, LineError> {
    let mut out = Lexed::default();
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix('$') {
        out.system = Some(rest.to_owned());
        return Ok(out);
    }
    // `%` marks program start/end in some senders; GRBL ignores it.
    if trimmed == "%" {
        return Ok(out);
    }
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {}
            '(' => {
                let comment: String = chars.by_ref().take_while(|&c| c != ')').collect();
                out.comments.push(comment.trim().to_owned());
            }
            ';' => {
                out.comments.push(chars.by_ref().collect::<String>().trim().to_owned());
            }
            c if c.is_ascii_alphabetic() => {
                let letter = c.to_ascii_uppercase();
                let mut number = String::new();
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_digit() || matches!(n, '.' | '+' | '-') {
                        number.push(n);
                    } else if !n.is_whitespace() {
                        break;
                    }
                    chars.next();
                }
                let value = number
                    .parse::<f64>()
                    .ok()
                    .filter(|v| v.is_finite())
                    .ok_or_else(|| LineError::bad_number(letter, &number))?;
                if letter != 'N' {
                    out.words.push((letter, value));
                }
            }
            other => return Err(LineError::expected_letter(other)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_and_spaced_forms_agree() {
        let a = lex("G1X10.5Y-2S500F1200").unwrap();
        let b = lex("g1 x 1 0.5 y -2 s500 f 1200").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.words, vec![('G', 1.0), ('X', 10.5), ('Y', -2.0), ('S', 500.0), ('F', 1200.0)]);
    }

    #[test]
    fn comments_and_line_numbers() {
        let l = lex("N10 G0 X1 (rapid) Y2 ; Cut @ 600 mm/min").unwrap();
        assert_eq!(l.words, vec![('G', 0.0), ('X', 1.0), ('Y', 2.0)]);
        assert_eq!(l.comments, vec!["rapid", "Cut @ 600 mm/min"]);
    }

    #[test]
    fn system_and_percent_lines() {
        assert_eq!(lex("$H").unwrap().system.as_deref(), Some("H"));
        assert_eq!(lex(" % ").unwrap(), Lexed::default());
    }

    #[test]
    fn leading_dot_and_sign() {
        assert_eq!(lex("X.5Y-.25Z+1").unwrap().words, vec![('X', 0.5), ('Y', -0.25), ('Z', 1.0)]);
    }

    #[test]
    fn errors() {
        assert_eq!(lex("G1 X").unwrap_err().grbl_error, 2);
        assert_eq!(lex("G1 X1.2.3").unwrap_err().grbl_error, 2);
        assert_eq!(lex("G1 #5").unwrap_err().grbl_error, 1);
    }
}
