//! The HTTP API end to end: the real router over a temporary library, ported from the legacy
//! `packages/server/test` suites (one module per legacy file).

mod support;

mod auth;
mod dev_proxy;
mod files;
mod import;
mod local_mode;
mod logging;
mod projects;
mod rate_limit;
mod static_ui;
mod users;
mod wire;
