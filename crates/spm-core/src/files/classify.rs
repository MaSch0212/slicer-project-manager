//! What a file is, from its name and (for a `.3mf`) its contents (parent spec 3.4).

use std::path::Path;

use super::zip::{find_zip_entry, read_zip_entries, read_zip_entry_text};
use crate::dto::{FileKind, SlicerId};
use crate::error::AppErrorCode;

/// The answer [`classify_file`] gives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Classification {
    pub kind: FileKind,
    pub slicer: Option<SlicerId>,
    /// Set when the `kind` beside it is a **fallback for a file that could not be opened** rather
    /// than something read out of the file's bytes: a slicer holding a `.3mf` open, a permission
    /// error, a path that went away between the walk and the read.
    ///
    /// It exists for rescan's version-mismatch branch, which is the one place that would otherwise
    /// record such a fallback as this classifier's answer and so make a transient failure
    /// permanent. Only [`classify_3mf`] can set it; classification by extension reads no bytes and
    /// cannot fail.
    pub unreadable: bool,
}

impl Classification {
    const fn of(kind: FileKind, slicer: Option<SlicerId>) -> Classification {
        Classification {
            kind,
            slicer,
            unreadable: false,
        }
    }
}

/// Order is load-bearing (spec 3.4). OrcaSlicer's slice_info header is a SUPERSET of Bambu
/// Studio's (it keeps `X-BBL-Client-Type` and adds `OrcaSlicer-Version`), so Orca must be tested
/// first or every Orca project is labelled bambu. Another Orca derivative is one row above
/// `X-BBL-Client-Type`. Matching is on the KEY only; version values are never discriminators.
pub const SLICER_HEADER_REGISTRY: [(&str, SlicerId); 3] = [
    ("X-ACNext-Client-Type", SlicerId::Anycubic),
    ("OrcaSlicer-Version", SlicerId::Orca),
    ("X-BBL-Client-Type", SlicerId::Bambu),
];

/// The slicer a `slice_info.config` names, by its `<header_item key="...">` keys.
pub fn slicer_from_slice_info(xml: &str) -> Option<SlicerId> {
    let keys = header_item_keys(xml);
    SLICER_HEADER_REGISTRY
        .iter()
        .find(|(key, _)| keys.contains(key))
        .map(|&(_, slicer)| slicer)
}

/// Every `key` of `<header_item\s+key="([^"]+)"`, found left to right without overlap.
fn header_item_keys(xml: &str) -> Vec<&str> {
    const TAG: &str = "<header_item";
    let mut keys = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find(TAG) {
        rest = &rest[at + TAG.len()..];
        let after_space = rest.trim_start_matches(is_js_space);
        // At least one whitespace character, then the attribute exactly as written.
        if after_space.len() == rest.len() {
            continue;
        }
        let Some(quoted) = after_space.strip_prefix("key=\"") else {
            continue;
        };
        if let Some(end) = quoted.find('"').filter(|&end| end > 0) {
            keys.push(&quoted[..end]);
            rest = &quoted[end + 1..];
        }
    }
    keys
}

/// The characters a JavaScript `\s` matches.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

/// Classifies a `.3mf` by reading its central directory (and, for the Bambu lineage, one part).
pub fn classify_3mf(path: &Path) -> Classification {
    let entries = match read_zip_entries(path) {
        Ok(entries) => entries,
        // Two failures wearing one shape, and only one of them is an answer.
        //
        // Every way the reader rejects the *contents* (too small for an end-of-central-directory
        // record, no such record, a corrupt directory) is a `Validation` error it raises itself,
        // and it means what it says: this `.3mf` is not a readable zip and not a model we can do
        // anything with. Anything else came out of the open or stat at the top of it (the file is
        // locked, access is denied, it vanished) and says nothing about the contents at all.
        // `unreadable` is what keeps a rescan from filing the second as the first.
        //
        // An unexpected non-`Validation` error lands in the second arm too, deliberately: the cost
        // of that mistake is re-asking the question on the next rescan, and the cost of the other
        // one is a `kind` that is wrong for good.
        Err(error) if error.code == AppErrorCode::Validation => {
            return Classification::of(FileKind::Other, None);
        }
        Err(_) => {
            return Classification {
                unreadable: true,
                ..Classification::of(FileKind::Other, None)
            };
        }
    };

    // 1. Cura
    if entries.iter().any(|entry| entry.name.starts_with("Cura/")) {
        return Classification::of(FileKind::SlicerProject, Some(SlicerId::Cura));
    }
    // 2. PrusaSlicer
    if find_zip_entry(&entries, "Metadata/Slic3r_PE.config").is_some() {
        return Classification::of(FileKind::SlicerProject, Some(SlicerId::Prusaslicer));
    }
    // 3. Bambu lineage: identified only by the slice_info.config header items.
    if let Some(slice_info) = find_zip_entry(&entries, "Metadata/slice_info.config") {
        let slicer = read_zip_entry_text(path, slice_info)
            .ok()
            .and_then(|xml| slicer_from_slice_info(&xml));
        return Classification::of(FileKind::SlicerProject, slicer);
    }
    // 4. Saved but never sliced: still a project, slicer unknown rather than guessed.
    if find_zip_entry(&entries, "Metadata/project_settings.config").is_some() {
        return Classification::of(FileKind::SlicerProject, None);
    }
    // 5. A plain 3MF mesh.
    Classification::of(FileKind::Model, None)
}

/// The extensions that classify as `model` on their name alone. Enumerated by the frozen snapshot
/// in the classifier test, so an addition here with no row there fails.
///
/// A list rather than a chain of `ends_with`, and that is the only reason it exists: a chain is a
/// set no test can read, so adding `.ply` to it would change nothing already asserted and force no
/// new row into the snapshot, the commonest future bump going unnoticed. `.3mf` is deliberately
/// not here; it is a name two entirely different things share, and only [`classify_3mf`] can tell
/// them apart. `.step` and `.stp` stay listed (as models) even though their geometry is not
/// parsed.
pub const MODEL_EXTENSIONS: [&str; 4] = [".stl", ".obj", ".step", ".stp"];

/// What [`classify_file`]'s answers are worth, and the only thing a rescan compares to decide
/// whether to ask again.
///
/// **Bump this in the same commit as any change to what [`classify_file`] returns.** A row records
/// the version that classified it (`files.classified_by`), and a rescan re-runs the classifier
/// exactly when that number is not this one. Without a bump the change is invisible in the field:
/// every existing row still claims to have been classified by the current version, so nothing is
/// re-asked and the new answer reaches only files the library has never seen. The frozen snapshot
/// in the classifier test is what makes forgetting it fail rather than ship.
///
/// A bump costs one extra classification per indexed file on the next rescan, once (a `.3mf`
/// that could not be *opened* on the bump pass is left unstamped on purpose and re-asked until it
/// opens). It does **not** re-hash, and previews are re-pended only for files whose kind actually
/// moved.
///
/// Never 0: that value means "this row predates the mechanism" and is what migration 003
/// backfills.
pub const CLASSIFIER_VERSION: i64 = 1;

/// Routes by extension (case-insensitively) and falls back to `other`.
pub fn classify_file(path: &Path) -> Classification {
    let lower = path.to_string_lossy().to_lowercase();
    if MODEL_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Classification::of(FileKind::Model, None);
    }
    if lower.ends_with(".3mf") {
        return classify_3mf(path);
    }
    Classification::of(FileKind::Other, None)
}
