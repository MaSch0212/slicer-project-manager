//! Project lifecycle: create, update, delete and tags.
//!
//! Ownership is part of every lookup (`require_project_row`), so another user's project is
//! `NotFound` throughout. Folder changes happen on the file system outside the database lock.

use std::fs;
use std::io::ErrorKind;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params, params_from_iter};

use super::queries::{get_project_in, require_project_row};
use crate::clock::now_ms;
use crate::ctx::Ctx;
use crate::db::Library;
use crate::db::ids::new_id;
use crate::dto::CoreProjectDto;
use crate::error::Result;
use crate::fields;
use crate::files::paths::project_dir;
use crate::users::repo::require_user_row;
use crate::validate::{CreateProjectInput, ProjectPatch, Validate, js_trim};

/// Folder names come from the project name but must survive every filesystem.
pub fn sanitize_dir_name(name: &str) -> String {
    // Separators and the characters Windows reserves become dashes; runs of whitespace collapse.
    let replaced: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let mut collapsed = String::with_capacity(replaced.len());
    let mut in_space = false;
    for c in replaced.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    // Trims leading/trailing dots, whitespace and the dashes that just replaced separators
    // (e.g. a trailing "?" becomes a trailing "-", which is still junk to trim).
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c == '-' || is_js_space(c));
    // `.slice(0, 120)` counted UTF-16 units; counting chars is the same for everything but
    // astral characters, and never cuts one in half.
    let cleaned: String = trimmed.chars().take(120).collect();
    if cleaned.is_empty() {
        "project".to_owned()
    } else {
        cleaned
    }
}

fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn unique_dir_name(conn: &Connection, ctx: &Ctx, base: &str) -> Result<String> {
    let mut candidate = base.to_owned();
    let mut n = 2;
    loop {
        let taken = conn
            .query_row(
                "SELECT 1 FROM projects WHERE owner_id = ? AND dir_name = ?",
                params![ctx.user_id, candidate],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !taken {
            return Ok(candidate);
        }
        candidate = format!("{base} ({n})");
        n += 1;
    }
}

/// Creates a project and its folder. `input` is validated here: it is the one use case whose whole
/// input comes from outside.
pub fn create_project(
    lib: &Library,
    ctx: &Ctx,
    input: CreateProjectInput,
) -> Result<CoreProjectDto> {
    let input = input.validate()?;
    let id = new_id();
    let now = now_ms();

    let dir_name = {
        let mut conn = lib.db();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let user = require_user_row(&tx, &ctx.user_id)?;
        let dir_name = unique_dir_name(&tx, ctx, &sanitize_dir_name(&input.name))?;
        fs::create_dir_all(project_dir(lib, &user.library_dir, &dir_name)?)?;
        tx.execute(
            "INSERT INTO projects (id, owner_id, name, dir_name, website, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                ctx.user_id,
                input.name,
                dir_name,
                input.website,
                input.notes,
                now,
                now
            ],
        )?;
        for tag in input.tags.iter().flatten() {
            add_tag_in(&tx, ctx, &id, tag)?;
        }
        tx.commit()?;
        dir_name
    };

    lib.log().info(
        "project created",
        fields!["projectId" => &id, "dirName" => &dir_name, "userId" => &ctx.user_id],
    );
    Ok(get_project_in(&lib.db(), ctx, &id)?.project)
}

/// Patches a project. The patch is validated here as well (`website` must be a URL, and so on);
/// the CuraManager importer, which must accept whatever a sidecar holds, uses the unchecked
/// variant instead.
pub fn update_project(
    lib: &Library,
    ctx: &Ctx,
    id: &str,
    patch: ProjectPatch,
) -> Result<CoreProjectDto> {
    update_project_unchecked(lib, ctx, id, patch.validate()?)
}

pub(crate) fn update_project_unchecked(
    lib: &Library,
    ctx: &Ctx,
    id: &str,
    patch: ProjectPatch,
) -> Result<CoreProjectDto> {
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    let mut fields_set: Vec<&str> = Vec::new();

    // dir_name deliberately does not follow name: a rename must never move a folder.
    if let Some(name) = &patch.name {
        sets.push("name = ?");
        params.push(Value::Text(name.clone()));
        fields_set.push("name");
    }
    if let Some(website) = &patch.website {
        sets.push("website = ?");
        params.push(website.clone().map_or(Value::Null, Value::Text));
        fields_set.push("website");
    }
    if let Some(notes) = &patch.notes {
        sets.push("notes = ?");
        params.push(notes.clone().map_or(Value::Null, Value::Text));
        fields_set.push("notes");
    }
    if let Some(is_archived) = patch.is_archived {
        sets.push("is_archived = ?");
        params.push(Value::Integer(i64::from(is_archived)));
        fields_set.push("isArchived");
    }

    let conn = lib.db();
    require_project_row(&conn, ctx, id)?;
    if !sets.is_empty() {
        sets.push("updated_at = ?");
        params.push(Value::Integer(now_ms()));
        params.push(Value::Text(id.to_owned()));
        params.push(Value::Text(ctx.user_id.clone()));
        conn.execute(
            &format!(
                "UPDATE projects SET {} WHERE id = ? AND owner_id = ?",
                sets.join(", ")
            ),
            params_from_iter(params),
        )?;
        lib.log().info(
            "project updated",
            fields![
                "projectId" => id,
                "userId" => &ctx.user_id,
                "fields" => fields_set.join(","),
            ],
        );
    }
    Ok(get_project_in(&conn, ctx, id)?.project)
}

/// Deletes the project's row (and with it its files and tags links). The folder is only removed
/// from disk when `delete_files` is set.
pub fn delete_project(lib: &Library, ctx: &Ctx, id: &str, delete_files: bool) -> Result<()> {
    let (row, library_dir) = {
        let conn = lib.db();
        let row = require_project_row(&conn, ctx, id)?;
        let user = require_user_row(&conn, &ctx.user_id)?;
        (row, user.library_dir)
    };
    if delete_files {
        match fs::remove_dir_all(project_dir(lib, &library_dir, &row.dir_name)?) {
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    lib.db().execute(
        "DELETE FROM projects WHERE id = ? AND owner_id = ?",
        params![id, ctx.user_id],
    )?;
    lib.log().info(
        "project deleted",
        fields![
            "projectId" => id,
            "dirName" => &row.dir_name,
            "userId" => &ctx.user_id,
            "deletedFiles" => delete_files,
        ],
    );
    Ok(())
}

/// Adds a tag to a project, creating it if the owner has none of that name (case-insensitively).
/// A blank name is ignored.
pub fn add_tag(lib: &Library, ctx: &Ctx, project_id: &str, name: &str) -> Result<()> {
    let mut conn = lib.db();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    add_tag_in(&tx, ctx, project_id, name)?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn add_tag_in(conn: &Connection, ctx: &Ctx, project_id: &str, name: &str) -> Result<()> {
    require_project_row(conn, ctx, project_id)?;
    let trimmed = js_trim(name);
    if trimmed.is_empty() {
        return Ok(());
    }

    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM tags WHERE owner_id = ? AND name = ? COLLATE NOCASE",
            params![ctx.user_id, trimmed],
            |row| row.get(0),
        )
        .optional()?;
    let tag_id = match existing {
        Some(id) => id,
        None => conn.query_row(
            "INSERT INTO tags (owner_id, name) VALUES (?, ?) RETURNING id",
            params![ctx.user_id, trimmed],
            |row| row.get(0),
        )?,
    };

    conn.execute(
        "INSERT OR IGNORE INTO project_tags (project_id, tag_id) VALUES (?, ?)",
        params![project_id, tag_id],
    )?;
    conn.execute(
        "UPDATE projects SET updated_at = ? WHERE id = ?",
        params![now_ms(), project_id],
    )?;
    Ok(())
}

/// Removes a tag from a project (case-insensitively), and the tag itself once nothing carries it.
pub fn remove_tag(lib: &Library, ctx: &Ctx, project_id: &str, name: &str) -> Result<()> {
    let mut conn = lib.db();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_project_row(&tx, ctx, project_id)?;
    tx.execute(
        "DELETE FROM project_tags WHERE project_id = ?
         AND tag_id IN (SELECT id FROM tags WHERE owner_id = ? AND name = ? COLLATE NOCASE)",
        params![project_id, ctx.user_id, js_trim(name)],
    )?;
    // A tag that labels nothing is noise in the filter list.
    tx.execute(
        "DELETE FROM tags WHERE owner_id = ? AND id NOT IN (SELECT tag_id FROM project_tags)",
        params![ctx.user_id],
    )?;
    tx.execute(
        "UPDATE projects SET updated_at = ? WHERE id = ?",
        params![now_ms(), project_id],
    )?;
    tx.commit()?;
    Ok(())
}
