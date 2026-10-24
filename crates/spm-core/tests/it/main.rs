//! spm-core's integration tests: one binary, one module per legacy test file. Each test's name
//! says what the legacy test it replaces said; the coverage table in the porting report maps one
//! to the other.

mod account;
mod admin;
mod auth;
mod chunks;
mod classify;
mod common;
mod compat;
mod db;
mod dtos;
mod entry_hash;
mod fixtures;
mod log;
mod logging;
mod match_key;
mod runtime;
mod schemas;
mod server_boundary;
mod strip3mf;
mod tsgen;
mod zip;
mod zip_write;
