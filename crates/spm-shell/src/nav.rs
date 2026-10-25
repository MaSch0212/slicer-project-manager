//! Where the main webview may go, and what happens to links that leave.
//!
//! The webview shows the app and nothing else, from its own loopback origin. A link in a project's
//! description, a "source URL", a pasted address: those are somebody else's pages, and **they must
//! not load inside the window that can reach desktop commands**. Tauri injects its bridge into
//! every page a webview loads; navigating away would hand that page the chance to ask. So an
//! `http(s)` link opens in the system browser, and everything else is refused.

use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationPolicy {
    /// Stay: it is the app's own origin.
    Allow,
    /// Open in the system browser and do not navigate.
    External,
    /// Refuse.
    Block,
}

/// What to do with a top-level navigation of the main webview whose own origin is `app_origin`
/// (`http://127.0.0.1:<port>`).
///
/// Scheme, host *and port* are compared: another local server on `127.0.0.1:<other>` is not this
/// app. `http(s)` anywhere else is external; `javascript:`, `file:`, `data:`, `blob:`, `about:`
/// (including `about:blank`, which inherits the opener's origin) and every custom scheme are
/// refused, as is anything that does not parse.
pub fn navigation_policy(url: &str, app_origin: &str) -> NavigationPolicy {
    let Ok(parsed) = Url::parse(url) else {
        return NavigationPolicy::Block;
    };
    if matches!(parsed.scheme(), "http" | "https") {
        // Credentials in a URL are how one host is made to read as another.
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return NavigationPolicy::Block;
        }
        if parsed.origin().ascii_serialization() == app_origin {
            return NavigationPolicy::Allow;
        }
        return NavigationPolicy::External;
    }
    NavigationPolicy::Block
}

/// Whether `url` may be handed to the operating system's opener. Only web pages: handing a
/// `file:` or a custom-scheme URL to the shell would execute things.
pub fn is_openable_externally(url: &str) -> bool {
    Url::parse(url).is_ok_and(|parsed| {
        matches!(parsed.scheme(), "http" | "https")
            && parsed.host_str().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none()
    })
}
