//! What the webviews may ask of the Rust side, and where each is allowed to ask from.
//!
//! # The configuration, and why it is safe
//!
//! Tauri injects `window.__TAURI_INTERNALS__` into **every page every webview loads**, remote ones
//! included (measured in the model-browser spike). The bridge is therefore always *present*; what
//! decides whether a call through it succeeds is only the capability ACL. This module is that
//! decision, and it is built from four rules:
//!
//! 1. **No static capability file.** `capabilities/` is empty and `app.security.capabilities` in
//!    `tauri.conf.json` is an empty list, so nothing is granted at build time to anybody.
//! 2. **One runtime capability, for one webview.** The main webview loads
//!    `http://127.0.0.1:<port>`, and Tauri treats anything that is not its own asset origin as
//!    *remote*, so a grant needs a `remote.urls` entry. The port is not known until the listener
//!    has bound, so the capability is created then, with **that exact origin**
//!    (`http://127.0.0.1:41234/*`): not `127.0.0.1:*`, not `localhost`, not any other loopback port
//!    (another local process's server) and not a wildcard host. It is `local: false`, so the
//!    app's own `tauri://` origin gets nothing either.
//! 3. **By webview label, not window.** `webviews: ["main"]` and `windows: []`. A window-scoped
//!    capability applies to every webview the window ever hosts (Tauri documents this, and the
//!    spike confirmed it), including the model browser's child webview in part 3, which is a
//!    *different label* (`browse`) and is never named here.
//! 4. **Permissions are app commands only.** The grant is the `allow-<command>` permissions the
//!    app manifest generated from [`crate::app_commands::APP_COMMANDS`]. No `core:*` permission, no
//!    plugin permission (the dialog plugin is initialised for Rust-side use and its JS commands are
//!    not granted), so the page cannot reach windows, webviews, events, paths, the dialog or the
//!    filesystem. Commands that exist but are not in the manifest list are refused for everybody.
//!
//! The consequence for the remote-server mode: the webview is *never* on the server's origin
//! (`crate::remote` proxies it), so even a hostile server's HTML never lands on an origin the ACL
//! would have to refuse. And for the model browser: the site webview has a different label and a
//! different origin, so it matches no capability at all.

use serde_json::{Value, json};

use crate::app_commands::APP_COMMANDS;

/// The label of the main webview: the only one that is granted anything.
pub const MAIN_WEBVIEW: &str = "main";

/// The identifier of the runtime capability.
pub const MAIN_CAPABILITY: &str = "main-loopback";

/// The permission an app command is granted through (what `tauri-build` generates for it).
pub fn permission_for(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

/// The remote URL pattern for exactly this origin (`http://127.0.0.1:<port>`).
pub fn remote_url_pattern(origin: &str) -> String {
    format!("{origin}/*")
}

/// The capability that lets the main webview call the app commands, for the listener at
/// `origin`. Pure data, so a test can assert every rule of the module docs without a window.
pub fn main_capability(origin: &str) -> Value {
    json!({
        "identifier": MAIN_CAPABILITY,
        "description": "The main webview, on the app's own loopback origin, may call the app's \
                        desktop commands and nothing else.",
        "local": false,
        "windows": [],
        "webviews": [MAIN_WEBVIEW],
        "remote": { "urls": [remote_url_pattern(origin)] },
        "permissions": APP_COMMANDS.iter().map(|command| permission_for(command)).collect::<Vec<_>>(),
    })
}
