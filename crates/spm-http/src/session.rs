//! The session cookie: reading it, and the attributes it is set with.

use axum::http::header::{COOKIE, HOST};
use axum::http::{HeaderMap, Uri};

use crate::percent::{encode_uri_component, try_decode_uri_component};

pub const SESSION_COOKIE: &str = "spm_session";

/// The session token in the request's `Cookie` header(s), or `None`.
///
/// A malformed escape means there is no usable token, not a validation error to report: falling
/// through to `None` lets the caller produce its normal 401.
pub fn read_session_token(headers: &HeaderMap) -> Option<String> {
    // HTTP/2 may split the header into several fields; they join with `; `.
    let joined = headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join("; ");
    for part in joined.split(';') {
        let part = part.trim();
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if name == SESSION_COOKIE {
            return try_decode_uri_component(value);
        }
    }
    None
}

/// The authority the client addressed: the URI's, for an absolute-form request or HTTP/2, else
/// the `Host` header.
pub fn request_authority(uri: &Uri, headers: &HeaderMap) -> Option<String> {
    if let Some(authority) = uri.authority() {
        return Some(authority.as_str().to_owned());
    }
    headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// The host name of an authority, lower-cased, without its port. IPv6 literals keep their
/// brackets.
pub fn hostname(authority: &str) -> String {
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if authority.starts_with('[') {
        authority
            .find(']')
            .map_or(authority, |end| &authority[..=end])
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) if port.bytes().all(|byte| byte.is_ascii_digit()) => host,
            _ => authority,
        }
    };
    host.to_ascii_lowercase()
}

/// `Secure` is dropped only for a plain-http localhost origin, so development over http still
/// works. This listener only ever speaks plain http (TLS terminates at a proxy in front, whose
/// requests carry the public host name), so the scheme half of the test is always true here and
/// the host name is what decides. `X-Forwarded-Proto` is deliberately not consulted: a client
/// sets it, not the network.
pub fn is_local_http(authority: Option<&str>) -> bool {
    authority.is_some_and(|authority| {
        let host = hostname(authority);
        host == "localhost" || host == "127.0.0.1"
    })
}

fn attributes(local_http: bool, max_age: i64) -> String {
    let mut parts = vec![
        "Path=/".to_owned(),
        "HttpOnly".to_owned(),
        "SameSite=Lax".to_owned(),
        format!("Max-Age={max_age}"),
    ];
    if !local_http {
        parts.push("Secure".to_owned());
    }
    parts.join("; ")
}

/// The `Set-Cookie` value that establishes a session expiring at `expires_at` (epoch ms).
pub fn session_set_cookie(token: &str, expires_at: i64, now: i64, local_http: bool) -> String {
    let max_age = ((expires_at - now) / 1000).max(0);
    format!(
        "{SESSION_COOKIE}={}; {}",
        encode_uri_component(token),
        attributes(local_http, max_age)
    )
}

/// The `Set-Cookie` value that clears the session.
pub fn session_clear_cookie(local_http: bool) -> String {
    format!("{SESSION_COOKIE}=; {}", attributes(local_http, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(cookie: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(COOKIE, HeaderValue::from_str(cookie).unwrap());
        map
    }

    #[test]
    fn reads_the_token_among_other_cookies() {
        assert_eq!(
            read_session_token(&headers("a=1; spm_session=tok%2Dx; b=2")).as_deref(),
            Some("tok-x")
        );
        assert_eq!(read_session_token(&headers("a=1")), None);
        assert_eq!(read_session_token(&HeaderMap::new()), None);
    }

    #[test]
    fn a_value_with_equals_signs_keeps_them() {
        assert_eq!(
            read_session_token(&headers("spm_session=a=b=c")).as_deref(),
            Some("a=b=c")
        );
    }

    #[test]
    fn a_malformed_escape_is_no_token() {
        assert_eq!(read_session_token(&headers("spm_session=%")), None);
    }

    #[test]
    fn several_cookie_fields_are_read_as_one() {
        let mut map = HeaderMap::new();
        map.append(COOKIE, HeaderValue::from_static("a=1"));
        map.append(COOKIE, HeaderValue::from_static("spm_session=tok"));
        assert_eq!(read_session_token(&map).as_deref(), Some("tok"));
    }

    #[test]
    fn hostnames_lose_ports_and_case() {
        assert_eq!(hostname("LocalHost:8000"), "localhost");
        assert_eq!(hostname("127.0.0.1"), "127.0.0.1");
        assert_eq!(hostname("[::1]:8000"), "[::1]");
        assert_eq!(hostname("print.example.com:443"), "print.example.com");
    }

    #[test]
    fn secure_is_dropped_only_for_plain_http_localhost() {
        assert!(is_local_http(Some("localhost")));
        assert!(is_local_http(Some("localhost:8000")));
        assert!(is_local_http(Some("127.0.0.1:3000")));
        assert!(!is_local_http(Some("print.example.com")));
        assert!(!is_local_http(Some("10.0.0.4:8000")));
        assert!(!is_local_http(Some("localhost.example.com")));
        assert!(!is_local_http(Some("[::1]:8000")));
        assert!(!is_local_http(None));
    }

    #[test]
    fn the_cookie_carries_the_attributes() {
        let local = session_set_cookie("tok", 10_000, 0, true);
        assert_eq!(
            local,
            "spm_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=10"
        );
        let public = session_set_cookie("tok", 10_000, 0, false);
        assert_eq!(
            public,
            "spm_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=10; Secure"
        );
        assert!(session_clear_cookie(false).ends_with("Max-Age=0; Secure"));
        assert!(session_set_cookie("tok", 0, 5_000, true).contains("Max-Age=0"));
    }
}
