//! The desktop shell's logic, with no window in it.
//!
//! Everything the Tauri app does that is not "show a window" lives here, so it runs under plain
//! `cargo test` with no GUI: the loopback listener and its launch secret ([`gate`], [`server`]),
//! the reverse proxy for remote-server mode ([`remote`]), the library host and the mode state
//! machine ([`library`], [`shell`]), what is remembered between launches ([`state`],
//! [`json_store`]), the capability columns ([`capabilities`]), and the policies the windows apply
//! ([`nav`], [`permissions`]).
//!
//! `apps/desktop/src-tauri` is the thin glue that turns these into windows, menus and `invoke`
//! commands.

#![deny(clippy::print_stdout)]

pub mod capabilities;
pub mod diag;
pub mod gate;
pub mod json_store;
pub mod library;
pub mod nav;
pub mod permissions;
pub mod remote;
pub mod server;
pub mod shell;
pub mod smoke;
pub mod state;
pub mod sync;
pub mod web;
