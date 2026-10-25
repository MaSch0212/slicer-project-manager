//! `decodeURIComponent` / `encodeURIComponent`, with the failure behaviour the legacy server had.
//!
//! A lone `%` or an escape that does not decode to UTF-8 is *malformed*, which is not the same as
//! "left as it is": the percent-decoding in the `percent-encoding` crate passes a stray `%`
//! through, and a tag called `100%` must round-trip while `%` on its own must be a 400.

use spm_core::AppError;

/// Decodes a percent-encoded string, or `None` when an escape is malformed (a bare `%`, `%zz`, a
/// sequence that is not UTF-8).
pub fn try_decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let high = hex_digit(*bytes.get(at + 1)?)?;
            let low = hex_digit(*bytes.get(at + 2)?)?;
            out.push(high << 4 | low);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Decodes a percent-encoded string, or fails with a `Validation` error naming `label`. For
/// request data (headers, path segments) where a bad escape is the caller's mistake.
pub fn decode_uri_component_or_fail(value: &str, label: &str) -> Result<String, AppError> {
    try_decode_uri_component(value)
        .ok_or_else(|| AppError::validation(format!("{label} is not correctly percent-encoded")))
}

/// `encodeURIComponent`: everything except `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is escaped.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_well_formed_escapes() {
        assert_eq!(
            try_decode_uri_component("needs%20support").as_deref(),
            Some("needs support")
        );
        assert_eq!(
            try_decode_uri_component("100%25%20infill").as_deref(),
            Some("100% infill")
        );
        assert_eq!(
            try_decode_uri_component("%C3%A4").as_deref(),
            Some("\u{e4}")
        );
        assert_eq!(try_decode_uri_component("plain").as_deref(), Some("plain"));
    }

    #[test]
    fn a_malformed_escape_is_none_not_a_pass_through() {
        for bad in ["%", "%zz", "100%", "%4", "%C3", "%ff"] {
            assert_eq!(try_decode_uri_component(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_failing_form_is_a_validation_error_naming_the_label() {
        let error = decode_uri_component_or_fail("%", "tag name").unwrap_err();
        assert_eq!(error.code, spm_core::AppErrorCode::Validation);
        assert_eq!(error.message, "tag name is not correctly percent-encoded");
    }

    #[test]
    fn encoding_matches_encode_uri_component() {
        assert_eq!(encode_uri_component("needs support"), "needs%20support");
        assert_eq!(encode_uri_component("100% infill"), "100%25%20infill");
        assert_eq!(
            encode_uri_component("a-b_c.d!e~f*g'h(i)"),
            "a-b_c.d!e~f*g'h(i)"
        );
        assert_eq!(encode_uri_component("\u{e4}/x"), "%C3%A4%2Fx");
    }

    #[test]
    fn encode_then_decode_round_trips() {
        for value in ["100% infill", "a/b?c=d&e", "\u{1f600}", "semi;colon"] {
            assert_eq!(
                try_decode_uri_component(&encode_uri_component(value)).as_deref(),
                Some(value)
            );
        }
    }
}
