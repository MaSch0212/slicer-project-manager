//! `spm-server` end to end: the run loop in-process, the binary as a child process, the
//! `import-curamanager` command, and the guards on how it is built.

mod common;

mod binary;
mod import_cli;
mod previews;
mod release_profile;
mod serve;
