//! Removing a `.3mf`'s embedded slicer configuration, so a file used to *start a new project* does
//! not carry someone else's print settings into it. Desktop only (feature `desktop`).
//!
//! **This is the one authoritative home for a strip set.** The sets are indexed by the flavour of
//! the *file*, never by the slicer being launched: what can be removed is whatever the authoring
//! slicer put in, and the launched slicer only decides what the user then sees. That is also why
//! the sets cannot live on a [`SlicerId`]-keyed registry row: one of the four cases is a
//! classification with no `SlicerId` at all.
//!
//! # What the measurements say this buys, and what they do not
//!
//! Carried from the subsystem D launch-facts spike, **not** from any test in this repo: the repo
//! has no real slicer fixtures at all, so nothing here can show that a stripped file stops a slicer
//! prompting.
//!
//! * **Cura**: the "Summary - Cura Project" prompt disappears entirely.
//! * **Anycubic**: this is the headline. A Bambu-lineage `.3mf` that Anycubic *silently discarded*
//!   (window open, plate empty, no dialog and no error) loads cleanly once stripped. Stripping is
//!   not prompt suppression here; it is what makes cross-slicer project creation work at all.
//! * **Orca**: two modals become one, and the survivor is informational.
//! * **PrusaSlicer**: nothing. Its four-way dialog is a function of the `.3mf` extension.
//! * **Bambu**: nothing. Its modal fires on the *absence* of its own `project_settings.config`.
//!
//! Even where the prompt stays, the strip still does the job asked of it: the file carries no
//! foreign print configuration, so a user who clicks through gets their own settings.
//!
//! # Never half-strip
//!
//! Removing `slice_info.config` alone was measured to leave the foreign printer and filament
//! presets in place *and* produce a file `classify_3mf` calls `slicer_project` with `slicer: None`,
//! worse than either endpoint. So the strip is all-or-nothing per flavour, the result is
//! **re-classified at run time**, and anything that is not `model` is a refusal rather than a
//! degraded launch. That check is not theoretical: a `.3mf` carrying both `Cura/*` and
//! `Metadata/Slic3r_PE.config` classifies `cura` (first match wins), gets the Cura set, and comes
//! out `prusaslicer`.
//!
//! A refusal never falls back to launching the original (for Anycubic that fallback *is* the
//! silent-discard case) and it always names which of three problems it was, because they have
//! three different next moves.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};

use super::classify::{Classification, classify_3mf};
use super::zip::{decode_utf8, open_zip};
use super::zip_write::{ZipRewrite, rewrite_zip};
use crate::dto::{FileKind, SlicerId};
use crate::error::{AppError, Result};

/// Every entry under this prefix, for a `cura` file. Measured at 15 entries; the prefix is the
/// rule.
const CURA_STRIP_PREFIX: &str = "Cura/";

const PRUSA_STRIP_ENTRIES: [&str; 2] = [
    "Metadata/Slic3r_PE.config",
    "Metadata/Slic3r_PE_model.config",
];

/// One set for the whole Bambu lineage, and it is the wider of the two that were measured:
/// Anycubic ran with all five, Orca with the first three. The five-entry set is a strict superset,
/// the two extra names are per-project data rather than configuration, and the all-or-nothing rule
/// needs exactly one set per flavour to be checkable at all. **Not measured:** the five-entry set
/// in Orca or Bambu.
const BAMBU_LINEAGE_STRIP_ENTRIES: [&str; 5] = [
    "Metadata/slice_info.config",
    "Metadata/project_settings.config",
    "Metadata/model_settings.config",
    "Metadata/custom_gcode_per_layer.xml",
    "Metadata/cut_information.xml",
];

/// Which problem a refusal was. The three have three different next moves, and "could not prepare
/// file" tells the user none of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StripRefusalReason {
    /// An entry the rewriter cannot reproduce without a key.
    Encrypted,
    /// Not a readable ZIP, or an archive the rewriter cannot represent.
    Unreadable,
    /// The strip ran and the result still classifies as a slicer project.
    ConfigurationLeftBehind,
}

impl StripRefusalReason {
    /// The wire spelling, as carried in `details.reason`.
    pub fn as_str(self) -> &'static str {
        match self {
            StripRefusalReason::Encrypted => "encrypted",
            StripRefusalReason::Unreadable => "unreadable",
            StripRefusalReason::ConfigurationLeftBehind => "configuration-left-behind",
        }
    }
}

/// Reads the reason off a refusal raised by [`strip3mf`]; `None` for any other error.
pub fn strip_refusal_reason(error: &AppError) -> Option<StripRefusalReason> {
    let reason = error.details.as_ref()?.get("reason")?.as_str()?;
    [
        StripRefusalReason::Encrypted,
        StripRefusalReason::Unreadable,
        StripRefusalReason::ConfigurationLeftBehind,
    ]
    .into_iter()
    .find(|candidate| candidate.as_str() == reason)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Strip3mfResult {
    /// What the *input* classified as, which is what chose the strip set.
    pub classification: Classification,
    /// Whether anything was actually removed. `false` means the source held no configuration and
    /// the output is a byte-for-byte copy: the caller still has a file it may hand to a slicer.
    pub stripped: bool,
    /// Entry names removed, in archive order.
    pub removed: Vec<String>,
    /// Parts rewritten because they referenced a removed part, in archive order.
    pub rewritten: Vec<String>,
}

fn refusal(reason: StripRefusalReason, message: &str, extra: &[(&str, Value)]) -> AppError {
    let mut details = Map::new();
    for (key, value) in extra {
        details.insert((*key).to_owned(), value.clone());
    }
    details.insert("reason".into(), Value::from(reason.as_str()));
    AppError::validation(message).with_details(details)
}

fn classification_json(classification: &Classification) -> Value {
    let mut map = Map::new();
    map.insert("kind".into(), Value::from(classification.kind.as_str()));
    map.insert(
        "slicer".into(),
        classification
            .slicer
            .map_or(Value::Null, |slicer| Value::from(slicer.as_str())),
    );
    Value::Object(map)
}

/// Writes a stripped copy of `input` at `output`, or refuses.
///
/// Thumbnails and plate images (`plate_*.png`, `pick_*.png`, `top_*.png`,
/// `Metadata/thumbnail.png`) are **kept**. That is not incidental: the embedded-thumbnail fast path
/// is what gives essentially every project file a preview without rendering, so a strip that
/// discarded the artwork would cost real UI.
///
/// Refuses with a `Validation` error whose `details.reason` is a [`StripRefusalReason`]. Nothing is
/// left at `output` when it refuses.
pub fn strip3mf(input: &Path, output: &Path) -> Result<Strip3mfResult> {
    if same_file(input, output) {
        // Not defensive padding: the rewriter creates the output, which truncates it, while it is
        // still reading compressed bytes out of the input. In place, that destroys the source.
        return Err(refusal(
            StripRefusalReason::Unreadable,
            "a 3MF cannot be stripped onto itself",
            &[("path", Value::from(input.to_string_lossy().as_ref()))],
        ));
    }
    let classification = classify_3mf(input);
    if classification.kind == FileKind::Other {
        return Err(refusal(
            StripRefusalReason::Unreadable,
            "file is not a readable 3MF archive",
            &[("path", Value::from(input.to_string_lossy().as_ref()))],
        ));
    }

    let outcome = strip_into(input, output, classification).and_then(|result| {
        // The run-time half of the never-half-strip rule. Re-reads the file that was just written
        // rather than reasoning about the set that was removed, because the trap is a file
        // carrying two flavours' entries and only one flavour's set having been applied to it.
        let after = classify_3mf(output);
        if after.kind == FileKind::Model {
            Ok(result)
        } else {
            Err(refusal(
                StripRefusalReason::ConfigurationLeftBehind,
                "stripping left slicer configuration in the file",
                &[
                    ("was", classification_json(&classification)),
                    ("after", classification_json(&after)),
                ],
            ))
        }
    });
    match outcome {
        Ok(result) => Ok(result),
        Err(error) => {
            discard(output);
            // Two of `rewrite_zip`'s four reasons (`encrypted` and `unreadable`) are already among
            // the three a user is told, so they travel unchanged. Its `unrepresentable` and
            // `invalid-request` are not, and land in `unreadable` below with everything else.
            if strip_refusal_reason(&error).is_some() {
                return Err(error);
            }
            Err(refusal(
                StripRefusalReason::Unreadable,
                "the 3MF could not be rewritten",
                &[("cause", Value::from(error.to_string()))],
            ))
        }
    }
}

/// Whether both paths name one file, by spelling or (when both exist) by identity.
fn same_file(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn strip_into(
    input: &Path,
    output: &Path,
    classification: Classification,
) -> Result<Strip3mfResult> {
    let zip = open_zip(input)?;
    let names: Vec<&str> = zip
        .entries()
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    let removed_set: std::collections::HashSet<String> =
        strip_set_for(&classification, &names).into_iter().collect();
    if removed_set.is_empty() {
        // Nothing to remove, so nothing is rebuilt: the copy is byte-for-byte the source. A
        // `model` source reaches here, and so does the theoretical project whose set is entirely
        // absent.
        fs::copy(input, output)?;
        return Ok(Strip3mfResult {
            classification,
            stripped: false,
            removed: Vec::new(),
            rewritten: Vec::new(),
        });
    }

    let mut replace = std::collections::HashMap::new();
    for entry in zip.entries() {
        if removed_set.contains(&entry.name) || !is_referencing_part(&entry.name) {
            continue;
        }
        let original = decode_utf8(&zip.read(entry)?);
        let repaired = repair_references(&entry.name, &original, &removed_set);
        // Checked on the text that will actually be written, repaired or not. See
        // `dangling_reference`: this is what makes the guarantee hold for XML shapes the two
        // element patterns do not match, rather than only for the shapes they were written
        // against.
        let dangling = dangling_reference(
            &entry.name,
            repaired.as_deref().unwrap_or(&original),
            &removed_set,
        );
        if let Some(target) = dangling {
            return Err(refusal(
                StripRefusalReason::ConfigurationLeftBehind,
                "stripping left a reference to a part it removed",
                &[
                    ("part", Value::from(entry.name.as_str())),
                    ("target", Value::from(target)),
                ],
            ));
        }
        if let Some(repaired) = repaired {
            replace.insert(entry.name.clone(), repaired.into_bytes());
        }
    }

    drop(zip);
    let written = rewrite_zip(
        input,
        output,
        &ZipRewrite {
            drop: removed_set,
            replace,
        },
    )?;
    Ok(Strip3mfResult {
        classification,
        stripped: true,
        removed: written.dropped,
        rewritten: written.replaced,
    })
}

fn strip_set_for(classification: &Classification, names: &[&str]) -> Vec<String> {
    if classification.kind == FileKind::Model {
        return Vec::new();
    }
    let present = |wanted: &[&str]| -> Vec<String> {
        wanted
            .iter()
            .filter(|name| names.contains(name))
            .map(|name| (*name).to_owned())
            .collect()
    };
    match classification.slicer {
        Some(SlicerId::Cura) => names
            .iter()
            .filter(|name| name.starts_with(CURA_STRIP_PREFIX))
            .map(|name| (*name).to_owned())
            .collect(),
        Some(SlicerId::Prusaslicer) => present(&PRUSA_STRIP_ENTRIES),
        // `anycubic`, `bambu`, `orca` and the rule-4 `slicer: None` case (a project saved but
        // never sliced) share one set. Rule 4 matched on `project_settings.config`, and only the
        // lineage writes it.
        Some(SlicerId::Anycubic | SlicerId::Bambu | SlicerId::Orca) | None => {
            present(&BAMBU_LINEAGE_STRIP_ENTRIES)
        }
    }
}

const CONTENT_TYPES: &str = "[Content_Types].xml";

/// The only two kinds of part that can name another part by name.
fn is_referencing_part(name: &str) -> bool {
    name == CONTENT_TYPES || is_rels_part(name)
}

/// A part in a `_rels` directory. Every `.3mf` measured actually holds `_rels/.rels`, and OPC's
/// own name for a part's relationships is `<dir>/_rels/<part>.rels`. Matching the directory rather
/// than an extension covers both: `(?:^|/)_rels/[^/]+$`.
fn is_rels_part(name: &str) -> bool {
    let mut parts = name.rsplit('/');
    matches!(
        (parts.next(), parts.next()),
        (Some(file), Some("_rels")) if !file.is_empty()
    )
}

/// An optional namespace prefix: `<r:Relationship>` is legal OPC and no measured file uses one.
/// The `\b` after the element name is what keeps `<Relationships>`, the plural root element, from
/// matching: there is no word boundary between `p` and `s`. ASCII-only, as the original was.
const PREFIX: &str = r"(?:[A-Za-z_][A-Za-z0-9_.-]*:)?";

static RELATIONSHIP_ELEMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"<{PREFIX}Relationship(?-u:\b)[^>]*?(?:/>|>[\s\S]*?</{PREFIX}Relationship\s*>)"
    ))
    .expect("a valid pattern")
});

static OVERRIDE_ELEMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"<{PREFIX}Override(?-u:\b)[^>]*?(?:/>|>[\s\S]*?</{PREFIX}Override\s*>)"
    ))
    .expect("a valid pattern")
});

/// The two OPC attributes that can name a part, wherever they appear. Deliberately blind to the
/// element around them: that is what lets [`dangling_reference`] see a reference an element
/// pattern missed.
static PART_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?-u:\b)(?:Target|PartName)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
        .expect("a valid pattern")
});

fn attribute_pattern(name: &str) -> Regex {
    Regex::new(&format!(r#"(?-u:\b){name}\s*=\s*(?:"([^"]*)"|'([^']*)')"#))
        .expect("a valid pattern")
}

static TARGET_ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| attribute_pattern("Target"));
static PART_NAME_ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| attribute_pattern("PartName"));
static TARGET_MODE_ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| attribute_pattern("TargetMode"));

fn attribute(element: &str, pattern: &Regex) -> Option<String> {
    let captures = pattern.captures(element)?;
    captures
        .get(1)
        .or_else(|| captures.get(2))
        .map(|value| value.as_str().to_owned())
}

/// Returns the repaired text of one part, or `None` when the part needs no repair.
///
/// * **`_rels` parts.** Any `<Relationship>` whose `Target` resolves to a removed part is dropped.
/// * **`[Content_Types].xml`.** Any `<Override PartName="...">` naming a removed part is dropped.
///   In all five measured flavours this fires on nothing at all, because they declare `Default
///   Extension` entries only, but "five files did not need it" is not "the format does not
///   require it", so it is checked rather than assumed.
///
/// Every other part is left alone; the strip never rewrites a payload.
///
/// **What the element patterns do and do not match, probed rather than assumed.** Attributes in
/// any order, single or double quotes, the self-closing and the paired forms, an XML comment in
/// the way, a percent-encoded target and a namespace prefix are all repaired. A `>` inside an
/// attribute value is **not** matched and is not repaired: `[^>]*?` stops at it, and a real
/// attribute grammar means an XML parser.
///
/// That last shape is why [`dangling_reference`] exists and why this function is not the
/// guarantee. A pattern that silently matches nothing produces an archive whose relationship names
/// a part that is gone, reported as success, which is worse than a mis-edit, because there is no
/// signal at all. The outcome check is what turns that into a refusal.
fn repair_references(
    name: &str,
    text: &str,
    removed: &std::collections::HashSet<String>,
) -> Option<String> {
    if name == CONTENT_TYPES {
        return drop_elements(text, &OVERRIDE_ELEMENT, |element| {
            let Some(declared) = attribute(element, &PART_NAME_ATTRIBUTE) else {
                return false;
            };
            resolve_part_name(name, &declared).is_some_and(|part| removed.contains(&part))
        });
    }
    drop_elements(text, &RELATIONSHIP_ELEMENT, |element| {
        // An external relationship names a URI, not a part, so it can never be one of the removed.
        // `dangling_reference` does not make this distinction and cannot: it is blind to the
        // element an attribute sits in. So an external relationship with a *relative* target that
        // resolves onto a removed part is repaired-as-nothing here and then refused there.
        // Contradictory only in appearance: this one is about what is safe to delete, that one
        // about what is safe to ship, and it is listed among that function's known false
        // positives.
        if attribute(element, &TARGET_MODE_ATTRIBUTE).as_deref() == Some("External") {
            return false;
        }
        let Some(target) = attribute(element, &TARGET_ATTRIBUTE) else {
            return false;
        };
        resolve_part_name(name, &target).is_some_and(|part| removed.contains(&part))
    })
}

/// The name of a removed part still referenced by `text`, or `None` when none is.
///
/// A check on the **outcome** rather than on the pattern: it scans for the two attributes that can
/// name a part (wherever they appear, in whatever element, prefixed or not, with or without a `>`
/// in some neighbouring value), resolves each the way a parser would, and asks whether the result
/// is a part this strip removed. A reference that survives becomes a refusal naming the part
/// instead of a success quietly shipping a dangling one.
///
/// **What it covers is narrower than it sounds, and checkable:** any reference written as a
/// `Target=` or `PartName=` attribute whose value a parser would resolve to a removed part,
/// through character references and percent-escapes. A reference carried some other way (a
/// `Target` assembled from an entity-expanded DTD, a namespace this code does not know names
/// parts) would still pass. No measured flavour writes any of that.
///
/// **Known false positives**, all three deliberate: the same attribute text inside **an XML
/// comment**, inside **a CDATA section**, or on **an external relationship with a relative URI**.
/// Erring this way is the safe direction: a refusal that names the part beats the silent success
/// it replaced. Skipping comments and CDATA would mean tracking their nesting, a second partial XML
/// parser beside the one whose partiality caused this finding.
fn dangling_reference(
    name: &str,
    text: &str,
    removed: &std::collections::HashSet<String>,
) -> Option<String> {
    PART_REFERENCE.captures_iter(text).find_map(|captures| {
        let reference = captures.get(1).or_else(|| captures.get(2))?.as_str();
        resolve_part_name(name, reference).filter(|part| removed.contains(part))
    })
}

/// Removes each matching element the predicate accepts; `None` when it accepted none.
fn drop_elements(
    text: &str,
    pattern: &Regex,
    mut accept: impl FnMut(&str) -> bool,
) -> Option<String> {
    let mut changed = false;
    let out = pattern.replace_all(text, |captures: &Captures| {
        let element = &captures[0];
        if accept(element) {
            changed = true;
            String::new()
        } else {
            element.to_owned()
        }
    });
    changed.then(|| out.into_owned())
}

/// The five entities XML predefines. Everything else numeric is handled by code point.
fn named_entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => None,
    }
}

static CHARACTER_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));").expect("a valid pattern")
});

/// What an XML parser hands a consumer for an attribute value: character references resolved.
///
/// Not a nicety. `Target="...custom_gcode_per_layer&#46;xml"` is legal XML naming
/// `...custom_gcode_per_layer.xml`, and it once slipped past both the element patterns and the
/// outcome check: a strip returning success over an archive still naming a removed part. A
/// reference that is not a character (out of range) or an entity that is not defined is left as
/// the literal text it is, the safe direction.
fn decode_character_references(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    CHARACTER_REFERENCE
        .replace_all(text, |captures: &Captures| {
            if let Some(named) = captures.get(3) {
                return named_entity(named.as_str())
                    .map_or_else(|| captures[0].to_owned(), String::from);
            }
            let (digits, radix) = match captures.get(1) {
                Some(decimal) => (decimal.as_str(), 10),
                None => (captures.get(2).map_or("", |hex| hex.as_str()), 16),
            };
            u32::from_str_radix(digits, radix)
                .ok()
                .and_then(char::from_u32)
                .map_or_else(|| captures[0].to_owned(), String::from)
        })
        .into_owned()
}

/// `decodeURIComponent`: percent-escapes resolved, and `None` where it would throw (a bare `%`, or
/// escapes that do not spell UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = bytes.get(at + 1..at + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Whether `text` starts with a URI scheme: `^[a-zA-Z][a-zA-Z0-9+.\-]*:`.
fn has_scheme(text: &str) -> bool {
    let mut chars = text.chars();
    if !chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
    {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// The part name an OPC `Target` or `PartName` refers to, as a ZIP entry name; `None` for anything
/// that does not name a part in this package.
///
/// A `Target` is relative to the directory the `_rels` folder sits in, so `3D/3dmodel.model` in
/// `_rels/.rels` is the root-level part, and the same string in `3D/_rels/x.rels` is
/// `3D/3D/3dmodel.model`. A leading `/` makes it absolute from the package root, which is the form
/// `[Content_Types].xml` always uses.
///
/// **Two decodings, and the order is load-bearing.** XML character references come off first,
/// because that is what a parser resolves before the value is ever a URI, and because `&#46;`
/// contains a `#`, so splitting the fragment first turns `...layer&#46;xml` into `...layer&` and
/// silently loses the extension. Percent-escapes come off second, being a property of the URI the
/// parser produced.
fn resolve_part_name(part_name: &str, reference: &str) -> Option<String> {
    let literal = decode_character_references(reference);
    // An absolute URI (http:, mailto:) names something outside the package.
    if has_scheme(&literal) {
        return None;
    }
    let without_fragment = literal
        .split('#')
        .next()
        .and_then(|text| text.split('?').next())
        .unwrap_or_default();
    // A malformed escape is not a part name we can resolve; compare the raw text instead.
    let decoded =
        decode_uri_component(without_fragment).unwrap_or_else(|| without_fragment.to_owned());
    // Drop the `_rels` segment and the `.rels` file itself to get the base directory.
    let mut base: Vec<&str> = if decoded.starts_with('/') {
        Vec::new()
    } else {
        let parts: Vec<&str> = part_name.split('/').collect();
        parts[..parts.len().saturating_sub(2)].to_vec()
    };
    for segment in decoded.strip_prefix('/').unwrap_or(&decoded).split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                base.pop();
            }
            segment => base.push(segment),
        }
    }
    Some(base.join("/"))
}

fn discard(path: &Path) {
    // Nothing was written, or the platform will not let us; the refusal is what matters.
    let _ = fs::remove_file(path);
}
