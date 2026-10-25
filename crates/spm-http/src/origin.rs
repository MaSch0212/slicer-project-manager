//! Origins: the public one activation links are built on, and the request's own.

use spm_core::AppError;
use url::Url;

/// Turns a configured `SPM_PUBLIC_ORIGIN` into a bare origin, or fails.
///
/// Normalising means a trailing slash or a stray path in the variable cannot produce
/// `https://host//activate#tok`. Failing on anything that is not an http(s) URL is deliberate: a
/// typo must stop the server rather than quietly revert to the `http://` links this setting
/// exists to avoid.
pub fn normalize_public_origin(raw: &str) -> Result<String, AppError> {
    let parsed = Url::parse(raw).map_err(|_| {
        AppError::validation(format!(
            "SPM_PUBLIC_ORIGIN is not a valid absolute URL: {raw}"
        ))
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::validation(format!(
            "SPM_PUBLIC_ORIGIN must be an http(s) URL: {raw}"
        )));
    }
    Ok(parsed.origin().ascii_serialization())
}

/// The origin of a request that reached this plain-http listener, from the authority the client
/// addressed. Falls back to `http://localhost` for a request with no usable authority.
pub fn request_origin(authority: Option<&str>) -> String {
    authority
        .and_then(|authority| Url::parse(&format!("http://{authority}/")).ok())
        .map_or_else(
            || "http://localhost".to_owned(),
            |url| url.origin().ascii_serialization(),
        )
}

/// The activation link for `token`. The token rides in the fragment, so it never reaches a server
/// log, an access log or a `Referer` header.
///
/// The origin is `public_origin` when configured, otherwise the request's own. Behind a
/// TLS-terminating proxy the request origin would be `http://`, and an `http://` link drops the
/// `Secure` session cookie the activation response sets, leaving the user activated but not
/// signed in. `X-Forwarded-Proto` is deliberately not consulted: a client sets it.
pub fn activation_url(request_origin: &str, token: &str, public_origin: Option<&str>) -> String {
    format!(
        "{}/activate#{token}",
        public_origin.unwrap_or(request_origin)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use spm_core::AppErrorCode;

    #[test]
    fn activation_links_use_the_public_origin_when_it_is_configured() {
        let origin = request_origin(Some("10.0.0.4:8000"));
        assert_eq!(
            activation_url(&origin, "tok", None),
            "http://10.0.0.4:8000/activate#tok"
        );
        assert_eq!(
            activation_url(&origin, "tok", Some("https://print.example.com")),
            "https://print.example.com/activate#tok"
        );
    }

    #[test]
    fn a_configured_public_origin_is_normalised_down_to_a_bare_origin() {
        // A trailing slash or a stray path would otherwise produce `...//activate#tok`.
        assert_eq!(
            normalize_public_origin("https://print.example.com/").unwrap(),
            "https://print.example.com"
        );
        assert_eq!(
            normalize_public_origin("https://print.example.com/spm?x=1#y").unwrap(),
            "https://print.example.com"
        );
        assert_eq!(
            normalize_public_origin("https://print.example.com:8443").unwrap(),
            "https://print.example.com:8443"
        );
    }

    #[test]
    fn a_public_origin_that_is_not_an_http_url_is_refused_not_silently_ignored() {
        for raw in [
            "print.example.com",
            "ftp://print.example.com",
            "not a url at all",
        ] {
            let error = normalize_public_origin(raw).unwrap_err();
            assert_eq!(error.code, AppErrorCode::Validation);
            assert!(error.message.starts_with("SPM_PUBLIC_ORIGIN"), "{raw}");
            assert!(error.message.contains(raw), "{raw}");
        }
    }

    #[test]
    fn the_request_origin_is_the_authority_over_http() {
        assert_eq!(request_origin(Some("localhost")), "http://localhost");
        assert_eq!(
            request_origin(Some("Print.Example:8000")),
            "http://print.example:8000"
        );
        assert_eq!(request_origin(Some("localhost:80")), "http://localhost");
        assert_eq!(request_origin(None), "http://localhost");
        assert_eq!(request_origin(Some("not a host")), "http://localhost");
    }
}
