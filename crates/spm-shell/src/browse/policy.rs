//! What the model browser's view may navigate to, and what a request for a new window becomes.
//!
//! **A different policy from [`crate::nav::navigation_policy`], not a second call to it.** The main
//! webview's policy sends `http(s)` to the system browser, which is exactly what a model browser
//! must not do: a browse view that opened every link in the user's browser would not be a browser.
//! The two invert on `http(s)`, and a test pins that.
//!
//! | answer | for |
//! |---|---|
//! | allow | `http:` and `https:`: this is a browser |
//! | allow | **`blob:` and `data:`**: a download depends on it (Thingiverse's download URL *is* a `blob:`) |
//! | allow | `about:blank` |
//! | block | everything else: `file:` (a dropped file is a `file:` navigation), `javascript:`, a custom scheme (`bambustudio:`), `about:srcdoc`, anything unparseable |
//!
//! There is **no host allowlist**, and that is a decision rather than an omission: containment is
//! the view's own storage and its absence from every capability, not a list of hostnames. A list
//! would read as the boundary while doing none of that work, and it would break a site's own CDN,
//! its consent vendor and the identity provider a user signs in through.

use url::Url;

/// The longest scheme a refusal sentence repeats: a site chooses how long it is.
pub const MAX_REFUSAL_SCHEME: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowsePolicy {
    Allow,
    Block,
}

/// Whether the browse view may go to `url`.
pub fn browse_navigation_policy(url: &str) -> BrowsePolicy {
    let Ok(parsed) = Url::parse(url) else {
        return BrowsePolicy::Block;
    };
    match parsed.scheme() {
        "http" | "https" | "blob" | "data" => BrowsePolicy::Allow,
        "about" if parsed.path() == "blank" => BrowsePolicy::Allow,
        _ => BrowsePolicy::Block,
    }
}

/// What a request for a new window becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenDecision {
    /// Refused (and recorded): the policy blocks the URL.
    Deny,
    /// The view itself goes there, and no window is made.
    Navigate,
    /// A page that wants a window of its own and has nothing the view could load for it:
    /// `about:blank`, the deferred-popup idiom (`w = window.open(); w.location = url`).
    Popup,
}

/// Decides what to do with `window.open(url)` or a `target=_blank` link.
///
/// **Under Tauri a new window is never made.** The Electron build answered a popup with an
/// `allow` and pinned the trust flags of the window it got, so a site's sign-in popup and its
/// `opener.postMessage` kept working. `on_new_window` here carries the URL and the window's
/// geometry but not a frame name, and the one way to *give* it a window is to build a second,
/// unmanaged native window, which is a window the app would have to show. So an `http(s)`, `blob:`
/// or `data:` target is routed into the view (which is what a plain `_blank` link always was, and
/// what keeps `window.open(blobUrl)` the third download idiom working), and the deferred
/// `about:blank` form is denied. A sign-in that needs its opener is the one thing that does not
/// survive; E never measured one (9.12).
pub fn browse_open_decision(url: &str) -> OpenDecision {
    if browse_navigation_policy(url) == BrowsePolicy::Block {
        return OpenDecision::Deny;
    }
    match Url::parse(url).ok().as_ref().map(Url::scheme) {
        Some("http" | "https" | "blob" | "data") => OpenDecision::Navigate,
        _ => OpenDecision::Popup,
    }
}

/// The sentence the chrome shows when the policy refused a navigation. **It never contains the
/// URL**: a site chooses the URL, and the scheme is all the user needs to know.
pub fn describe_refusal(url: &str) -> String {
    match Url::parse(url) {
        Ok(parsed) => {
            let scheme: String = format!("{}:", parsed.scheme())
                .chars()
                .take(MAX_REFUSAL_SCHEME)
                .collect();
            format!("the model browser does not open {scheme} URLs")
        }
        Err(_) => "the model browser refused a navigation to a URL it could not parse".to_owned(),
    }
}

/// Whether `url` is one the browser will remember as the last page (and a download will name as
/// the page it came from): `http(s)` only, and of a sane length. Narrower than the policy on
/// purpose: a `data:` URL is a whole document inlined into a string, and a `blob:` URL is dead the
/// moment the document that minted it goes.
pub fn is_http_url(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && Url::parse(value).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
}
