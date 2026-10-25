//! Where the shell's own diagnostics go: stderr, one line each, prefixed so a user pasting the log
//! can tell the shell's words from the library's.
//!
//! Functions that have something to say take a sink as a parameter (`warn: &mut dyn FnMut(&str)`)
//! in their `_with` form, so a test can assert what was said; the plain form uses these.

#![allow(clippy::print_stderr)]

pub fn warn(message: &str) {
    eprintln!("desktop: {message}");
}

pub fn error(message: &str) {
    eprintln!("desktop: error: {message}");
}
