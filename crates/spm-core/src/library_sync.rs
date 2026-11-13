//! The server's half of keeping a desktop's local copy of a library in step with it.
//!
//! The desktop asks for a [`SyncManifest`] (every project of the user with every file's relative
//! path and content hash) and compares it with its own folder and with what both sides looked like
//! when they last agreed. What it then changes on the server goes through three calls of this
//! module, each of which **states what it expects to replace**:
//!
//! - [`put_file_at`] writes a file at a relative path inside a project (subfolders included), as
//!   long as what is there now is still the [`BaseVersion`] the desktop last saw. A file somebody
//!   changed on the server in the meantime is a `Conflict`, never overwritten: the desktop then keeps
//!   both.
//! - [`trash_file`] and [`trash_project`] move what the desktop deleted into the library's trash
//!   (`.spm/trash`) instead of deleting it: a sync is one bad folder operation away from deleting
//!   everything, and the trash is what makes that recoverable.
//!
//! Project creation needs nothing new: `POST /api/projects` already makes the folder.

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::clock::now_ms;
use crate::ctx::Ctx;
use crate::db::Library;
use crate::db::ids::new_id;
use crate::dto::ProjectState;
use crate::error::{AppError, Result};
use crate::fields;
use crate::files::classify::{CLASSIFIER_VERSION, classify_file};
use crate::files::hash::file_content_hash;
use crate::files::mtime_ms;
use crate::files::paths::{preview_path, project_dir, safe_join};
use crate::files::usecases::assert_within_quota;
use crate::projects::queries::require_project_row;
use crate::projects::rescan::RELATIVE_PATH_SEPARATOR;
use crate::users::repo::require_user_row;

/// Bumped when the manifest or the calls change in a way an older desktop would misread.
pub const SYNC_PROTOCOL_VERSION: u32 = 1;

/// The folder under `.spm` that deleted files and projects are moved into.
pub const TRASH_DIR: &str = "trash";

const CHUNK_BYTES: usize = 64 * 1024;

/// Every project of the user whose folder is there, with every file in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifest {
    pub version: u32,
    /// Whose library this is: a desktop folder synced for one account must never take in another's.
    pub user_id: String,
    pub projects: Vec<SyncProject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProject {
    pub id: String,
    pub name: String,
    /// The folder's name on the server: what a desktop names its own copy of the folder when it
    /// first brings the project down.
    pub dir_name: String,
    pub files: Vec<SyncFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    pub id: String,
    /// Relative to the project folder, `/`-separated.
    pub rel_path: String,
    pub size_bytes: i64,
    /// Lower-case hex SHA-256 of the content.
    pub sha256: String,
}

/// What a write or a delete expects to find, so a change made on the server since the desktop last
/// looked is never silently replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseVersion {
    /// Nothing may be there yet.
    Absent,
    /// The content must still hash to this.
    Hash([u8; 32]),
    /// Whatever is there (a desktop that already decided it wins).
    Any,
}

impl BaseVersion {
    /// Parses the header form: `absent`, `*`, or 64 hex digits.
    pub fn parse(value: &str) -> Option<BaseVersion> {
        match value.trim() {
            "absent" => Some(BaseVersion::Absent),
            "*" => Some(BaseVersion::Any),
            hex => parse_hex(hex).map(BaseVersion::Hash),
        }
    }

    fn admits(&self, current: Option<&[u8; 32]>) -> bool {
        match (self, current) {
            (BaseVersion::Any, _) => true,
            (BaseVersion::Absent, current) => current.is_none(),
            (BaseVersion::Hash(expected), Some(current)) => expected == current,
            (BaseVersion::Hash(_), None) => false,
        }
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn parse_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn changed_meanwhile(rel_path: &str) -> AppError {
    AppError::conflict(format!(
        "\"{rel_path}\" was changed on the server since it was last synced"
    ))
}

/// Splits and checks a relative path: every segment a legal file name, none a work-in-progress
/// name the library would never index.
pub fn validate_rel_path(rel_path: &str) -> Result<Vec<&str>> {
    let segments: Vec<&str> = rel_path.split(RELATIVE_PATH_SEPARATOR).collect();
    for segment in &segments {
        if let Err(message) = crate::validate::file_name(segment) {
            return Err(AppError::validation(format!("{rel_path}: {message}")));
        }
        if crate::watch::is_transient_name(segment) {
            return Err(AppError::validation(format!(
                "{rel_path}: a temporary file is not synced"
            )));
        }
    }
    Ok(segments)
}

/// The manifest of the calling user's library.
pub fn sync_manifest(lib: &Library, ctx: &Ctx) -> Result<SyncManifest> {
    let conn = lib.db();
    let mut projects: Vec<SyncProject> = Vec::new();
    {
        let mut statement = conn.prepare(
            "SELECT id, name, dir_name FROM projects
             WHERE owner_id = ? AND state = 'ok' ORDER BY dir_name",
        )?;
        let rows = statement.query_map(params![ctx.user_id], |row| {
            Ok(SyncProject {
                id: row.get(0)?,
                name: row.get(1)?,
                dir_name: row.get(2)?,
                files: Vec::new(),
            })
        })?;
        for row in rows {
            projects.push(row?);
        }
    }
    let mut statement = conn.prepare(
        "SELECT id, rel_path, size_bytes, content_hash FROM files
         WHERE project_id = ? ORDER BY rel_path",
    )?;
    for project in &mut projects {
        let rows = statement.query_map(params![project.id], |row| {
            let hash: Option<Vec<u8>> = row.get(3)?;
            Ok(SyncFile {
                id: row.get(0)?,
                rel_path: row.get(1)?,
                size_bytes: row.get(2)?,
                sha256: hash.map(|hash| to_hex(&hash)).unwrap_or_default(),
            })
        })?;
        for row in rows {
            let file = row?;
            // A row without a hash has not been indexed to the end yet: the next manifest has it.
            if !file.sha256.is_empty() {
                project.files.push(file);
            }
        }
    }
    Ok(SyncManifest {
        version: SYNC_PROTOCOL_VERSION,
        user_id: ctx.user_id.clone(),
        projects,
    })
}

fn current_hash(path: &Path) -> Result<Option<[u8; 32]>> {
    match file_content_hash(path) {
        Ok(hash) => Ok(Some(hash)),
        Err(error) if !path.exists() => {
            let _ = error;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// Writes `body` to `rel_path` inside the project, creating subfolders as needed and replacing what
/// is there if `base` admits it. Indexed at once, so the next manifest already has it.
///
/// The bytes go to a hidden temporary beside the target and are renamed over it, so a reader (or
/// the watcher) never sees half a file.
pub fn put_file_at<R: Read>(
    lib: &Library,
    ctx: &Ctx,
    project_id: &str,
    rel_path: &str,
    base: BaseVersion,
    size_bytes: i64,
    mut body: R,
) -> Result<SyncFile> {
    let segments = validate_rel_path(rel_path)?;
    if size_bytes < 0 {
        return Err(AppError::validation("the declared upload size is negative"));
    }
    let (project, library_dir, existing) = {
        let conn = lib.db();
        let project = require_project_row(&conn, ctx, project_id)?;
        let user = require_user_row(&conn, &ctx.user_id)?;
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT id, size_bytes FROM files WHERE project_id = ? AND rel_path = ?",
                params![project_id, rel_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        (project, user.library_dir, existing)
    };
    if project.state != ProjectState::Ok {
        return Err(AppError::conflict("project folder is missing on disk"));
    }
    let dir = project_dir(lib, &library_dir, &project.dir_name)?;
    let abs_path = safe_join(&dir, &segments)?;
    if abs_path.is_dir() {
        return Err(AppError::conflict(format!("\"{rel_path}\" is a folder")));
    }
    if !base.admits(current_hash(&abs_path)?.as_ref()) {
        return Err(changed_meanwhile(rel_path));
    }
    let replaced = existing.as_ref().map_or(0, |(_, size)| *size);
    assert_within_quota(lib, ctx, (size_bytes - replaced).max(0))?;

    let parent = abs_path
        .parent()
        .ok_or_else(|| AppError::internal("the file has no folder"))?;
    fs::create_dir_all(parent)?;
    let name = segments.last().copied().unwrap_or_default();
    let partial = parent.join(format!(".{name}.{}.spm-sync", new_id()));
    let hash = match write_new(&partial, &mut body, size_bytes) {
        Ok(hash) => hash,
        Err(error) => {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
    };
    if let Err(error) = fs::rename(&partial, &abs_path) {
        let _ = fs::remove_file(&partial);
        return Err(error.into());
    }

    let metadata = fs::metadata(&abs_path)?;
    let size = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
    let classification = classify_file(&abs_path);
    let now = now_ms();
    let mut conn = lib.db();
    let tx = conn.transaction()?;
    // Looked up again inside the transaction: a rescan may have indexed the file meanwhile.
    let known: Option<String> = tx
        .query_row(
            "SELECT id FROM files WHERE project_id = ? AND rel_path = ?",
            params![project_id, rel_path],
            |row| row.get(0),
        )
        .optional()?;
    let id = match known {
        Some(id) => {
            tx.execute(
                "UPDATE files SET kind = ?, slicer = ?, size_bytes = ?, mtime_ms = ?,
                                  content_hash = ?, classified_by = ?
                 WHERE id = ?",
                params![
                    classification.kind.as_str(),
                    classification.slicer.map(|slicer| slicer.as_str()),
                    size,
                    mtime_ms(&metadata),
                    hash.as_slice(),
                    CLASSIFIER_VERSION,
                    id
                ],
            )?;
            let source: Option<Option<Vec<u8>>> = tx
                .query_row(
                    "SELECT source_hash FROM previews WHERE file_id = ?",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            match source {
                Some(Some(source)) if source == hash.as_slice() => {}
                Some(_) => {
                    tx.execute(
                        "UPDATE previews SET state = 'pending', source = NULL, png_path = NULL,
                                width = NULL, height = NULL, error = NULL, attempts = 0,
                                claimed_at = NULL, updated_at = ?
                         WHERE file_id = ?",
                        params![now, id],
                    )?;
                }
                None => {
                    tx.execute(
                        "INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', ?)",
                        params![id, now],
                    )?;
                }
            }
            id
        }
        None => {
            let id = new_id();
            tx.execute(
                "INSERT INTO files (id, project_id, rel_path, kind, slicer, size_bytes, mtime_ms,
                                    content_hash, classified_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    project_id,
                    rel_path,
                    classification.kind.as_str(),
                    classification.slicer.map(|slicer| slicer.as_str()),
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
            id
        }
    };
    tx.execute(
        "UPDATE projects SET updated_at = ? WHERE id = ?",
        params![now, project_id],
    )?;
    tx.commit()?;
    drop(conn);

    lib.log().info(
        "file synced up",
        fields![
            "fileId" => &id,
            "projectId" => project_id,
            "relPath" => rel_path,
            "sizeBytes" => size,
            "userId" => &ctx.user_id,
        ],
    );
    Ok(SyncFile {
        id,
        rel_path: rel_path.to_owned(),
        size_bytes: size,
        sha256: to_hex(&hash),
    })
}

fn write_new(path: &Path, body: &mut impl Read, declared: i64) -> Result<[u8; 32]> {
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut written: i64 = 0;
    loop {
        let read = match body.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => {
                let mut failure =
                    AppError::validation("the upload body could not be read to the end");
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
    if written != declared {
        return Err(AppError::validation(
            "upload body is shorter than its declared size",
        ));
    }
    out.flush()?;
    Ok(hasher.finalize().into())
}

/// A fresh folder in the library's trash for one deleted thing.
fn trash_slot(lib: &Library, id: &str) -> Result<PathBuf> {
    let slot = lib
        .spm_dir()
        .join(TRASH_DIR)
        .join(format!("{}-{id}", now_ms()));
    fs::create_dir_all(&slot)?;
    Ok(slot)
}

/// Moves a file into the trash and forgets it, if what is there is still `base`.
pub fn trash_file(lib: &Library, ctx: &Ctx, file_id: &str, base: BaseVersion) -> Result<()> {
    let (project_id, rel_path, dir_name, library_dir) = {
        let conn = lib.db();
        let row: (String, String, String) = conn
            .query_row(
                "SELECT f.project_id, f.rel_path, p.dir_name FROM files f
                 JOIN projects p ON p.id = f.project_id
                 WHERE f.id = ? AND p.owner_id = ?",
                params![file_id, ctx.user_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found("file not found"))?;
        let user = require_user_row(&conn, &ctx.user_id)?;
        (row.0, row.1, row.2, user.library_dir)
    };
    let dir = project_dir(lib, &library_dir, &dir_name)?;
    let segments: Vec<&str> = rel_path.split(RELATIVE_PATH_SEPARATOR).collect();
    let abs_path = safe_join(&dir, &segments)?;
    let current = current_hash(&abs_path)?;
    if !base.admits(current.as_ref()) {
        return Err(changed_meanwhile(&rel_path));
    }
    if current.is_some() {
        let slot = trash_slot(lib, file_id)?;
        fs::rename(
            &abs_path,
            slot.join(segments.last().copied().unwrap_or("file")),
        )?;
    }
    match fs::remove_file(preview_path(lib, file_id)) {
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    {
        let conn = lib.db();
        conn.execute("DELETE FROM files WHERE id = ?", params![file_id])?;
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?",
            params![now_ms(), project_id],
        )?;
    }
    lib.log().info(
        "file trashed by sync",
        fields![
            "fileId" => file_id,
            "projectId" => &project_id,
            "relPath" => &rel_path,
            "userId" => &ctx.user_id,
        ],
    );
    Ok(())
}

/// Moves a project's folder into the trash and deletes its row.
pub fn trash_project(lib: &Library, ctx: &Ctx, project_id: &str) -> Result<()> {
    let (row, library_dir, file_ids) = {
        let conn = lib.db();
        let row = require_project_row(&conn, ctx, project_id)?;
        let user = require_user_row(&conn, &ctx.user_id)?;
        let mut statement = conn.prepare("SELECT id FROM files WHERE project_id = ?")?;
        let ids = statement
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        (row, user.library_dir, ids)
    };
    let dir = project_dir(lib, &library_dir, &row.dir_name)?;
    if dir.exists() {
        let slot = trash_slot(lib, project_id)?;
        fs::rename(&dir, slot.join(&row.dir_name))?;
    }
    for id in &file_ids {
        let _ = fs::remove_file(preview_path(lib, id));
    }
    lib.db().execute(
        "DELETE FROM projects WHERE id = ? AND owner_id = ?",
        params![project_id, ctx.user_id],
    )?;
    lib.log().info(
        "project trashed by sync",
        fields![
            "projectId" => project_id,
            "dirName" => &row.dir_name,
            "userId" => &ctx.user_id,
        ],
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_and_base_versions_parse() {
        let hash = [0xabu8; 32];
        assert_eq!(parse_hex(&to_hex(&hash)), Some(hash));
        assert_eq!(parse_hex("zz"), None);
        assert_eq!(BaseVersion::parse("absent"), Some(BaseVersion::Absent));
        assert_eq!(BaseVersion::parse("*"), Some(BaseVersion::Any));
        assert_eq!(
            BaseVersion::parse(&to_hex(&hash)),
            Some(BaseVersion::Hash(hash))
        );
        assert_eq!(BaseVersion::parse("nope"), None);
    }

    #[test]
    fn a_base_admits_only_what_it_names() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        assert!(BaseVersion::Absent.admits(None));
        assert!(!BaseVersion::Absent.admits(Some(&a)));
        assert!(BaseVersion::Hash(a).admits(Some(&a)));
        assert!(!BaseVersion::Hash(a).admits(Some(&b)));
        assert!(!BaseVersion::Hash(a).admits(None));
        assert!(BaseVersion::Any.admits(None));
    }

    #[test]
    fn relative_paths_refuse_traversal_and_temporaries() {
        assert!(validate_rel_path("parts/arm.stl").is_ok());
        assert!(validate_rel_path("../x.stl").is_err());
        assert!(validate_rel_path("a//b.stl").is_err());
        assert!(validate_rel_path("x.stl.part").is_err());
        assert!(validate_rel_path(".hidden").is_err());
        assert!(validate_rel_path("a\\b.stl").is_err());
    }
}
