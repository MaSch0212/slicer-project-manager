//! Slicers (subsystem D): which slicers this computer has, handing a file to one, and what became
//! of the files it was handed.
//!
//! A port of the Electron shell's `slicers/*`, with its behaviour (the registry of five, the
//! Windows-measured detection, the machine-local store, the two launch paths, the launch
//! directory's lifetime rules, the remote-mode download-and-reconcile loop) and its constraints
//! unchanged. Nothing in here starts a window or needs one: the process spawn, the detection
//! subprocess, the timers, the directory watch, the native dialog and the remote server are all
//! seams, so every path runs under plain `cargo test`.
//!
//! | module | what it owns |
//! |---|---|
//! | [`registry`] | the five products, as measured: names, executables, behaviour flags |
//! | [`detect`] | finding installs: one PowerShell subprocess, parsed defensively |
//! | [`config`] | `slicers.json`, merging a scan into it, resolving an install to a path |
//! | [`host`] | the configuration operations (scan, bind, add by hand, reset, resolve) |
//! | [`launch`] | the launch itself: both paths, the strip, the record, the notices |
//! | [`sessions`] | the watch, the comparison, the sweeps, the reconcile |
//! | [`remote_files`] | what a remote library is asked for, through the proxy |
//! | [`spawn`] | the real process spawn: detached, no console, no secrets |
//! | [`sched`] | the timers and the directory watch, as seams |
//! | [`api`] | the commands, with every argument validated |
//! | [`service`] | the assembled subsystem |

pub mod api;
pub mod config;
pub mod detect;
pub mod host;
pub mod launch;
pub mod registry;
pub mod remote_files;
pub mod sched;
pub mod service;
pub mod sessions;
pub mod spawn;
pub mod winpath;
