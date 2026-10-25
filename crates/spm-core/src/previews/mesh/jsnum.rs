//! `Number(text)` as JavaScript spells it.
//!
//! The legacy parsers read every coordinate and index with `Number()`, and the library's files
//! were accepted under its grammar: surrounding whitespace is ignored, `""` is `0`, `0x1f` is 31,
//! `1e3` is 1000, `Infinity` is infinite, and anything else is NaN. Rust's `str::parse::<f64>`
//! differs in both directions (it accepts `inf` and `nan`, it rejects `0x10` and padding), so the
//! parsers go through this instead and a file means the same thing it always did.

/// Whether JavaScript's `String.prototype.trim` strips this character.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// The number `Number(text)` yields, NaN where JavaScript's would be.
pub(crate) fn js_number(text: &str) -> f64 {
    let text = text.trim_matches(is_js_space);
    if text.is_empty() {
        return 0.0;
    }
    if let Some(radix) = radix_of(text) {
        let digits = &text[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        // Accumulated in f64 as the engine does: exact up to 2^53 and rounded past it.
        return digits.chars().fold(0.0, |value, c| {
            value * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
        });
    }
    let (sign, rest) = match text.as_bytes()[0] {
        b'-' => (-1.0, &text[1..]),
        b'+' => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    if rest == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(rest) {
        return f64::NAN;
    }
    rest.parse::<f64>().map_or(f64::NAN, |value| sign * value)
}

/// `0x`, `0o` and `0b` prefixes (any case), which JavaScript accepts only without a sign.
fn radix_of(text: &str) -> Option<u32> {
    let bytes = text.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'0' {
        return None;
    }
    match bytes[1] {
        b'x' | b'X' => Some(16),
        b'o' | b'O' => Some(8),
        b'b' | b'B' => Some(2),
        _ => None,
    }
}

/// `digits [. digits?] | . digits`, then an optional exponent: the grammar `StrDecimalLiteral`
/// allows once the sign and `Infinity` are out of the way.
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let mut at = digits(0);
    let integer_digits = at;
    let mut fraction_digits = 0;
    if bytes.get(at) == Some(&b'.') {
        fraction_digits = digits(at + 1);
        at += 1 + fraction_digits;
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let mut exponent = at + 1;
        if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
            exponent += 1;
        }
        let exponent_digits = digits(exponent);
        if exponent_digits == 0 {
            return false;
        }
        at = exponent + exponent_digits;
    }
    at == bytes.len()
}

/// `Number.isInteger`.
pub(crate) fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}
