//! The file use cases: upload (streaming, quota-checked), rename, delete and resolving a file or
//! its preview to a path on disk.
//!
//! Ownership is part of every lookup: a file joins its project and the project's owner, so a file
//! of another user is `NotFound`. Nothing here holds the database lock across file I/O.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::classify::{CLASSIFIER_VERSION, classify_file};
use super::mtime_ms;
use super::paths::{preview_path, project_dir, safe_join};
use crate::clock::now_ms;
use crate::ctx::Ctx;
use crate::db::Library;
use crate::db::ids::new_id;
use crate::dto::{CoreFileDto, FileKind, PreviewState, ProjectState, SlicerId};
use crate::error::{AppError, AppErrorCode, QuotaExceededDetails, Result};
use crate::fields;
use crate::projects::queries::{bad_value, require_project_row};
use crate::projects::rescan::RELATIVE_PATH_SEPARATOR;
use crate::users::repo::require_user_row;
use crate::users::usage::disk_usage_bytes_in;

/// How much of an upload body is read, written and hashed at a time.
const UPLOAD_CHUNK_BYTES: usize = 64 * 1024;

/// The MIME type a file is served as, by its extension (case-insensitively).
pub fn content_type_for(name: &str) -> &'static str {
    let extension = name.to_lowercase();
    match extension.rsplit('.').next().unwrap_or("") {
        "stl" => "model/stl",
        "obj" => "model/obj",
        "3mf" => "model/3mf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "txt" | "gcode" => "text/plain; charset=utf-8",
        "json" => "application/json",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// A `files` row joined to its preview state and its project's folder.
struct OwnedFile {
    id: String,
    project_id: String,
    rel_path: String,
    kind: FileKind,
    slicer: Option<SlicerId>,
    size_bytes: i64,
    preview_state: Option<PreviewState>,
    dir_name: String,
}

impl OwnedFile {
    fn dto(&self, rel_path: &str) -> CoreFileDto {
        CoreFileDto {
            id: self.id.clone(),
            name: rel_path.to_owned(),
            kind: self.kind,
            slicer: self.slicer,
            size_bytes: self.size_bytes,
            preview_state: self.preview_state.unwrap_or(PreviewState::Pending),
        }
    }
}

/// Joined against projects so ownership is part of the lookup, never a later check.
fn require_owned_file(conn: &Connection, ctx: &Ctx, id: &str) -> Result<OwnedFile> {
    conn.query_row(
        "SELECT f.id, f.project_id, f.rel_path, f.kind, f.slicer, f.size_bytes,
                pv.state AS preview_state, p.dir_name AS dir_name
         FROM files f
         JOIN projects p ON p.id = f.project_id
         LEFT JOIN previews pv ON pv.file_id = f.id
         WHERE f.id = ? AND p.owner_id = ?",
        params![id, ctx.user_id],
        |row| {
            let kind: String = row.get("kind")?;
            let slicer: Option<String> = row.get("slicer")?;
            let preview_state: Option<String> = row.get("preview_state")?;
            Ok(OwnedFile {
                id: row.get("id")?,
                project_id: row.get("project_id")?,
                rel_path: row.get("rel_path")?,
                kind: FileKind::parse(&kind).ok_or_else(|| bad_value("file kind", &kind))?,
                slicer: match slicer {
                    Some(value) => {
                        Some(SlicerId::parse(&value).ok_or_else(|| bad_value("slicer", &value))?)
                    }
                    None => None,
                },
                size_bytes: row.get("size_bytes")?,
                preview_state: match preview_state {
                    Some(value) => Some(
                        PreviewState::parse(&value)
                            .ok_or_else(|| bad_value("preview state", &value))?,
                    ),
                    None => None,
                },
                dir_name: row.get("dir_name")?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("file not found"))
}

/// Fails with `QuotaExceeded`, carrying the numbers the UI needs to render a real message (5.6),
/// when `incoming_bytes` more would put the user over their quota. No quota means unlimited.
pub fn assert_within_quota(lib: &Library, ctx: &Ctx, incoming_bytes: i64) -> Result<()> {
    let conn = lib.db();
    let user = require_user_row(&conn, &ctx.user_id)?;
    let Some(quota_bytes) = user.quota_bytes else {
        return Ok(());
    };
    let usage_bytes = disk_usage_bytes_in(&conn, &ctx.user_id)?;
    if usage_bytes.saturating_add(incoming_bytes) <= quota_bytes {
        return Ok(());
    }
    Err(AppError::quota_exceeded(QuotaExceededDetails {
        usage_bytes,
        quota_bytes,
        incoming_bytes,
    }))
}

fn already_exists(name: &str) -> AppError {
    AppError::conflict(format!("\"{name}\" already exists"))
}

/// A file name is one path segment. `safe_join` accepts nested paths (rescan produces them), so an
/// upload or rename target is held to the narrower rule here, before anything is opened.
fn assert_single_segment(name: &str) -> Result<()> {
    if name.contains(['/', '\\']) {
        return Err(AppError::forbidden(format!("illegal path segment: {name}")));
    }
    Ok(())
}

/// Writes `body` to a new file called `name` in the project, indexes it and queues its preview.
///
/// The body is read, written and hashed one bounded chunk at a time, so memory use does not depend
/// on its size: an HTTP layer passes the request body's reader straight in. `size_bytes` is what
/// the caller declared (the quota is checked against it before a byte is written); a body that
/// turns out longer is rejected as `Validation` as soon as it is seen to be, and what was written
/// is removed again. So is everything written for a body that cannot be read to the end.
///
/// Racing uploads of one name are decided by an exclusive create: exactly one wins, the others get
/// `Conflict`.
pub fn upload_file<R: Read>(
    lib: &Library,
    ctx: &Ctx,
    project_id: &str,
    name: &str,
    size_bytes: i64,
    mut body: R,
) -> Result<CoreFileDto> {
    let (project, library_dir, clash) = {
        let conn = lib.db();
        let project = require_project_row(&conn, ctx, project_id)?;
        let user = require_user_row(&conn, &ctx.user_id)?;
        let clash = conn
            .query_row(
                "SELECT 1 FROM files WHERE project_id = ? AND rel_path = ?",
                params![project_id, name],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        (project, user.library_dir, clash)
    };
    if project.state != ProjectState::Ok {
        return Err(AppError::conflict("project folder is missing on disk"));
    }
    if size_bytes < 0 {
        return Err(AppError::validation("the declared upload size is negative"));
    }
    let dir = project_dir(lib, &library_dir, &project.dir_name)?;
    // `safe_join` rejects traversal and absolute names before anything is opened.
    assert_single_segment(name)?;
    let abs_path = safe_join(&dir, &[name])?;

    if clash || abs_path.exists() {
        return Err(already_exists(name));
    }

    assert_within_quota(lib, ctx, size_bytes)?;

    // Exclusive create: the checks above are not atomic with this, so a name that wins the race
    // still surfaces as the same Conflict rather than a raw "already exists".
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&abs_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err(already_exists(name));
        }
        Err(error) => return Err(error.into()),
    };

    let hash = match write_body(&mut body, &mut file, size_bytes) {
        Ok(hash) => hash,
        Err(error) => {
            drop(file);
            let _ = fs::remove_file(&abs_path);
            return Err(error);
        }
    };
    drop(file);

    let indexed = (|| -> Result<(String, i64, FileKind, Option<SlicerId>)> {
        let id = new_id();
        let metadata = fs::metadata(&abs_path)?;
        let size = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
        let classification = classify_file(&abs_path);
        let now = now_ms();
        let mut conn = lib.db();
        let tx = conn.transaction()?;
        tx.execute(
            // `classified_by` because this row's `kind` was just decided by the running
            // classifier, and the column's `DEFAULT 0` means "predates the mechanism". Left to the
            // default, every uploaded file would be re-asked a question already answered on the
            // next rescan: once per file, and a zip read each for an uploaded `.3mf`.
            "INSERT INTO files (id, project_id, rel_path, kind, slicer, size_bytes, mtime_ms, content_hash, classified_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                project_id,
                name,
                classification.kind.as_str(),
                classification.slicer.map(SlicerId::as_str),
                size,
                mtime_ms(&metadata),
                hash.as_slice(),
                CLASSIFIER_VERSION
            ],
        )?;
        tx.execute(
            "INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', ?)",
            params![id, now],
        )?;
        tx.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?",
            params![now, project_id],
        )?;
        tx.commit()?;
        Ok((id, size, classification.kind, classification.slicer))
    })();
    let (id, size, kind, slicer) = match indexed {
        Ok(indexed) => indexed,
        Err(error) => {
            // No row means no owner for these bytes: leave nothing behind.
            let _ = fs::remove_file(&abs_path);
            return Err(error);
        }
    };

    lib.log().info(
        "file uploaded",
        fields![
            "fileId" => &id,
            "projectId" => project_id,
            "name" => name,
            "sizeBytes" => size,
            "kind" => kind.as_str(),
            "userId" => &ctx.user_id,
        ],
    );
    Ok(CoreFileDto {
        id,
        name: name.to_owned(),
        kind,
        slicer,
        size_bytes: size,
        preview_state: PreviewState::Pending,
    })
}

/// Copies `body` into `out`, hashing as it goes, and refuses a body longer than `declared`.
fn write_body(body: &mut impl Read, out: &mut impl Write, declared: i64) -> Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; UPLOAD_CHUNK_BYTES];
    let mut written: i64 = 0;
    loop {
        let read = match body.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => {
                let mut failure = AppError::new(
                    AppErrorCode::Validation,
                    "the upload body could not be read to the end",
                );
                failure.cause = Some(error.to_string());
                return Err(failure);
            }
        };
        written = written.saturating_add(read as i64);
        if written > declared {
            return Err(AppError::validation(
                "upload body is larger than its declared size",
            ));
        }
        hasher.update(&buffer[..read]);
        out.write_all(&buffer[..read])?;
    }
    out.flush()?;
    Ok(hasher.finalize().into())
}

/// Renames a file within its folder. For a file in a subfolder only the last path segment changes.
pub fn rename_file(lib: &Library, ctx: &Ctx, id: &str, name: &str) -> Result<CoreFileDto> {
    let (row, library_dir) = {
        let conn = lib.db();
        let row = require_owned_file(&conn, ctx, id)?;
        let user = require_user_row(&conn, &ctx.user_id)?;
        (row, user.library_dir)
    };
    assert_single_segment(name)?;
    let dir = project_dir(lib, &library_dir, &row.dir_name)?;

    let mut segments: Vec<&str> = row.rel_path.split(RELATIVE_PATH_SEPARATOR).collect();
    let current_name = segments.pop().unwrap_or_default();
    let mut from_parts = segments.clone();
    from_parts.push(current_name);
    let mut to_parts = segments.clone();
    to_parts.push(name);
    let from = safe_join(&dir, &from_parts)?;
    let to = safe_join(&dir, &to_parts)?;
    let new_rel_path = to_parts.join(RELATIVE_PATH_SEPARATOR);

    let clash = lib
        .db()
        .query_row(
            "SELECT 1 FROM files WHERE project_id = ? AND rel_path = ? AND id <> ?",
            params![row.project_id, new_rel_path, id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if clash || to.exists() {
        return Err(already_exists(name));
    }

    fs::rename(&from, &to)?;
    {
        let conn = lib.db();
        conn.execute(
            "UPDATE files SET rel_path = ? WHERE id = ?",
            params![new_rel_path, id],
        )?;
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?",
            params![now_ms(), row.project_id],
        )?;
    }

    lib.log().info(
        "file renamed",
        fields![
            "fileId" => id,
            "projectId" => &row.project_id,
            "from" => &row.rel_path,
            "to" => &new_rel_path,
            "userId" => &ctx.user_id,
        ],
    );
    Ok(row.dto(&new_rel_path))
}

fn remove_if_present(path: &std::path::Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Deletes a file's bytes, its preview PNG and its row.
pub fn delete_file(lib: &Library, ctx: &Ctx, id: &str) -> Result<()> {
    let row = {
        let conn = lib.db();
        require_owned_file(&conn, ctx, id)?
    };
    let resolved = resolve_file_path(lib, ctx, id)?;
    remove_if_present(&resolved.abs_path)?;
    remove_if_present(&preview_path(lib, id))?;
    {
        let conn = lib.db();
        conn.execute("DELETE FROM files WHERE id = ?", params![id])?;
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?",
            params![now_ms(), row.project_id],
        )?;
    }
    lib.log().info(
        "file deleted",
        fields![
            "fileId" => id,
            "projectId" => &row.project_id,
            "name" => &row.rel_path,
            "userId" => &ctx.user_id,
        ],
    );
    Ok(())
}

/// Where a file's bytes are, and what to serve them as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFile {
    pub abs_path: PathBuf,
    /// The last path segment.
    pub name: String,
    pub size_bytes: i64,
    pub content_type: &'static str,
}

pub fn resolve_file_path(lib: &Library, ctx: &Ctx, id: &str) -> Result<ResolvedFile> {
    let (row, library_dir) = {
        let conn = lib.db();
        let row = require_owned_file(&conn, ctx, id)?;
        let user = require_user_row(&conn, &ctx.user_id)?;
        (row, user.library_dir)
    };
    let dir = project_dir(lib, &library_dir, &row.dir_name)?;
    let segments: Vec<&str> = row.rel_path.split(RELATIVE_PATH_SEPARATOR).collect();
    let name = segments.last().copied().unwrap_or_default().to_owned();
    Ok(ResolvedFile {
        abs_path: safe_join(&dir, &segments)?,
        content_type: content_type_for(&name),
        name,
        size_bytes: row.size_bytes,
    })
}

/// The PNG for a `ready` preview, or `None` when there is none (not ready, or its file is gone).
///
/// **`safe_join`, not a plain join (ruling C-13).** `previews.png_path` is written by the preview
/// queue from an id it generated itself, so in a library this code has always owned every value is
/// `.spm/previews/<id>.png`. A row that says otherwise (`../outside.png`, an absolute path) must
/// not make a caller stream bytes from outside the library: it is `Forbidden`. That claim, that
/// nothing but core writes the column, is about today's writers rather than a property of the
/// function, and the desktop shell is the first place those rows are written on an end user's own
/// machine.
pub fn resolve_preview_path(lib: &Library, ctx: &Ctx, file_id: &str) -> Result<Option<PathBuf>> {
    let png_path: Option<String> = {
        let conn = lib.db();
        require_owned_file(&conn, ctx, file_id)?;
        conn.query_row(
            "SELECT png_path FROM previews WHERE file_id = ? AND state = 'ready'",
            params![file_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten()
    };
    let Some(png_path) = png_path.filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let parts: Vec<&str> = png_path.split(RELATIVE_PATH_SEPARATOR).collect();
    let abs_path = safe_join(lib.dir(), &parts)?;
    Ok(abs_path.exists().then_some(abs_path))
}
