//! Reconciling the database with what is on disk (parent spec 3.5).
//!
//! The disk is the truth for *which files exist*; the database is the truth for everything a user
//! typed (names, notes, tags). A rescan therefore adopts folders it has no row for, marks projects
//! whose folder vanished as `missing` (never deleting metadata: the drive may just be unmounted),
//! and indexes, re-indexes and forgets files. A folder renamed in Explorer is neither: when a
//! project's folder is gone and exactly one new folder holds exactly its files (same paths, sizes
//! and modification times), the project moves to the new folder with its name, notes and tags.
//!
//! Hashing a real library takes minutes, so the database lock is held for one short statement
//! group at a time and never across a read of file contents or a progress callback.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::clock::now_ms;
use crate::ctx::Ctx;
use crate::db::Library;
use crate::db::ids::new_id;
use crate::dto::RescanResultDto;
use crate::error::Result;
use crate::fields;
use crate::files::classify::{CLASSIFIER_VERSION, Classification, classify_file};
use crate::files::hash::file_content_hash;
use crate::files::mtime_ms;
use crate::files::paths::user_root;
use crate::users::repo::require_user_row;

/// Relative paths of files are stored with forward slashes on every platform.
pub const RELATIVE_PATH_SEPARATOR: &str = "/";

/// Emitted once on entry to each project and once per file examined.
///
/// A first import of a real library hashes every byte of every model, which takes minutes with
/// nothing to show for it, so the caller needs a way to render a live count. Core reports every
/// file and does no throttling of its own: how often to actually redraw is a presentation
/// decision, and only the caller knows whether it is talking to a terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescanProgress {
    /// 1-based, over the projects this rescan will visit.
    pub project_index: usize,
    pub project_count: usize,
    pub dir_name: String,
    /// Cumulative across the whole rescan, not per project.
    pub files_seen: i64,
    pub files_added: i64,
}

/// A callback for [`rescan`]'s progress. Called on the thread running the rescan, with no database
/// lock held, so it may call back into the library.
pub type OnRescanProgress<'a> = Option<&'a mut dyn FnMut(&RescanProgress)>;

struct DiskFile {
    rel_path: String,
    abs_path: PathBuf,
    size: i64,
    mtime_ms: i64,
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Depth-first walk that skips dot-entries at every level (spec 3.1, 3.5).
fn walk_files(dir: &Path, prefix: &str, found: &mut Vec<DiskFile>) -> Result<()> {
    let mut entries = fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        // Somebody's save in progress (`benchy.3mf.tmp`, a partial download): not a file of the
        // project until it has been renamed into place, which the next rescan sees.
        let file_type = entry.file_type()?;
        if file_type.is_file() && crate::watch::is_transient_name(&name) {
            continue;
        }
        let abs_path = entry.path();
        let rel_path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}{RELATIVE_PATH_SEPARATOR}{name}")
        };
        // `file_type` does not follow symlinks: a link is neither a file nor a folder here.
        if file_type.is_dir() {
            walk_files(&abs_path, &rel_path, found)?;
        } else if file_type.is_file() {
            let metadata = fs::metadata(&abs_path)?;
            found.push(DiskFile {
                rel_path,
                abs_path,
                size: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
                mtime_ms: mtime_ms(&metadata),
            });
        }
    }
    Ok(())
}

fn list_project_folders(root: &Path) -> Result<BTreeSet<String>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        // The library root itself is absent (unmounted drive, deleted folder): report nothing
        // rather than deleting. Anything else (permissions, a transient I/O error) means the
        // drive IS there and something else is wrong; hiding that behind "missing" would tell
        // the user their whole library vanished when the real problem is permissions.
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Ok(BTreeSet::new());
        }
        Err(error) => return Err(error.into()),
    };
    let mut folders = BTreeSet::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && !is_hidden(&name) {
            folders.insert(name);
        }
    }
    Ok(folders)
}

struct ProjectRef {
    id: String,
    dir_name: String,
    state: String,
}

struct KnownFile {
    id: String,
    size_bytes: i64,
    mtime_ms: i64,
    kind: String,
    classified_by: i64,
}

fn insert_preview(tx: &Transaction<'_>, file_id: &str, now: i64) -> Result<()> {
    tx.execute(
        "INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', ?)",
        params![file_id, now],
    )?;
    Ok(())
}

fn reset_preview(tx: &Transaction<'_>, file_id: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE previews SET state = 'pending', source = NULL, png_path = NULL, width = NULL,
                             height = NULL, error = NULL, attempts = 0, claimed_at = NULL,
                             updated_at = ?
         WHERE file_id = ?",
        params![now, file_id],
    )?;
    Ok(())
}

fn preview_exists(tx: &Transaction<'_>, file_id: &str) -> Result<bool> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM previews WHERE file_id = ?",
            params![file_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn slicer_text(classification: &Classification) -> Option<&'static str> {
    classification.slicer.map(|slicer| slicer.as_str())
}

/// What identifies a folder's content without reading it: every file's path, size and modification
/// time. A rename moves none of the three.
type FolderSignature = Vec<(String, i64, i64)>;

/// The pairs (old folder name, new folder name) of the projects whose folder was renamed: a project
/// whose folder is gone, and a folder no project has whose files are exactly the project's files.
/// Only a pairing that is unambiguous both ways counts; anything else stays "missing" and
/// "adopted", as before.
fn renamed_folders(
    tx: &Transaction<'_>,
    root: &Path,
    by_dir_name: &HashMap<String, ProjectRef>,
    on_disk: &BTreeSet<String>,
) -> Result<Vec<(String, String)>> {
    let gone: Vec<&ProjectRef> = by_dir_name
        .values()
        .filter(|project| !on_disk.contains(&project.dir_name))
        .collect();
    let new: Vec<&String> = on_disk
        .iter()
        .filter(|dir_name| !by_dir_name.contains_key(*dir_name))
        .collect();
    if gone.is_empty() || new.is_empty() {
        return Ok(Vec::new());
    }
    let mut known: HashMap<FolderSignature, Vec<String>> = HashMap::new();
    {
        let mut statement = tx.prepare(
            "SELECT rel_path, size_bytes, mtime_ms FROM files WHERE project_id = ? ORDER BY rel_path",
        )?;
        for project in gone {
            let signature: FolderSignature = statement
                .query_map(params![project.id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<std::result::Result<_, _>>()?;
            known
                .entry(signature)
                .or_default()
                .push(project.dir_name.clone());
        }
    }
    let mut found: HashMap<FolderSignature, Vec<String>> = HashMap::new();
    for dir_name in new {
        let mut files = Vec::new();
        walk_files(&root.join(dir_name), "", &mut files)?;
        let mut signature: FolderSignature = files
            .into_iter()
            .map(|file| (file.rel_path, file.size, file.mtime_ms))
            .collect();
        signature.sort();
        found.entry(signature).or_default().push(dir_name.clone());
    }
    let mut pairs = Vec::new();
    for (signature, olds) in known {
        if let (Some(news), [old]) = (found.get(&signature), olds.as_slice())
            && let [new] = news.as_slice()
        {
            pairs.push((old.clone(), new.clone()));
        }
    }
    Ok(pairs)
}

/// Reconciles `ctx`'s user's library folder with the database. See the module docs.
///
/// `on_progress`, when given, hears about every project and every file as it goes.
pub fn rescan(
    lib: &Library,
    ctx: &Ctx,
    mut on_progress: OnRescanProgress<'_>,
) -> Result<RescanResultDto> {
    let library_dir = require_user_row(&lib.db(), &ctx.user_id)?.library_dir;
    let root = user_root(lib, &library_dir)?;
    let now = now_ms();
    let mut result = RescanResultDto::default();

    let on_disk = list_project_folders(&root)?;

    // Adopt every folder with no row.
    let mut projects: Vec<ProjectRef> = {
        let mut conn = lib.db();
        let tx = conn.transaction()?;
        let mut by_dir_name: HashMap<String, ProjectRef> = HashMap::new();
        {
            let mut statement =
                tx.prepare("SELECT id, dir_name, state FROM projects WHERE owner_id = ?")?;
            let rows = statement.query_map(params![ctx.user_id], |row| {
                Ok(ProjectRef {
                    id: row.get(0)?,
                    dir_name: row.get(1)?,
                    state: row.get(2)?,
                })
            })?;
            for row in rows {
                let row = row?;
                by_dir_name.insert(row.dir_name.clone(), row);
            }
        }
        // A folder renamed in Explorer keeps its project: a project whose folder is gone and a new
        // folder holding exactly its files are one project under a new folder name.
        for (old, new) in renamed_folders(&tx, &root, &by_dir_name, &on_disk)? {
            let Some(mut project) = by_dir_name.remove(&old) else {
                continue;
            };
            tx.execute(
                "UPDATE projects SET dir_name = ?, state = 'ok', updated_at = ? WHERE id = ?",
                params![new, now, project.id],
            )?;
            // The name follows the folder when it was the folder's name, and when no other project
            // already has the new one.
            let name_taken = tx
                .query_row(
                    "SELECT 1 FROM projects WHERE owner_id = ? AND id <> ? AND name = ? COLLATE NOCASE",
                    params![ctx.user_id, project.id, new],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !name_taken {
                tx.execute(
                    "UPDATE projects SET name = ? WHERE id = ? AND name = ?",
                    params![new, project.id, old],
                )?;
            }
            lib.log().info(
                "project folder renamed",
                fields!["projectId" => &project.id, "from" => &old, "to" => &new],
            );
            project.dir_name = new.clone();
            project.state = "ok".to_owned();
            by_dir_name.insert(new, project);
        }
        for dir_name in &on_disk {
            if by_dir_name.contains_key(dir_name) {
                continue;
            }
            let id = new_id();
            tx.execute(
                "INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![id, ctx.user_id, dir_name, dir_name, now, now],
            )?;
            lib.log().debug(
                "adopted project folder",
                fields!["projectId" => &id, "dirName" => dir_name],
            );
            by_dir_name.insert(
                dir_name.clone(),
                ProjectRef {
                    id,
                    dir_name: dir_name.clone(),
                    state: "ok".to_owned(),
                },
            );
            result.adopted += 1;
        }
        tx.commit()?;
        by_dir_name.into_values().collect()
    };
    projects.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));

    let project_count = projects.len();
    let mut files_seen: i64 = 0;
    let mut report = |project_index: usize, dir_name: &str, files_seen: i64, files_added: i64| {
        if let Some(callback) = on_progress.as_deref_mut() {
            callback(&RescanProgress {
                project_index,
                project_count,
                dir_name: dir_name.to_owned(),
                files_seen,
                files_added,
            });
        }
    };

    for (index, project) in projects.iter().enumerate() {
        let project_index = index + 1;
        report(
            project_index,
            &project.dir_name,
            files_seen,
            result.files_added,
        );

        if !on_disk.contains(&project.dir_name) {
            // Never delete metadata implicitly; the drive may just be unmounted (3.5).
            if project.state != "missing" {
                lib.db().execute(
                    "UPDATE projects SET state = 'missing', updated_at = ? WHERE id = ?",
                    params![now, project.id],
                )?;
                result.marked_missing += 1;
            }
            continue;
        }
        if project.state != "ok" {
            lib.db().execute(
                "UPDATE projects SET state = 'ok', updated_at = ? WHERE id = ?",
                params![now, project.id],
            )?;
        }

        let mut files = Vec::new();
        walk_files(&root.join(&project.dir_name), "", &mut files)?;
        let seen: HashSet<&str> = files.iter().map(|file| file.rel_path.as_str()).collect();
        let existing: HashMap<String, KnownFile> = {
            let conn = lib.db();
            let mut statement = conn.prepare(
                "SELECT id, rel_path, size_bytes, mtime_ms, kind, classified_by
                 FROM files WHERE project_id = ?",
            )?;
            let rows = statement.query_map(params![project.id], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    KnownFile {
                        id: row.get(0)?,
                        size_bytes: row.get(2)?,
                        mtime_ms: row.get(3)?,
                        kind: row.get(4)?,
                        classified_by: row.get(5)?,
                    },
                ))
            })?;
            rows.collect::<std::result::Result<_, _>>()?
        };

        for file in &files {
            files_seen += 1;
            report(
                project_index,
                &project.dir_name,
                files_seen,
                result.files_added,
            );
            let Some(known) = existing.get(&file.rel_path) else {
                let id = new_id();
                let classification = classify_file(&file.abs_path);
                let hash = file_content_hash(&file.abs_path)?;
                let mut conn = lib.db();
                let tx = conn.transaction()?;
                tx.execute(
                    "INSERT INTO files (id, project_id, rel_path, kind, slicer, size_bytes, mtime_ms, content_hash, classified_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        id,
                        project.id,
                        file.rel_path,
                        classification.kind.as_str(),
                        slicer_text(&classification),
                        file.size,
                        file.mtime_ms,
                        hash.as_slice(),
                        CLASSIFIER_VERSION
                    ],
                )?;
                insert_preview(&tx, &id, now)?;
                tx.commit()?;
                result.files_added += 1;
                result.previews_queued += 1;
                continue;
            };

            if known.size_bytes == file.size && known.mtime_ms == file.mtime_ms {
                // The bytes have not moved, so there is nothing to re-hash, but the *classifier*
                // may have changed its mind since this row was written, and a file whose bytes
                // never move would otherwise never be asked again. `classify_file` is a string
                // comparison for everything but `.3mf`, and this runs once per version bump
                // rather than once per tick.
                if known.classified_by == CLASSIFIER_VERSION {
                    continue;
                }
                let classification = classify_file(&file.abs_path);
                // An answer that only means "could not open this file" must not be stamped,
                // because on *this* branch the stamp is what makes it permanent. `classify_3mf`
                // falls back to `other` for a `.3mf` it cannot open at all (a slicer holding it,
                // a permission error), and a version bump opens every one of them in a single
                // pass, which is precisely when a lock is most likely to be met. Stamping that
                // fallback would move a `slicer_project` to `other`, lose its `ready` preview to
                // the reset, and then never ask again, because nothing re-asks a row whose stamp
                // is current until its bytes move. Leaving the row exactly as it was costs one
                // re-ask on the next rescan.
                //
                // The stat-mismatch path below carries the same guard so that it does not depend
                // on the order of two adjacent statements.
                if classification.unreadable {
                    continue;
                }
                let mut conn = lib.db();
                let tx = conn.transaction()?;
                tx.execute(
                    "UPDATE files SET kind = ?, slicer = ?, classified_by = ? WHERE id = ?",
                    params![
                        classification.kind.as_str(),
                        slicer_text(&classification),
                        CLASSIFIER_VERSION,
                        known.id
                    ],
                )?;
                // Only a kind that actually moved re-pends: a bump made for `.step` must not
                // re-render every STL in the library. A bare UPDATE against a preview row that is
                // not there updates nothing and reports nothing, so the file would reclassify to
                // `model` and then never render: hence the insert beside the reset.
                //
                // Written down rather than hidden: this is right for `other -> model`. The
                // reverse, `model -> other`, which nothing causes today, would leave a `ready` row
                // holding a PNG for a file the viewer no longer offers. Harmless, and worth
                // deciding when something actually causes it.
                if classification.kind.as_str() != known.kind {
                    if preview_exists(&tx, &known.id)? {
                        reset_preview(&tx, &known.id, now)?;
                    } else {
                        insert_preview(&tx, &known.id, now)?;
                    }
                    result.previews_queued += 1;
                }
                tx.commit()?;
                continue;
            }

            // Cheap stat mismatch, so pay for the hash and reclassify: a saved 3MF can change
            // slicer.
            let hash = file_content_hash(&file.abs_path)?;
            let classification = classify_file(&file.abs_path);
            // The version-mismatch branch's guard again. Here it *removes* an invariant rather
            // than relying on one: the hash above happens to fail first on a file that cannot be
            // opened, but nothing but the order of two statements pins that. Without the guard, a
            // `.3mf` whose mtime moved because a slicer saved it, with that slicer still holding
            // it open, would be written `other` and stamped current. Skipping leaves size, mtime
            // and hash untouched too, so the next rescan sees the same mismatch and asks again.
            if classification.unreadable {
                continue;
            }
            let mut conn = lib.db();
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE files SET kind = ?, slicer = ?, size_bytes = ?, mtime_ms = ?, content_hash = ?, classified_by = ?
                 WHERE id = ?",
                params![
                    classification.kind.as_str(),
                    slicer_text(&classification),
                    file.size,
                    file.mtime_ms,
                    hash.as_slice(),
                    CLASSIFIER_VERSION,
                    known.id
                ],
            )?;
            let preview: Option<Option<Vec<u8>>> = tx
                .query_row(
                    "SELECT source_hash FROM previews WHERE file_id = ?",
                    params![known.id],
                    |row| row.get(0),
                )
                .optional()?;
            let same_source = preview
                .as_ref()
                .and_then(|source| source.as_deref())
                .is_some_and(|source| source == hash.as_slice());
            if !same_source {
                if preview.is_some() {
                    reset_preview(&tx, &known.id, now)?;
                } else {
                    insert_preview(&tx, &known.id, now)?;
                }
                result.previews_queued += 1;
            }
            tx.commit()?;
        }

        for (rel_path, known) in &existing {
            if seen.contains(rel_path.as_str()) {
                continue;
            }
            lib.db()
                .execute("DELETE FROM files WHERE id = ?", params![known.id])?;
            result.files_removed += 1;
        }
    }

    lib.log().info(
        "rescan complete",
        fields![
            "userId" => &ctx.user_id,
            "adopted" => result.adopted,
            "markedMissing" => result.marked_missing,
            "filesAdded" => result.files_added,
            "filesRemoved" => result.files_removed,
            "previewsQueued" => result.previews_queued,
        ],
    );
    Ok(result)
}

/// [`rescan`] for every user who can sign in, which is what a change somewhere under a shared
/// library root calls for: the server's watcher knows *that* something moved, not whose folder it
/// was in, and a rescan with nothing to do is a stat per file. A failure for one user is reported
/// and the others still run.
pub fn rescan_every_user(lib: &Library) -> Result<Vec<(String, Result<RescanResultDto>)>> {
    let users: Vec<(String, bool)> = {
        let db = lib.db();
        let mut statement =
            db.prepare("SELECT id, is_admin FROM users WHERE status <> 'disabled' ORDER BY id")?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    Ok(users
        .into_iter()
        .map(|(user_id, is_admin)| {
            let ctx = Ctx {
                user_id: user_id.clone(),
                is_admin,
            };
            let result = rescan(lib, &ctx, None);
            (user_id, result)
        })
        .collect())
}
