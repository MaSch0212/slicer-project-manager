//! `spm-server import-curamanager <library-dir> <username> [--in-place]`
//!
//! The migration entry point (parent spec 3.6): adopts an existing CuraManager library into a
//! Slicer Project Manager library owned by one user.
//!
//! It is a command rather than an HTTP endpoint on purpose: it renames directories on disk for a
//! single named user, once, and wants no new authenticated surface on the running server. (The
//! zip upload route is the other way in, for a library on another machine.)
//!
//! A CuraManager library is flat: every project folder sits at the library root. By default this
//! moves them all under the target user's own folder, which is the layout the rest of the app
//! assumes. `--in-place` skips that move, for a library whose folders already sit under the right
//! user directory.
//!
//! The move is all-or-nothing: if any folder name already exists under the target user's folder,
//! the whole operation is refused before anything is renamed, the colliding names are reported and
//! the exit status is non-zero. Nothing has moved at that point, so the fix is to rename the
//! collisions and run it again.

use std::io::Write;
use std::sync::Arc;

use spm_core::log::{LogLevelSetting, console_sink, parse_log_level};
use spm_core::projects::import_curamanager::ImportProgress;
use spm_core::{
    AppError, Ctx, Library, Logger, OpenOptions, import_curamanager_library, list_users,
};

use crate::progress::Progress;

pub const USAGE: &str =
    "usage: spm-server import-curamanager <library-dir> <username> [--in-place]";

fn plural(count: i64, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

/// Runs the command and returns the process exit status.
///
/// `get_env` is the environment lookup (only `SPM_LOG_LEVEL` is read), `out` and `err` are
/// stdout and stderr, and `progress` draws the live line on stdout.
pub fn run(
    args: &[String],
    get_env: &dyn Fn(&str) -> Option<String>,
    progress: &Progress,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let in_place = args.iter().any(|arg| arg == "--in-place");
    let positional: Vec<&String> = args.iter().filter(|arg| *arg != "--in-place").collect();
    let (Some(library_dir), Some(username), []) = (
        positional.first(),
        positional.get(1),
        positional.get(2..).unwrap_or_default(),
    ) else {
        let _ = writeln!(err, "{USAGE}");
        return 1;
    };

    // A big library spends minutes hashing with nothing on screen, so both are on by default
    // here: a live progress line, and `info` logging for the events behind it.
    let level = match get_env("SPM_LOG_LEVEL") {
        None => LogLevelSetting::Info,
        Some(raw) => match parse_log_level(Some(&raw)) {
            Some(level) => level,
            None => {
                let _ = writeln!(
                    err,
                    "SPM_LOG_LEVEL=\"{raw}\" is not a log level. Use one of: silent, error, warn, \
                     info, debug, trace"
                );
                return 1;
            }
        },
    };

    match import(library_dir, username, in_place, level, progress, out) {
        Ok(()) => 0,
        Err(error) => {
            // The expected refusals (an unknown user, a folder-name collision) read as one line.
            let _ = writeln!(err, "{}: {}", error.code, error.message);
            1
        }
    }
}

fn import(
    library_dir: &str,
    username: &str,
    in_place: bool,
    level: LogLevelSetting,
    progress: &Progress,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    // The progress line is written without a trailing newline, so a log record landing mid-draw
    // would graft itself onto the end of it. Clearing first keeps both readable.
    let for_sink = progress.clone();
    let log = Logger::with_sink(
        level,
        Arc::new(move |record| {
            for_sink.clear();
            console_sink(record);
        }),
    );
    let lib = Library::open(
        library_dir,
        OpenOptions {
            logger: Some(log),
            ..OpenOptions::default()
        },
    )?;
    run_import(&lib, username, in_place, progress, out)
}

fn run_import(
    lib: &Library,
    username: &str,
    in_place: bool,
    progress: &Progress,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    // A local operator running this command is above any in-app role, so the context used to look
    // the account up is a synthetic admin. The context handed to the import itself is the target
    // user's own: every project and tag it writes must be owned by them.
    let target = list_users(
        lib,
        &Ctx {
            user_id: String::new(),
            is_admin: true,
        },
    )?
    .into_iter()
    .find(|user| user.username.to_lowercase() == username.to_lowercase())
    .ok_or_else(|| {
        AppError::not_found(format!(
            "no such user: {username}. Create the account first."
        ))
    })?;

    let mut phase = String::new();
    let mut on_progress = |event: &ImportProgress| {
        let (name, text) = match event {
            ImportProgress::Indexing(indexing) => (
                "indexing",
                format!(
                    "indexing [{}/{}] {} -- {} seen, {} new",
                    indexing.project_index,
                    indexing.project_count,
                    indexing.dir_name,
                    plural(indexing.files_seen, "file"),
                    indexing.files_added
                ),
            ),
            ImportProgress::Sidecars {
                project_index,
                project_count,
                dir_name,
            } => (
                "sidecars",
                format!("applying sidecars [{project_index}/{project_count}] {dir_name}"),
            ),
            ImportProgress::Extracting {
                file_index,
                file_count,
                rel_path,
            } => (
                "extracting",
                format!("extracting [{file_index}/{file_count}] {rel_path}"),
            ),
        };
        // Force a redraw when the phase changes, so the switch is never swallowed by the
        // throttle and the last line of a phase always shows its final counts.
        let changed = phase != name;
        phase = name.to_owned();
        progress.update(&text, changed);
    };

    let result = import_curamanager_library(
        lib,
        &Ctx {
            user_id: target.id.clone(),
            is_admin: target.is_admin,
        },
        !in_place,
        Some(&mut on_progress),
    );
    progress.done();
    let result = result?;

    let lines = [
        format!("imported into \"{}\":", target.username),
        format!("  folders moved:    {}", result.moved),
        format!("  projects adopted: {}", result.rescan.adopted),
        format!("  files indexed:    {}", result.rescan.files_added),
        format!("  sidecars applied: {}", result.projects_updated),
        format!("  tags applied:     {}", result.tags_applied),
        format!("  marked missing:   {}", result.rescan.marked_missing),
        "Previews are queued; the server generates them on its next pass.".to_owned(),
    ];
    for line in lines {
        let _ = writeln!(out, "{line}");
    }
    Ok(())
}
