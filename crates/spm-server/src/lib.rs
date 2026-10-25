//! The NAS binary's parts: environment validation, the embedded web bundle, the server run loop
//! and the `import-curamanager` command. `main.rs` only dispatches between them.

pub mod env;
pub mod import_cli;
pub mod progress;
pub mod serve;
pub mod web;
