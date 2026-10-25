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
mod files;
mod fixtures;
mod import_curamanager;
mod import_zip;
mod log;
mod logging;
mod match_key;
mod mesh_fixtures;
mod mesh_handler;
mod mesh_streaming;
mod obj;
mod png;
mod preview_support;
mod previews;
mod projects;
mod raster;
mod rescan;
mod runtime;
mod schemas;
mod server_boundary;
mod stl;
mod strip3mf;
mod threemf;
mod tsgen;
mod zip;
mod zip_write;
