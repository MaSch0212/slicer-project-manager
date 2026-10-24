//! Reading projects: the list (search, tag filter, sort, paging), the detail and the tag list.
//!
//! Every query is scoped by `ctx.user_id`: there is no unscoped variant to call by mistake
//! (parent spec 2.2). Each public function takes the database lock once and releases it before
//! returning; the `*_in` functions work on a connection the caller already holds.

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};

use crate::ctx::Ctx;
use crate::db::Library;
use crate::dto::{
    CoreFileDto, CoreProjectDetailDto, CoreProjectDto, FileCounts, FileKind, PreviewState,
    ProjectQuery, ProjectState, SlicerId, SortDir, SortKey,
};
use crate::error::{AppError, Result};
use crate::validate::js_trim;

/// A `projects` row.
#[derive(Debug, Clone)]
pub struct ProjectRow {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub dir_name: String,
    pub website: Option<String>,
    pub notes: Option<String>,
    pub is_archived: bool,
    pub state: ProjectState,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A text column holding something the schema's `CHECK` constraints should have made impossible
/// (a hand-edited database): reported, not guessed at.
pub(crate) fn bad_value(column: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        format!("unknown {column} {value:?}").into(),
    )
}

impl ProjectRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<ProjectRow> {
        let state: String = row.get("state")?;
        Ok(ProjectRow {
            id: row.get("id")?,
            owner_id: row.get("owner_id")?,
            name: row.get("name")?,
            dir_name: row.get("dir_name")?,
            website: row.get("website")?,
            notes: row.get("notes")?,
            is_archived: row.get::<_, i64>("is_archived")? == 1,
            state: ProjectState::parse(&state).ok_or_else(|| bad_value("project state", &state))?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

/// Always scoped by `ctx.user_id`: another user's project is `NotFound`, never `Forbidden`.
pub(crate) fn require_project_row(conn: &Connection, ctx: &Ctx, id: &str) -> Result<ProjectRow> {
    conn.query_row(
        "SELECT * FROM projects WHERE id = ? AND owner_id = ?",
        params![id, ctx.user_id],
        ProjectRow::from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("project not found"))
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// `%` and `_` are LIKE wildcards; a user searching for "100%" means the literal character.
fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for ch in term.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn tags_by_project(conn: &Connection, ids: &[String]) -> Result<HashMap<String, Vec<String>>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let sql = format!(
        "SELECT pt.project_id, t.name
         FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.project_id IN ({})
         ORDER BY t.name COLLATE NOCASE",
        placeholders(ids.len())
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(ids), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (project_id, name) = row?;
        map.entry(project_id).or_default().push(name);
    }
    Ok(map)
}

fn counts_by_project(conn: &Connection, ids: &[String]) -> Result<HashMap<String, FileCounts>> {
    let mut map: HashMap<String, FileCounts> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let sql = format!(
        "SELECT project_id, kind, COUNT(*) FROM files
         WHERE project_id IN ({}) GROUP BY project_id, kind",
        placeholders(ids.len())
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(ids), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        let (project_id, kind, n) = row?;
        let entry = map.entry(project_id).or_default();
        match FileKind::parse(&kind) {
            Some(FileKind::Model) => entry.model = n,
            Some(FileKind::SlicerProject) => entry.slicer_project = n,
            _ => entry.other = n,
        }
    }
    Ok(map)
}

/// Prefers a ready model preview, falls back to a ready slicer-project thumbnail.
fn cover_by_project(conn: &Connection, ids: &[String]) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let sql = format!(
        "SELECT f.project_id, f.id
         FROM files f JOIN previews pv ON pv.file_id = f.id
         WHERE f.project_id IN ({}) AND pv.state = 'ready'
           AND f.kind IN ('model', 'slicer_project')
         ORDER BY (f.kind = 'model') DESC, f.rel_path COLLATE NOCASE",
        placeholders(ids.len())
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(ids), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (project_id, file_id) = row?;
        map.entry(project_id).or_insert(file_id);
    }
    Ok(map)
}

/// The file DTO of a row selected as `f.*, pv.state AS preview_state`.
pub(crate) fn core_file_dto_from_row(row: &Row<'_>) -> rusqlite::Result<CoreFileDto> {
    let kind: String = row.get("kind")?;
    let slicer: Option<String> = row.get("slicer")?;
    let preview_state: Option<String> = row.get("preview_state")?;
    Ok(CoreFileDto {
        id: row.get("id")?,
        name: row.get("rel_path")?,
        kind: FileKind::parse(&kind).ok_or_else(|| bad_value("file kind", &kind))?,
        slicer: match slicer {
            Some(value) => {
                Some(SlicerId::parse(&value).ok_or_else(|| bad_value("slicer", &value))?)
            }
            None => None,
        },
        size_bytes: row.get("size_bytes")?,
        preview_state: match preview_state {
            Some(value) => {
                PreviewState::parse(&value).ok_or_else(|| bad_value("preview state", &value))?
            }
            None => PreviewState::Pending,
        },
    })
}

fn to_core_project_dto(
    row: ProjectRow,
    tags: Vec<String>,
    counts: FileCounts,
    cover_file_id: Option<String>,
) -> CoreProjectDto {
    CoreProjectDto {
        id: row.id,
        name: row.name,
        website: row.website.filter(|value| !value.is_empty()),
        notes: row.notes.filter(|value| !value.is_empty()),
        is_archived: row.is_archived,
        state: row.state,
        tags,
        file_counts: counts,
        cover_file_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// The projects of `ctx`'s user matching `query`.
///
/// `limit` omitted returns every row. `offset` is ignored without a `limit` rather than rejected:
/// a caller building its query programmatically can send a stray `offset` on an unpaged request.
pub fn list_projects(
    lib: &Library,
    ctx: &Ctx,
    query: &ProjectQuery,
) -> Result<Vec<CoreProjectDto>> {
    let mut filters: Vec<String> = vec!["p.owner_id = ?".to_owned()];
    let mut params: Vec<Value> = vec![Value::Text(ctx.user_id.clone())];

    if query.include_archived != Some(true) {
        filters.push("p.is_archived = 0".to_owned());
    }

    if let Some(search) = query
        .search
        .as_deref()
        .map(js_trim)
        .filter(|search| !search.is_empty())
    {
        let like = format!("%{}%", escape_like(search));
        // LIKE case-folding here comes from SQLite's default `case_sensitive_like = off`, not from
        // COLLATE: LIKE's case sensitivity is governed solely by that pragma and ignores any
        // COLLATE clause on its operands, so one is deliberately not applied to these three.
        filters.push(
            "(p.name LIKE ? ESCAPE '\\'
              OR IFNULL(p.notes, '') LIKE ? ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
                         WHERE pt.project_id = p.id AND t.name LIKE ? ESCAPE '\\'))"
                .to_owned(),
        );
        params.extend(std::iter::repeat_n(Value::Text(like), 3));
    }

    // Dedupe case-insensitively: both sides of the COUNT(...) = ? comparison below must agree on
    // what "every requested tag" means, or ['petg', 'PETG'] (or a literal duplicate) can never
    // match.
    let mut seen = HashSet::new();
    let mut tags: Vec<&str> = Vec::new();
    for raw in query.tags.iter().flatten() {
        let trimmed = js_trim(raw);
        if trimmed.is_empty() || !seen.insert(trimmed.to_lowercase()) {
            continue;
        }
        tags.push(trimmed);
    }
    if !tags.is_empty() {
        // AND semantics: the project must carry every requested tag.
        filters.push(format!(
            "(SELECT COUNT(DISTINCT t.name COLLATE NOCASE) FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
              WHERE pt.project_id = p.id AND t.name COLLATE NOCASE IN ({})) = ?",
            placeholders(tags.len())
        ));
        params.extend(tags.iter().map(|tag| Value::Text((*tag).to_owned())));
        params.push(Value::Integer(tags.len() as i64));
    }

    let column = match query.sort.unwrap_or(SortKey::UpdatedAt) {
        SortKey::Name => "p.name COLLATE NOCASE",
        SortKey::CreatedAt => "p.created_at",
        SortKey::UpdatedAt => "p.updated_at",
    };
    let direction = if query.dir == Some(SortDir::Asc) {
        "ASC"
    } else {
        "DESC"
    };

    // None of the sort columns is unique (a rescan stamps many rows with the same updated_at), so
    // paging over ties without a tiebreaker lets SQLite order them differently between two
    // queries: a row can then land on both pages or on neither. `p.id` is the primary key, so
    // appending it makes the order total and reproducible across offsets. It is always ASC,
    // independent of `dir`: it exists only to break ties, not to be meaningful on its own.
    let mut sql = format!(
        "SELECT p.* FROM projects p WHERE {} ORDER BY {column} {direction}, p.id ASC",
        filters.join(" AND ")
    );
    if let Some(limit) = query.limit {
        sql.push_str(" LIMIT ?");
        params.push(Value::Integer(limit));
        if let Some(offset) = query.offset {
            sql.push_str(" OFFSET ?");
            params.push(Value::Integer(offset));
        }
    }

    let conn = lib.db();
    let rows = {
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(params), ProjectRow::from_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    let mut tag_map = tags_by_project(&conn, &ids)?;
    let mut count_map = counts_by_project(&conn, &ids)?;
    let mut cover_map = cover_by_project(&conn, &ids)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.id.clone();
            to_core_project_dto(
                row,
                tag_map.remove(&id).unwrap_or_default(),
                count_map.remove(&id).unwrap_or_default(),
                cover_map.remove(&id),
            )
        })
        .collect())
}

/// The distinct tag names in the user's library, sorted case-insensitively (spec 4).
///
/// Reads the `tags` table directly: a tag row only exists for an owner while at least one of
/// their projects still carries it (`remove_tag` deletes the row the moment that stops being
/// true), so the table itself already *is* "the tags currently in the library". `PETG` and `petg`
/// cannot coexist for one owner: `tags` is `UNIQUE (owner_id, name COLLATE NOCASE)`.
pub fn list_tags(lib: &Library, ctx: &Ctx) -> Result<Vec<String>> {
    let conn = lib.db();
    let mut statement =
        conn.prepare("SELECT name FROM tags WHERE owner_id = ? ORDER BY name COLLATE NOCASE")?;
    let rows = statement.query_map(params![ctx.user_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// One project with its files, `NotFound` unless `ctx`'s user owns it.
pub fn get_project(lib: &Library, ctx: &Ctx, id: &str) -> Result<CoreProjectDetailDto> {
    get_project_in(&lib.db(), ctx, id)
}

pub(crate) fn get_project_in(
    conn: &Connection,
    ctx: &Ctx,
    id: &str,
) -> Result<CoreProjectDetailDto> {
    let row = require_project_row(conn, ctx, id)?;
    let ids = [id.to_owned()];
    let tags = tags_by_project(conn, &ids)?.remove(id).unwrap_or_default();
    let counts = counts_by_project(conn, &ids)?
        .remove(id)
        .unwrap_or_default();
    let cover = cover_by_project(conn, &ids)?.remove(id);

    let mut statement = conn.prepare(
        "SELECT f.*, pv.state AS preview_state FROM files f
         LEFT JOIN previews pv ON pv.file_id = f.id
         WHERE f.project_id = ? ORDER BY f.rel_path COLLATE NOCASE",
    )?;
    let files = statement
        .query_map(params![id], core_file_dto_from_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(CoreProjectDetailDto {
        project: to_core_project_dto(row, tags, counts, cover),
        files,
    })
}
