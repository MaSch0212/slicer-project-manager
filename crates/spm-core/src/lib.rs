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

pub mod auth;
pub mod clock;
pub mod ctx;
pub mod db;
pub mod dto;
pub mod error;
pub mod files;
pub mod log;
pub mod match_key;
pub mod previews;
pub mod projects;
pub mod tsgen;
pub mod users;
pub mod validate;

#[cfg(feature = "testing")]
pub mod testing;

pub use auth::login::{LoginResult, activate_account, login};
pub use ctx::Ctx;
pub use db::ids::new_id;
pub use db::{Library, OpenOptions};
pub use error::{AppError, AppErrorCode, Result};
pub use files::usecases::{
    ResolvedFile, assert_within_quota, content_type_for, delete_file, rename_file,
    resolve_file_path, resolve_preview_path, upload_file,
};
pub use log::{LogLevel, LogLevelSetting, Logger};
pub use previews::{BatchResult, PreviewConfig, PreviewWorker, run_preview_batch};
pub use projects::import_curamanager::{
    CuraManagerImport, ImportProgress, import_curamanager_library,
};
pub use projects::import_zip::import_curamanager_zip;
pub use projects::queries::{get_project, list_projects, list_tags};
pub use projects::rescan::{RescanProgress, rescan};
pub use projects::usecases::{add_tag, create_project, delete_project, remove_tag, update_project};
pub use users::account::{change_password, me, update_profile};
pub use users::admin::{
    CreatedUser, create_user, delete_user, list_users, reissue_invite, require_admin, update_user,
};
pub use users::bootstrap::{BootstrapAdmin, ensure_bootstrap_admin, ensure_local_user};
pub use users::settings::{get_settings, put_settings};

/// The application's display name.
pub fn app_name() -> &'static str {
    "Slicer Project Manager"
}
