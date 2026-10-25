//! Which permission requests the app's own webview grants: none.
//!
//! The Electron shell granted exactly one (`clipboard-sanitized-write`, which its own copy buttons
//! made); the web app's copy affordance goes through `navigator.clipboard.writeText`, which
//! WebView2 allows for a user gesture without a permission prompt, so the list is empty. A page
//! that asks for the camera, the microphone, the location, notifications, MIDI, the clipboard's
//! *read* side, or anything else is refused, without a prompt a user could be talked into
//! accepting.
//!
//! This is the list; the Windows glue ([`crate::webview2`] in the desktop crate) installs it as
//! the webview's permission handler.

/// Permission names the app grants. Spelled the way the platform names them.
pub const APP_PERMISSIONS: &[&str] = &[];

/// Whether a permission request is granted.
pub fn is_permission_allowed(permission: &str) -> bool {
    APP_PERMISSIONS.contains(&permission)
}
