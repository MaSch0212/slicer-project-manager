//! `slicers.json`: what the shell knows about the slicers on this machine.
//!
//! **Its own file, beside `state.json` and not inside it** (D decision 4). `state.json` is three
//! keys written when a user answers a question about which library there is; this is a list
//! rewritten by every detection scan and every binding change. They share a writer
//! ([`crate::json_store`]) and not a file, so one corrupt write costs the user their slicer
//! bindings or their library choice, never both.
//!
//! **The stored identity of an install is its origin key; the path is a hint** (spec 4.4). An MSIX
//! install path embeds its version, so a cached path breaks silently on the next update. Every
//! launch `stat`s the hint first and re-resolves from the origin key on any mismatch
//! ([`resolve_install_path`]).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use spm_core::AppError;
use spm_core::dto::{
    SlicerConfigDto, SlicerId, SlicerInstallDto, SlicerInstallOrigin, SlicerInstallState,
};

use super::detect::{DetectedInstall, InstallOrigin};
use super::registry::{SLICER_IDS, slicer};
use super::winpath;
use crate::json_store::write_json_file;

/// The file under the app's data directory.
pub const SLICERS_FILE_NAME: &str = "slicers.json";

/// The only shape this build can read. A file written by a newer build is *recognised as
/// unreadable* rather than misread: the app runs with no configured installs, says so, and refuses
/// to write over the file until the user explicitly resets it.
pub const SLICERS_CONFIG_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredInstall {
    pub id: String,
    pub slicer_id: SlicerId,
    pub label: String,
    pub origin: InstallOrigin,
    pub version: Option<String>,
    /// The last known path. A hint, re-checked before every use: never the identity.
    pub path_hint: String,
    pub added_at: i64,
    /// Set when the hint failed and re-resolution found nothing. **Absent, not `false`, when the
    /// install is fine**, so a healthy file is byte-identical to one written before this field
    /// existed and a scan that changes nothing changes no bytes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicersConfig {
    pub version: i64,
    pub installs: Vec<StoredInstall>,
    pub bindings: BTreeMap<SlicerId, String>,
    pub default_slicer_id: Option<SlicerId>,
}

/// What a read produced, and whether the file may be written back.
///
/// `writable` is false for exactly one reason: an unrecognised `version`. Every other degradation
/// (no file, unparseable, a member of the wrong type) produces an empty config that *is* writable,
/// because there is nothing there worth protecting. `warnings` is what the read has to say, for the
/// caller to log: a read failure that leaves the user's configuration apparently forgotten must
/// not be silent.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigRead {
    pub config: SlicersConfig,
    pub writable: bool,
    pub warnings: Vec<String>,
}

pub fn empty_config() -> SlicersConfig {
    SlicersConfig {
        version: SLICERS_CONFIG_VERSION,
        installs: Vec::new(),
        bindings: BTreeMap::new(),
        default_slicer_id: None,
    }
}

fn parse_origin(value: Option<&Value>) -> Option<InstallOrigin> {
    let origin = value?.as_object()?;
    let text = |key: &str| origin.get(key).and_then(Value::as_str).map(str::to_owned);
    match origin.get("kind")?.as_str()? {
        "registry" => Some(InstallOrigin::Registry {
            hive: text("hive")?,
            key: text("key")?,
        }),
        "msix" => Some(InstallOrigin::Msix {
            package_family: text("packageFamily")?,
        }),
        "manual" => Some(InstallOrigin::Manual { id: text("id")? }),
        _ => None,
    }
}

fn slicer_id_of(value: Option<&Value>) -> Option<SlicerId> {
    SlicerId::parse(value?.as_str()?)
}

/// One stored install, or `None` if it is not one. Every member is checked and a row that fails
/// any check is dropped rather than repaired: this file is hand-editable and a half-understood row
/// would flow straight into a spawn argument.
fn parse_install(value: &Value) -> Option<StoredInstall> {
    let row = value.as_object()?;
    let id = row.get("id")?.as_str().filter(|id| !id.is_empty())?;
    let path_hint = row
        .get("pathHint")?
        .as_str()
        .filter(|path| !path.is_empty())?;
    let added_at = row.get("addedAt")?;
    if !added_at.is_number() {
        return None;
    }
    Some(StoredInstall {
        id: id.to_owned(),
        slicer_id: slicer_id_of(row.get("slicerId"))?,
        label: row.get("label")?.as_str()?.to_owned(),
        origin: parse_origin(row.get("origin"))?,
        version: row
            .get("version")
            .and_then(Value::as_str)
            .filter(|version| !version.is_empty())
            .map(str::to_owned),
        path_hint: path_hint.to_owned(),
        added_at: added_at
            .as_i64()
            .or_else(|| added_at.as_f64().map(|n| n as i64))?,
        missing: row.get("missing") == Some(&Value::Bool(true)),
    })
}

fn parse_bindings(value: Option<&Value>, installs: &[StoredInstall]) -> BTreeMap<SlicerId, String> {
    let mut bindings = BTreeMap::new();
    let Some(raw) = value.and_then(Value::as_object) else {
        return bindings;
    };
    for (slicer_name, install_id) in raw {
        let (Some(slicer_id), Some(install_id)) =
            (SlicerId::parse(slicer_name), install_id.as_str())
        else {
            continue;
        };
        // A binding to an install that is not in the file is not a binding: it would make
        // `resolve_install` answer `NotFound` for a slicer the UI shows as configured.
        if installs
            .iter()
            .any(|install| install.id == install_id && install.slicer_id == slicer_id)
        {
            bindings.insert(slicer_id, install_id.to_owned());
        }
    }
    bindings
}

/// Reads `slicers.json`, degrading rather than throwing.
///
/// Three degradations, and they are not the same. **Missing** is first run and says nothing (any
/// other read failure is a warning). **Unparseable** degrades to no configuration with a warning
/// and stays writable: the next scan replaces it. **A version this build does not know** degrades
/// to no configuration and is **not writable**.
pub fn read_config(file: &Path) -> ConfigRead {
    let mut warnings = Vec::new();
    let degraded = |warnings: Vec<String>, writable: bool| ConfigRead {
        config: empty_config(),
        writable,
        warnings,
    };
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                warnings.push(format!("could not read {SLICERS_FILE_NAME}: {error}"));
            }
            return degraded(warnings, true);
        }
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(parsed) => parsed,
        Err(error) => {
            warnings.push(format!(
                "ignoring an unreadable {SLICERS_FILE_NAME}: {error}"
            ));
            return degraded(warnings, true);
        }
    };
    let Some(document) = parsed.as_object() else {
        warnings.push(format!("ignoring an unreadable {SLICERS_FILE_NAME}"));
        return degraded(warnings, true);
    };
    if document.get("version") != Some(&Value::from(SLICERS_CONFIG_VERSION)) {
        let seen = document
            .get("version")
            .map_or_else(|| "undefined".to_owned(), ToString::to_string);
        warnings.push(format!(
            "{SLICERS_FILE_NAME} is version {seen}, and this build reads version \
             {SLICERS_CONFIG_VERSION}; running with no configured slicers and leaving the file alone"
        ));
        return degraded(warnings, false);
    }
    let installs: Vec<StoredInstall> = document
        .get("installs")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(parse_install).collect())
        .unwrap_or_default();
    let bindings = parse_bindings(document.get("bindings"), &installs);
    ConfigRead {
        config: SlicersConfig {
            version: SLICERS_CONFIG_VERSION,
            installs,
            bindings,
            default_slicer_id: slicer_id_of(document.get("defaultSlicerId")),
        },
        writable: true,
        warnings,
    }
}

/// Replaces `slicers.json` through the shared atomic writer.
pub fn write_config(file: &Path, config: &SlicersConfig) -> std::io::Result<()> {
    let value = serde_json::to_value(config).map_err(std::io::Error::other)?;
    write_json_file(file, &value)
}

/// The result of a scan, folded into the existing configuration.
///
/// - **New installs are added**, stamped with the scan; a re-detected one keeps its `added_at`,
///   so the list does not reorder itself.
/// - **An install that no longer resolves is marked `missing`, never dropped**, so a binding to it
///   survives and the page can say "the install you chose is gone".
/// - **Manual entries are never touched**: detection did not find them because it never could.
/// - **An existing binding is never re-pointed.**
///
/// And one *change*: a product with exactly one usable install and no binding is bound to it,
/// because there is nothing to choose. A product with two is left unbound and the UI asks. **The
/// app offers; it does not guess.**
pub fn merge_detected(
    existing: &SlicersConfig,
    detected: &[DetectedInstall],
    now: i64,
) -> SlicersConfig {
    let detected_ids: std::collections::HashSet<&str> =
        detected.iter().map(|install| install.id.as_str()).collect();
    let mut installs: Vec<StoredInstall> = existing
        .installs
        .iter()
        .map(|install| {
            if matches!(install.origin, InstallOrigin::Manual { .. })
                || detected_ids.contains(install.id.as_str())
            {
                install.clone()
            } else {
                StoredInstall {
                    missing: true,
                    ..install.clone()
                }
            }
        })
        .collect();

    for found in detected {
        let previous = existing
            .installs
            .iter()
            .find(|install| install.id == found.id);
        let merged = StoredInstall {
            id: found.id.clone(),
            slicer_id: found.slicer_id,
            label: found.label.clone(),
            origin: found.origin.clone(),
            version: found.version.clone(),
            path_hint: found.path.clone(),
            added_at: previous.map_or(now, |previous| previous.added_at),
            missing: false,
        };
        match installs.iter().position(|install| install.id == found.id) {
            Some(at) => installs[at] = merged,
            None => installs.push(merged),
        }
    }

    let bindings = auto_bind(&existing.bindings, &installs);
    SlicersConfig {
        version: SLICERS_CONFIG_VERSION,
        installs,
        bindings,
        default_slicer_id: existing.default_slicer_id,
    }
}

/// Fills in the bindings there is no choice about, and touches nothing else.
pub fn auto_bind(
    existing: &BTreeMap<SlicerId, String>,
    installs: &[StoredInstall],
) -> BTreeMap<SlicerId, String> {
    let mut bindings = existing.clone();
    for slicer_id in SLICER_IDS {
        if bindings.contains_key(&slicer_id) {
            continue;
        }
        let mut candidates = installs
            .iter()
            .filter(|install| install.slicer_id == slicer_id && !install.missing);
        if let (Some(only), None) = (candidates.next(), candidates.next()) {
            bindings.insert(slicer_id, only.id.clone());
        }
    }
    bindings
}

/// What resolving an install needs from the machine.
pub trait ResolveIo {
    fn is_regular_file(&self, path: &str) -> bool;
    /// Re-runs detection and answers with the path this install's origin key resolves to now.
    /// `Err` is a detection that could not run, which is not an install that is gone.
    fn reresolve(&self, install: &StoredInstall) -> Result<Option<String>, AppError>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResolveOutcome {
    Found { path: String },
    Unknown,
    Missing,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolveResult {
    pub outcome: ResolveOutcome,
    pub config: SlicersConfig,
    pub changed: bool,
}

/// Whether the stored hint still names the executable this install is supposed to be. The
/// `exe_name` check applies to the two automatic origins and **not to a manual entry**: the user
/// named that path. The file-exists check applies to all three.
fn hint_still_good(install: &StoredInstall, io: &dyn ResolveIo) -> bool {
    if !io.is_regular_file(&install.path_hint) {
        return false;
    }
    if matches!(install.origin, InstallOrigin::Manual { .. }) {
        return true;
    }
    winpath::basename(&install.path_hint)
        .eq_ignore_ascii_case(slicer(install.slicer_id).windows.exe_name)
}

/// The path to spawn for `install_id`, re-resolving from the origin key when the hint has gone
/// bad.
///
/// **The common case costs one `stat` and no subprocess.** The uncommon case (an Orca update that
/// moved the install, or a slicer uninstalled since the last scan) costs one PowerShell run at the
/// moment of the next launch. A manual install is never re-resolved: its origin key is a generated
/// id, not a machine fact, so a manual entry whose file has gone is `missing` immediately.
///
/// Returns the configuration rather than writing it, and says whether it changed, so the one
/// place that owns the file is the one place that writes it.
pub fn resolve_install_path(
    config: &SlicersConfig,
    install_id: &str,
    io: &dyn ResolveIo,
) -> Result<ResolveResult, AppError> {
    let Some(install) = config
        .installs
        .iter()
        .find(|candidate| candidate.id == install_id)
    else {
        return Ok(ResolveResult {
            outcome: ResolveOutcome::Unknown,
            config: config.clone(),
            changed: false,
        });
    };

    if hint_still_good(install, io) {
        // Nothing to write, even if the install was marked missing by an earlier scan and has come
        // back: clearing the mark is a scan's job, and a launch that rewrote the file would make
        // every launch a write.
        return Ok(ResolveResult {
            outcome: ResolveOutcome::Found {
                path: install.path_hint.clone(),
            },
            config: config.clone(),
            changed: false,
        });
    }

    let reresolved = if matches!(install.origin, InstallOrigin::Manual { .. }) {
        None
    } else {
        io.reresolve(install)?
    };
    // **`stat`ed again, and the same `stat` the hint got**: this is the last line before a spawn
    // and the answer came out of a subprocess.
    let found = reresolved.filter(|path| io.is_regular_file(path));
    let replaced = match &found {
        None => StoredInstall {
            missing: true,
            ..install.clone()
        },
        Some(path) => StoredInstall {
            path_hint: path.clone(),
            missing: false,
            ..install.clone()
        },
    };
    let next = SlicersConfig {
        installs: config
            .installs
            .iter()
            .map(|candidate| {
                if candidate.id == install_id {
                    replaced.clone()
                } else {
                    candidate.clone()
                }
            })
            .collect(),
        ..config.clone()
    };
    Ok(ResolveResult {
        outcome: match found {
            None => ResolveOutcome::Missing,
            Some(path) => ResolveOutcome::Found { path },
        },
        config: next,
        changed: true,
    })
}

pub fn to_install_dto(install: &StoredInstall) -> SlicerInstallDto {
    SlicerInstallDto {
        id: install.id.clone(),
        slicer_id: install.slicer_id,
        label: install.label.clone(),
        version: install.version.clone(),
        path: install.path_hint.clone(),
        origin: match install.origin {
            InstallOrigin::Registry { .. } => SlicerInstallOrigin::Registry,
            InstallOrigin::Msix { .. } => SlicerInstallOrigin::Msix,
            InstallOrigin::Manual { .. } => SlicerInstallOrigin::Manual,
        },
        state: if install.missing {
            SlicerInstallState::Missing
        } else {
            SlicerInstallState::Ok
        },
    }
}

pub fn to_config_dto(config: &SlicersConfig, detection_supported: bool) -> SlicerConfigDto {
    SlicerConfigDto {
        installs: config.installs.iter().map(to_install_dto).collect(),
        bindings: config.bindings.clone(),
        default_slicer_id: config.default_slicer_id,
        detection_supported,
    }
}

/// A map keyed by product name, for tests that compare against JSON.
pub fn bindings_json(bindings: &BTreeMap<SlicerId, String>) -> Value {
    let mut map = Map::new();
    for (slicer_id, install_id) in bindings {
        map.insert(
            slicer_id.as_str().to_owned(),
            Value::from(install_id.as_str()),
        );
    }
    Value::Object(map)
}
