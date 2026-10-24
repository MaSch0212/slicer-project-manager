//! Application behaviour: db, auth, users, files, projects, import, previews.
//!
//! # Shape of the API
//!
//! * [`Library::open`] opens (and migrates) a library folder and returns a cheap-to-clone,
//!   thread-safe handle. Every use case takes `&Library`.
//! * A request is authenticated by the transport, which turns a session token into a [`Ctx`] with
//!   [`auth::sessions::resolve_session`]. Use cases that act for a user take `&Ctx`; ownership and
//!   authorisation are enforced inside core, never by the caller.
//! * Every use case is synchronous and returns [`Result`]. An async caller wraps the call in
//!   `spawn_blocking`.
//! * Failures are [`AppError`]: a stable string [`AppErrorCode`] (an i18n key in the UI), a
//!   message safe to show, optional `details`.
//! * Input from outside goes through [`validate`], which is the single place the rules live.
//! * DTOs live in [`dto`]; TypeScript is generated from them by [`tsgen`].
//!
//! Nothing here prints: logging goes to the [`Logger`] the library was opened with, silent by
//! default.

#![deny(clippy::print_stdout, clippy::print_stderr)]

pub mod clock;
pub mod ctx;
pub mod dto;
pub mod error;
pub mod log;
pub mod match_key;
pub mod tsgen;
pub mod validate;

pub use ctx::Ctx;
pub use error::{AppError, AppErrorCode, Result};
pub use log::{LogLevel, LogLevelSetting, Logger};

/// The application's display name.
pub fn app_name() -> &'static str {
    "Slicer Project Manager"
}
