//! The model browser (subsystem E): the four sites, what the embedded view may navigate to, where
//! a download goes, and how a download becomes a file of a project.
//!
//! A port of the Electron shell's `browse/*`, with its behaviour (the registry of four, the
//! navigation policy, the staging directory and its record, the three caps, the sweep that refuses
//! what it cannot vouch for, landing through the library API) and its constraints unchanged.
//! Nothing here creates a window or needs one: the child webview, the host window, the clock, the
//! ids and the library are all seams, so every path runs under plain `cargo test`.
//!
//! | module | what it owns |
//! |---|---|
//! | [`registry`] | the four sites as measured: hosts, home pages, the identity a model URL carries |
//! | [`policy`] | what the view may navigate to, what a new-window request becomes, the refusal sentences |
//! | [`bounds`] | the rectangle the view is allowed, computed by the shell and never named by the page |
//! | [`last_page`] | `browse.json`: the page the browser was last sitting on |
//! | [`notices`] | what the app has to say about downloads nobody was watching |
//! | [`downloads`] | the staging directory, its record, the caps and the sweep |
//! | [`land`] | a staged download becoming a file of a project, through the library API |
//! | [`api`] | the library API as the shell reaches it, in both library modes |
//! | [`host`] | the view's lifecycle, behind a seam |
//! | [`commands`] | the commands, with every argument validated |
//! | [`service`] | the assembled subsystem |
//!
//! **What changed in the move to Tauri** is written where it bites, and summarised here: WebView2
//! reports no progress, no content length, no MIME type and no user-gesture flag for a download
//! (only `Requested` and `Finished`), so the record carries the size it ended with; `on_new_window`
//! carries no frame name, so a popup is routed into the view instead of becoming a window; and a
//! load that fails raises no event, so `lastError` only ever carries refusals.

pub mod api;
pub mod bounds;
pub mod commands;
pub mod downloads;
pub mod host;
pub mod land;
pub mod last_page;
pub mod notices;
pub mod policy;
pub mod registry;
pub mod service;
