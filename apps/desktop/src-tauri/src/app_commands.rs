//! The desktop commands the web app may `invoke`: the one list the build script, the handler
//! registration and the capability all read.
//!
//! `build.rs` turns each name into a permission (`allow-<name with dashes>`) through the app
//! manifest, which is what makes Tauri refuse every command *not* on this list for every webview,
//! and the runtime capability in [`crate::security`] grants exactly these permissions to the main
//! webview. Parts 2 and 3 add their commands here (and to `tauri::generate_handler!`); a test in
//! `tests/security.rs` fails when the two lists disagree.

/// Every app command, by its Rust function name.
pub const APP_COMMANDS: &[&str] = &[
    "desktop_library_state",
    "desktop_library_pick",
    "desktop_library_connect",
    "desktop_library_choose",
    // Slicers (desktop part 2): configuration, launching, and the sessions a launch leaves.
    "desktop_slicers_get",
    "desktop_slicers_scan",
    "desktop_slicers_add_manual",
    "desktop_slicers_remove",
    "desktop_slicers_bind",
    "desktop_slicers_set_default",
    "desktop_slicers_reset_config",
    "desktop_slicers_open",
    "desktop_slicers_sessions",
    "desktop_slicers_resolve_session",
    "desktop_slicers_discard_sessions",
];
