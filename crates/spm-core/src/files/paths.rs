//! Where things live on disk, and the one function every user-supplied path goes through.

use std::path::{Component, Path, PathBuf};

use crate::db::{Library, PREVIEWS_DIR, SPM_DIR};
use crate::error::{AppError, Result};

fn illegal(segment: &str) -> AppError {
    AppError::forbidden(format!("illegal path segment: {segment}"))
}

/// Joins `segments` under `base` and refuses anything that escapes it. Every path built from
/// user-supplied text goes through here.
///
/// A segment is refused when it is empty, absolute or rooted (on any platform: `/x`, `\x`, `C:\x`),
/// or contains a `..` part. `/` and `\` both separate parts on every platform, so a traversal
/// written with backslashes is judged the same way on Linux as on Windows. The check is lexical
/// and touches no file system, so it works for paths that do not exist yet.
pub fn safe_join(base: &Path, segments: &[&str]) -> Result<PathBuf> {
    for segment in segments {
        let path = Path::new(segment);
        let rooted = path.is_absolute() || path.has_root() || segment.starts_with(['/', '\\']);
        let traversal = segment.split(['/', '\\']).any(|part| part == "..");
        let has_prefix = path
            .components()
            .any(|component| matches!(component, Component::Prefix(_)));
        if segment.is_empty() || rooted || traversal || has_prefix {
            return Err(illegal(segment));
        }
    }
    let root = std::path::absolute(base)?;
    let mut target = root.clone();
    for segment in segments {
        target.extend(
            segment
                .split(['/', '\\'])
                .filter(|part| !part.is_empty() && *part != "."),
        );
    }
    if !target.starts_with(&root) {
        return Err(AppError::forbidden("path escapes the library"));
    }
    Ok(target)
}

/// `library_dir` of `.` means a flat library: project folders sit at the root (spec 2.6).
pub fn user_root(lib: &Library, library_dir: &str) -> Result<PathBuf> {
    if library_dir == "." {
        Ok(lib.dir().to_path_buf())
    } else {
        safe_join(lib.dir(), &[library_dir])
    }
}

pub fn project_dir(lib: &Library, library_dir: &str, dir_name: &str) -> Result<PathBuf> {
    safe_join(&user_root(lib, library_dir)?, &[dir_name])
}

/// `<library>/.spm/previews/<file id>.png`.
pub fn preview_path(lib: &Library, file_id: &str) -> PathBuf {
    lib.dir()
        .join(SPM_DIR)
        .join(PREVIEWS_DIR)
        .join(format!("{file_id}.png"))
}
