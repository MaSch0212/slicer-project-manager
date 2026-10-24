//! Importing a CuraManager library from a zip archive already staged on disk.
//!
//! This is the counterpart of the command-line import, which has to run on the machine holding the
//! library: for a self-hosted server that is the wrong machine. Uploading the archive lets the
//! import run entirely server-side, in the one process that already owns the database.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

use serde_json::{Map, json};

use super::import_curamanager::{ImportProgress, OnImportProgress, apply_curamanager_sidecars};
use super::rescan::{RELATIVE_PATH_SEPARATOR, RescanProgress, rescan};
use crate::ctx::Ctx;
use crate::db::Library;
use crate::dto::ZipImportResultDto;
use crate::error::{AppError, Result};
use crate::fields;
use crate::files::chunks::ChunkSource;
use crate::files::paths::{safe_join, user_root};
use crate::files::usecases::assert_within_quota;
use crate::files::zip::{ZipChunkOptions, ZipEntry, open_zip};
use crate::users::repo::require_user_row;

/// Zip paths are specified to use forward slashes, whatever platform wrote the archive.
const ZIP_SEPARATOR: char = '/';

/// What an archive would produce, decided without writing anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipPlan {
    /// Entries that will be written, with the path each lands at under the user's root.
    pub files: Vec<PlannedFile>,
    /// Top-level folder names, i.e. the projects this import would create, sorted.
    pub project_dirs: Vec<String>,
    /// The single wrapping folder that was stripped, if the archive had one.
    pub stripped_root: Option<String>,
    /// Entries deliberately not written: loose root files, dot-entries, `__MACOSX` noise.
    pub skipped: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    pub entry: ZipEntry,
    pub rel_path: String,
}

/// Splits on backslashes too, even though the format says not to use them.
///
/// Some Windows tools write them anyway, and treating such a name as one opaque filename makes
/// behaviour depend on the server's platform: on Windows `safe_join` sees separators and refuses
/// the entry, while on Linux the same archive silently produces a file literally called
/// `sub....escape.txt`. Neither is an escape, but "refused here, accepted there" is not a property
/// worth having in an importer. Splitting first makes every segment visible to the `..` rule
/// below, so the same archive is judged the same way everywhere.
fn segments(name: &str) -> Vec<&str> {
    name.split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect()
}

/// Decides what an archive would produce, without writing anything.
///
/// Kept separate from the extraction so every refusal (a collision, a quota overrun, an archive
/// with no projects in it) happens before the first byte hits the disk. A half-written library is
/// far worse than a rejected upload.
pub fn plan_zip_import(entries: &[ZipEntry]) -> ZipPlan {
    let mut skipped = 0;
    let mut usable: Vec<(Vec<&str>, &ZipEntry)> = Vec::new();

    for entry in entries {
        // A trailing slash marks a directory record; directories are created from the file paths
        // instead, so an empty folder in the archive simply does not survive the trip.
        if entry.name.ends_with(ZIP_SEPARATOR) {
            continue;
        }
        let parts = segments(&entry.name);
        // Zip-slip and its relatives. `safe_join` would refuse these later anyway; refusing here
        // means a malicious archive is a clean rejection rather than a half-done extraction.
        if parts.is_empty() || parts.iter().any(|part| *part == ".." || *part == ".") {
            skipped += 1;
            continue;
        }
        // macOS resource forks, and the dot-entries that rescan would ignore on disk anyway.
        if parts[0] == "__MACOSX" || parts.iter().any(|part| part.starts_with('.')) {
            skipped += 1;
            continue;
        }
        usable.push((parts, entry));
    }

    // Zipping a library folder yields `MyLibrary/Project A/part.stl`; zipping its *contents*
    // yields `Project A/part.stl`. Both are things people actually upload, so the wrapper is
    // detected rather than demanded, but only when it holds folders. A lone top-level folder
    // whose children are all files is a single project, and stripping it would scatter that
    // project's files across the library root.
    let top_level: BTreeSet<&str> = usable.iter().map(|(parts, _)| parts[0]).collect();
    let has_nested_dirs = usable.iter().any(|(parts, _)| parts.len() > 2);
    let stripped_root = if top_level.len() == 1 && has_nested_dirs {
        top_level.iter().next().map(|root| (*root).to_owned())
    } else {
        None
    };

    let mut files = Vec::new();
    let mut project_dirs = BTreeSet::new();
    let mut total_bytes: u64 = 0;

    for (parts, entry) in &usable {
        let relative = if stripped_root.is_some() {
            &parts[1..]
        } else {
            &parts[..]
        };
        // A file sitting directly at the library root belongs to no project (CuraManager's own
        // `metadata-cache.json` is exactly this). Nothing would ever index it, so it is not
        // written.
        if relative.len() < 2 {
            skipped += 1;
            continue;
        }
        project_dirs.insert(relative[0].to_owned());
        files.push(PlannedFile {
            entry: (*entry).clone(),
            rel_path: relative.join(RELATIVE_PATH_SEPARATOR),
        });
        total_bytes = total_bytes.saturating_add(entry.uncompressed_size);
    }

    ZipPlan {
        files,
        project_dirs: project_dirs.into_iter().collect(),
        stripped_root,
        skipped,
        total_bytes,
    }
}

fn is_directory(path: &Path) -> bool {
    // Absent is the common answer and the only one that matters here; a permissions error
    // resolves the same way and surfaces properly when the write itself is attempted.
    fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// Streams one entry to `target`, a bounded chunk at a time, and returns how many bytes it wrote.
fn extract_entry(zip: &crate::files::zip::OpenZip, entry: &ZipEntry, target: &Path) -> Result<u64> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut chunks = zip.read_chunks(entry, ZipChunkOptions::default())?;
    let mut out = BufWriter::new(File::create(target)?);
    let mut written: u64 = 0;
    while let Some(chunk) = chunks.pull_chunk()? {
        out.write_all(chunk)?;
        written += chunk.len() as u64;
    }
    out.flush()?;
    Ok(written)
}

/// Imports a CuraManager library from the zip at `zip_path`.
///
/// Refuses before writing: an import that stopped halfway would leave a library that is neither
/// the old one nor the new one. If extraction itself fails part-way (a corrupt entry), the project
/// folders this call created (none of which existed beforehand) are removed again.
pub fn import_curamanager_zip(
    lib: &Library,
    ctx: &Ctx,
    zip_path: &Path,
    mut on_progress: OnImportProgress<'_>,
) -> Result<ZipImportResultDto> {
    let library_dir = require_user_row(&lib.db(), &ctx.user_id)?.library_dir;
    let root = user_root(lib, &library_dir)?;
    let zip = open_zip(zip_path)?;

    let plan = plan_zip_import(zip.entries());
    if plan.files.is_empty() {
        return Err(AppError::validation(
            "the archive contains no project folders. A CuraManager library is a folder of \
             project folders; zip that folder, or its contents.",
        ));
    }

    // Refuse before writing: an import that stopped halfway would leave a library that is neither
    // the old one nor the new one, with no obvious way back.
    let mut collisions = Vec::new();
    for name in &plan.project_dirs {
        if is_directory(&safe_join(&root, &[name])?) {
            collisions.push(name.clone());
        }
    }
    if !collisions.is_empty() {
        let mut details = Map::new();
        details.insert("existing".into(), json!(collisions));
        return Err(AppError::conflict(format!(
            "already in your library: {}. Rename or remove them first.",
            collisions.join(", ")
        ))
        .with_details(details));
    }
    // Uncompressed size, deliberately: the quota governs what lands on disk, and a zip bomb is
    // precisely the case where the compressed size is a useless proxy for it.
    assert_within_quota(
        lib,
        ctx,
        i64::try_from(plan.total_bytes).unwrap_or(i64::MAX),
    )?;

    // Resolve every destination up front. `safe_join` is the authoritative containment check: it
    // normalises each segment and re-verifies the result sits under the root, which is what
    // catches escapes `plan_zip_import` cannot see. Doing it in the write loop would still be
    // safe, but it would abort halfway and leave a partial library; doing it here keeps the whole
    // operation all-or-nothing.
    let targets = plan
        .files
        .iter()
        .map(|file| {
            let parts: Vec<&str> = file.rel_path.split(RELATIVE_PATH_SEPARATOR).collect();
            safe_join(&root, &parts)
        })
        .collect::<Result<Vec<_>>>()?;

    let mut bytes_extracted: u64 = 0;
    let extraction = (|| -> Result<()> {
        for (index, (file, target)) in plan.files.iter().zip(&targets).enumerate() {
            if let Some(callback) = on_progress.as_deref_mut() {
                callback(&ImportProgress::Extracting {
                    file_index: index + 1,
                    file_count: plan.files.len(),
                    rel_path: file.rel_path.clone(),
                });
            }
            bytes_extracted += extract_entry(&zip, &file.entry, target)?;
        }
        Ok(())
    })();
    if let Err(error) = extraction {
        for name in &plan.project_dirs {
            if let Ok(dir) = safe_join(&root, &[name]) {
                let _ = fs::remove_dir_all(dir);
            }
        }
        return Err(error);
    }
    lib.log().info(
        "extracted a curamanager archive",
        fields![
            "userId" => &ctx.user_id,
            "projects" => plan.project_dirs.len(),
            "files" => plan.files.len(),
            "bytes" => bytes_extracted,
            "strippedRoot" => plan.stripped_root.clone().unwrap_or_default(),
            "skipped" => plan.skipped,
        ],
    );

    let rescan_result = {
        let mut forward = |progress: &RescanProgress| {
            if let Some(callback) = on_progress.as_deref_mut() {
                callback(&ImportProgress::Indexing(progress.clone()));
            }
        };
        rescan(lib, ctx, Some(&mut forward))?
    };
    // Scoped to what this archive brought in: re-running the pass over the whole library would let
    // a stale metadata.json in an older folder overwrite edits made since.
    let sidecars = apply_curamanager_sidecars(lib, ctx, on_progress, Some(&plan.project_dirs))?;

    Ok(ZipImportResultDto {
        projects_extracted: plan.project_dirs.len() as i64,
        files_extracted: plan.files.len() as i64,
        bytes_extracted: i64::try_from(bytes_extracted).unwrap_or(i64::MAX),
        stripped_root: plan.stripped_root,
        skipped: plan.skipped as i64,
        projects_updated: sidecars.projects_updated,
        tags_applied: sidecars.tags_applied,
        rescan: rescan_result,
    })
}
