//! Migrating a CuraManager library (parent spec 3.6).
//!
//! A CuraManager library is a flat folder of project folders, each with an optional `metadata.json`
//! sidecar holding its tags, website and archived flag. Importing is: optionally move the folders
//! under the target user's folder, rescan to adopt and index them, then apply every sidecar.
//!
//! The command-line entry point is a subcommand of the server binary; everything it does is here.

use std::fs;
use std::path::Path;

use rusqlite::params;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::rescan::{RescanProgress, rescan};
use super::usecases::{add_tag, update_project_unchecked};
use crate::ctx::Ctx;
use crate::db::Library;
use crate::dto::RescanResultDto;
use crate::error::{AppError, Result};
use crate::fields;
use crate::files::paths::user_root;
use crate::users::repo::require_user_row;
use crate::validate::ProjectPatch;

pub const SIDECAR_FILE: &str = "metadata.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuraManagerSidecar {
    pub tags: Vec<String>,
    pub website: Option<String>,
    pub is_archived: bool,
}

/// The first of `keys` whose value is present and not `null` (JavaScript's `a ?? b`).
fn first_present<'a>(object: &'a Map<String, Value>, keys: [&str; 2]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| object.get(*key))
        .find(|value| !value.is_null())
}

/// CuraManager wrote PascalCase keys; camelCase is accepted too so hand-edits still load. An
/// absent, malformed or non-object file is `None`: the migration continues without it rather than
/// aborting.
pub fn read_curamanager_sidecar(project_dir_path: &Path) -> Option<CuraManagerSidecar> {
    let bytes = fs::read(project_dir_path.join(SIDECAR_FILE)).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    // A byte-order mark is not part of the JSON; editors on Windows add one.
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let Value::Object(parsed) = serde_json::from_str::<Value>(text).ok()? else {
        return None;
    };

    let tags = match first_present(&parsed, ["Tags", "tags"]) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    let website = match first_present(&parsed, ["Website", "website"]) {
        Some(Value::String(url)) if !url.is_empty() => Some(url.clone()),
        _ => None,
    };
    let is_archived = matches!(
        first_present(&parsed, ["IsArchived", "isArchived"]),
        Some(Value::Bool(true))
    );
    Some(CuraManagerSidecar {
        tags,
        website,
        is_archived,
    })
}

/// Server import: a CuraManager library is flat, so every project folder at the root moves under
/// the target user's `library_dir`. Dot-folders and every user's own root are left alone. Returns
/// how many folders moved.
///
/// All or nothing: every destination is verified free before anything moves, so a collision aborts
/// loudly and leaves the file system untouched on every platform. (Catching the rename failure
/// afterwards would not do: on POSIX `rename(2)` onto an *empty* existing directory succeeds by
/// silently replacing it, so the same input would abort on one OS and succeed on another.)
pub fn move_flat_library_into_user_folder(lib: &Library, ctx: &Ctx) -> Result<usize> {
    let (library_dir, reserved) = {
        let conn = lib.db();
        let user = require_user_row(&conn, &ctx.user_id)?;
        let mut statement = conn.prepare("SELECT library_dir FROM users")?;
        let reserved = statement
            .query_map(params![], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<std::collections::HashSet<_>, _>>()?;
        (user.library_dir, reserved)
    };
    if library_dir == "." {
        return Ok(0);
    }
    let target = user_root(lib, &library_dir)?;

    let mut to_move: Vec<String> = Vec::new();
    for entry in fs::read_dir(lib.dir())? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && !name.starts_with('.') && !reserved.contains(&name) {
            to_move.push(name);
        }
    }
    to_move.sort();

    let collisions: Vec<&String> = to_move
        .iter()
        .filter(|name| target.join(name).exists())
        .collect();
    if !collisions.is_empty() {
        let names = collisions
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let mut details = Map::new();
        details.insert("existing".into(), json!(collisions));
        return Err(AppError::conflict(format!(
            "cannot import: already exists under the target user's folder: {names}"
        ))
        .with_details(details));
    }

    for name in &to_move {
        fs::rename(lib.dir().join(name), target.join(name))?;
    }
    Ok(to_move.len())
}

/// What an import reports while it works.
///
/// The phases take very different amounts of time (indexing hashes every byte on disk, applying
/// sidecars is a handful of queries per project, extracting writes every byte of an archive), so
/// they are reported separately rather than folded into one percentage that would sit at 99% for
/// the whole second half. The library importer emits `Indexing` then `Sidecars`; the zip importer
/// emits `Extracting` first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub enum ImportProgress {
    #[serde(rename_all = "camelCase")]
    Extracting {
        file_index: usize,
        file_count: usize,
        rel_path: String,
    },
    Indexing(RescanProgress),
    #[serde(rename_all = "camelCase")]
    Sidecars {
        project_index: usize,
        project_count: usize,
        dir_name: String,
    },
}

/// A callback for an import's progress. Called on the importing thread with no database lock held.
pub type OnImportProgress<'a> = Option<&'a mut dyn FnMut(&ImportProgress)>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarsApplied {
    pub projects_updated: i64,
    pub tags_applied: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuraManagerImport {
    pub rescan: RescanResultDto,
    pub projects_updated: i64,
    pub tags_applied: i64,
    /// How many project folders moved under the user's folder.
    pub moved: usize,
}

/// Imports the CuraManager library sitting in the library folder for `ctx`'s user.
///
/// `move_into_user_folder` is for a server library, whose project folders start flat at the root;
/// a local-folder library (`library_dir` of `.`) has nothing to move.
pub fn import_curamanager_library(
    lib: &Library,
    ctx: &Ctx,
    move_into_user_folder: bool,
    mut on_progress: OnImportProgress<'_>,
) -> Result<CuraManagerImport> {
    let moved = if move_into_user_folder {
        move_flat_library_into_user_folder(lib, ctx)?
    } else {
        0
    };

    // Adopt every folder and index its files first (spec 3.6, step 2).
    let rescan_result = {
        let mut forward = |progress: &RescanProgress| {
            if let Some(callback) = on_progress.as_deref_mut() {
                callback(&ImportProgress::Indexing(progress.clone()));
            }
        };
        rescan(lib, ctx, Some(&mut forward))?
    };

    let applied = apply_curamanager_sidecars(lib, ctx, on_progress, None)?;
    Ok(CuraManagerImport {
        rescan: rescan_result,
        projects_updated: applied.projects_updated,
        tags_applied: applied.tags_applied,
        moved,
    })
}

/// Applies every project sidecar found on disk: its tags, website and archived flag.
///
/// Split out of [`import_curamanager_library`] so the zip upload path runs the identical second
/// half; the two entry points differ only in how the folders arrive.
///
/// `only_dir_names` restricts the pass to those folders. `None` means every project the user owns,
/// which is right for the one-shot migration but wrong for the repeatable zip upload: a sidecar
/// still sitting in an older project's folder would otherwise reset the website and archived flag
/// the user has since edited in the app, every time they import anything at all.
pub fn apply_curamanager_sidecars(
    lib: &Library,
    ctx: &Ctx,
    mut on_progress: OnImportProgress<'_>,
    only_dir_names: Option<&[String]>,
) -> Result<SidecarsApplied> {
    let (library_dir, all) = {
        let conn = lib.db();
        let user = require_user_row(&conn, &ctx.user_id)?;
        let mut statement = conn.prepare(
            "SELECT id, dir_name FROM projects WHERE owner_id = ? AND state = 'ok' ORDER BY dir_name",
        )?;
        let rows = statement
            .query_map(params![ctx.user_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        (user.library_dir, rows)
    };
    let root = user_root(lib, &library_dir)?;
    let projects: Vec<(String, String)> = match only_dir_names {
        Some(wanted) => all
            .into_iter()
            .filter(|(_, dir_name)| wanted.contains(dir_name))
            .collect(),
        None => all,
    };

    let mut projects_updated = 0;
    let mut tags_applied = 0;
    let project_count = projects.len();
    for (index, (project_id, dir_name)) in projects.iter().enumerate() {
        if let Some(callback) = on_progress.as_deref_mut() {
            callback(&ImportProgress::Sidecars {
                project_index: index + 1,
                project_count,
                dir_name: dir_name.clone(),
            });
        }
        let Some(sidecar) = read_curamanager_sidecar(&root.join(dir_name)) else {
            continue;
        };

        let count_tags = || -> Result<i64> {
            Ok(lib.db().query_row(
                "SELECT COUNT(*) FROM project_tags WHERE project_id = ?",
                params![project_id],
                |row| row.get(0),
            )?)
        };
        let before = count_tags()?;
        for tag in &sidecar.tags {
            add_tag(lib, ctx, project_id, tag)?;
        }
        tags_applied += count_tags()? - before;

        update_project_unchecked(
            lib,
            ctx,
            project_id,
            ProjectPatch {
                website: Some(sidecar.website),
                is_archived: Some(sidecar.is_archived),
                ..ProjectPatch::default()
            },
        )?;
        projects_updated += 1;
    }

    lib.log().info(
        "applied curamanager sidecars",
        fields![
            "userId" => &ctx.user_id,
            "projectsUpdated" => projects_updated,
            "tagsApplied" => tags_applied,
        ],
    );
    Ok(SidecarsApplied {
        projects_updated,
        tags_applied,
    })
}
