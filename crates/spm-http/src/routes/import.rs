use std::fs;
use std::io::Read;
use std::path::{Path as FsPath, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::post;
use spm_core::{AppError, AppErrorCode, Ctx, Library, import_curamanager_zip, new_id};

use super::files::{body_reader, drain, require_content_length};
use super::limited;
use crate::error::{ApiError, blocking};
use crate::extract::{Session, json};
use crate::rate_limit::RateLimitRule;
use crate::state::AppState;

/// Ten gigabytes. A CuraManager library of a few hundred projects is comfortably under this; the
/// cap exists so a wrong file or a hostile client cannot fill the disk before the quota check,
/// which needs the archive's central directory and so cannot run until the whole upload has landed.
pub const MAX_ARCHIVE_BYTES: u64 = 10 * 1024 * 1024 * 1024;

pub(super) fn routes(state: &AppState) -> Router<AppState> {
    Router::new().route(
        "/api/import/curamanager",
        // One import at a time per client is already more than anyone needs, and each one can
        // occupy the disk for minutes.
        limited(
            post(import_curamanager),
            state,
            "POST /api/import/curamanager",
            RateLimitRule {
                limit: 5,
                window_ms: 60_000,
            },
        ),
    )
}

/// Streams the upload to a temporary file inside the library's own `.spm` directory.
///
/// Not the OS temp directory: a library on a large data disk is routinely paired with a small
/// system disk, and a multi-gigabyte archive staged on the wrong one would fail for reasons that
/// have nothing to do with the user's quota. `.spm` is also excluded from every rescan, so a
/// staging file can never be mistaken for a project.
///
/// Staged rather than held in memory because the zip central directory sits at the *end* of the
/// archive: nothing can be planned, validated or extracted until the last byte has arrived.
fn stage_archive(lib: &Library, reader: &mut impl Read) -> Result<PathBuf, AppError> {
    let dir = lib.dir().join(".spm").join("uploads");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.zip", new_id()));
    let copied = (|| -> std::io::Result<u64> {
        let mut file = fs::File::create(&path)?;
        std::io::copy(reader, &mut file)
    })();
    match copied {
        Ok(_) => Ok(path),
        Err(error) => {
            let _ = fs::remove_file(&path);
            let mut failure = AppError::new(
                AppErrorCode::Validation,
                "the upload could not be read to the end",
            );
            failure.cause = Some(error.to_string());
            Err(failure)
        }
    }
}

fn remove_staged(path: &FsPath) {
    // Always: the archive has either been extracted or rejected, and either way keeping a
    // multi-gigabyte copy inside the user's own library would silently eat their quota.
    let _ = fs::remove_file(path);
}

fn import(
    lib: &Library,
    ctx: &Ctx,
    reader: &mut impl Read,
) -> Result<spm_core::dto::ZipImportResultDto, AppError> {
    let staged = stage_archive(lib, reader)?;
    let result = import_curamanager_zip(lib, ctx, &staged, None);
    remove_staged(&staged);
    result
}

/// The refusals that need only the headers. They are ready before a byte of the body is read.
fn check_declared_size(headers: &HeaderMap) -> Result<(), AppError> {
    let size = require_content_length(headers, false).map_err(|error| error.0)?;
    if size > MAX_ARCHIVE_BYTES {
        return Err(AppError::new(
            AppErrorCode::QuotaExceeded,
            "that archive is larger than the 10 GiB upload limit",
        ));
    }
    Ok(())
}

async fn import_curamanager(
    State(state): State<AppState>,
    Session(ctx): Session,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let declared = check_declared_size(&headers);
    let lib = state.lib().clone();
    let result = blocking(move || {
        let mut reader = body_reader(body);
        // A refusal is ready while the client is still sending. Answering and closing with the
        // body unread makes the client's operating system reset the connection and the answer
        // never arrives, so the rest of the body is taken off the socket first (see `drain`).
        let result = declared.and_then(|()| import(&lib, &ctx, &mut reader));
        if result.is_err() {
            drain(&mut reader);
        }
        result
    })
    .await?;
    Ok(json(&result))
}
