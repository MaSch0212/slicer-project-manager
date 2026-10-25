//! Every environment variable the server reads, validated in one place at startup.
//!
//! Each resolver is a pure function of the raw string, which is the whole reason this is a module
//! and not a run of `std::env::var` calls in `main`: a validator that reads the environment itself
//! can only be tested by mutating the process's environment, so in practice it is not tested at
//! all. [`read_server_env`] takes the lookup as a parameter.
//!
//! The resolvers *fail*; they do not print or exit. Deciding what an operator sees belongs to
//! `main`, which runs before the logger exists and answers with one sentence and exit status 1
//! rather than a stack trace.
//!
//! `SPM_MAX_STEP_MB` is gone with STEP support (migration spec 4.1). It is **ignored**, not
//! refused: a leftover line in somebody's compose file must not stop the server, and there is no
//! value for it to be validated against. `main` logs a warning when it is set.

use std::path::PathBuf;

use spm_core::log::{DEFAULT_LOG_LEVEL, LogLevelSetting, parse_log_level};
use spm_core::previews::{DEFAULT_CONCURRENCY, DEFAULT_MAX_MESH_BYTES};
use spm_core::{AppError, AppErrorCode};
use spm_http::{normalize_public_origin, resolve_dev_ui_origin};

pub const DEFAULT_PORT: u16 = 8000;
pub const DEFAULT_PREVIEW_INTERVAL_MS: u64 = 30_000;

/// The longest interval accepted: a signed 32-bit millisecond count. The legacy timer clamped
/// anything longer to 1 ms, so the limit stays: the value an operator writes is the same value
/// that was refused before.
pub const MAX_INTERVAL_MS: u64 = 2_147_483_647;

pub const MAX_PREVIEW_CONCURRENCY: u64 = 64;

/// The ceiling on one model's geometry, in megabytes of 1 000 000 bytes. A mesh is one contiguous
/// allocation, and 2 GB is eight times the default and four times the largest model in the
/// reference library, so nothing real is anywhere near it.
pub const MAX_MESH_MB: u64 = 2_048;
pub const DEFAULT_MAX_MESH_MB: u64 = DEFAULT_MAX_MESH_BYTES / 1_000_000;

/// The variable the migration removed.
pub const REMOVED_STEP_VARIABLE: &str = "SPM_MAX_STEP_MB";

fn validation(message: String) -> AppError {
    AppError::new(AppErrorCode::Validation, message)
}

/// A plain run of decimal digits, from 1 to `max`, and nothing else.
///
/// Deliberately stricter than a lenient number parser, which accepts several spellings that are
/// almost certainly mistakes in a compose file or a shell export: an empty string, `" 1000 "`,
/// `"1e3"`, `"0x1f"`, `"+8000"`. The ones that "work" are worse than the ones that do not: an
/// operator who typed a stray space or an exponent gets a value that happens to be right today and
/// no signal that the config is not saying what they think it says. The error quotes the raw
/// value, so invisible whitespace becomes visible at exactly the moment it matters.
///
/// Leading zeros pass (`08000` reads as deliberate padding). A sign passes nowhere: `-1` in
/// particular is the classic "disable it" guess that must not silently mean 0.
fn require_whole_number(name: &str, raw: &str, wanted: &str, max: u64) -> Result<u64, AppError> {
    let digits = !raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit());
    // An all-digit value too long for a u64 is simply above every ceiling here.
    let value = if digits {
        raw.parse::<u64>().unwrap_or(u64::MAX)
    } else {
        0
    };
    if !(1..=max).contains(&value) {
        return Err(validation(format!("{name}=\"{raw}\" is not {wanted}")));
    }
    Ok(value)
}

/// The library root. Required: there is no sensible default, and guessing one would have the
/// server quietly create a library somewhere the operator never looks.
pub fn resolve_library_dir(raw: Option<&str>) -> Result<String, AppError> {
    // Whitespace-only is treated as unset rather than as a directory named " ": it is what an
    // empty line in an env file expands to, and "is required" is the useful message.
    match raw {
        Some(raw) if !raw.trim().is_empty() => Ok(raw.to_owned()),
        _ => Err(validation("SPM_LIBRARY_DIR is required".to_owned())),
    }
}

/// Refused rather than ignored: a typo that silently fell back to the default would look like the
/// logging itself was broken. Unset is not a typo, so it takes the default in silence.
pub fn resolve_log_level(raw: Option<&str>) -> Result<LogLevelSetting, AppError> {
    let Some(value) = raw else {
        return Ok(DEFAULT_LOG_LEVEL);
    };
    parse_log_level(Some(value)).ok_or_else(|| {
        validation(format!(
            "SPM_LOG_LEVEL=\"{value}\" is not a log level. Use one of: silent, error, warn, info, \
             debug, trace"
        ))
    })
}

/// The TCP port to listen on. `0` is refused even though the OS would accept it as "pick any free
/// port": an operator who wrote 0 meant a port, and a server that came up on an unpredictable one
/// would look like it had not come up at all.
pub fn resolve_port(raw: Option<&str>) -> Result<u16, AppError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_PORT);
    };
    let port = require_whole_number(
        "SPM_PORT",
        raw,
        "a TCP port. Expected a whole number from 1 to 65535",
        65_535,
    )?;
    Ok(u16::try_from(port).unwrap_or(u16::MAX))
}

/// How often the preview queue runs. Overridable mainly because 30 seconds is a bad edit-refresh
/// loop for anyone working on previews, and because the e2e suite has to watch a thumbnail appear
/// rather than sit out a tick.
pub fn resolve_preview_interval_ms(raw: Option<&str>) -> Result<u64, AppError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_PREVIEW_INTERVAL_MS);
    };
    require_whole_number(
        "SPM_PREVIEW_INTERVAL_MS",
        raw,
        &format!("a duration. Expected a whole number of milliseconds from 1 to {MAX_INTERVAL_MS}"),
        MAX_INTERVAL_MS,
    )
}

/// How many preview jobs run at once, and therefore how many meshes may be in memory at once.
/// The default is core's own constant, read directly rather than copied, so the two cannot drift.
pub fn resolve_preview_concurrency(raw: Option<&str>) -> Result<usize, AppError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_CONCURRENCY);
    };
    let workers = require_whole_number(
        "SPM_PREVIEW_CONCURRENCY",
        raw,
        "a worker count. Expected a whole number from 1 to 64",
        MAX_PREVIEW_CONCURRENCY,
    )?;
    Ok(usize::try_from(workers).unwrap_or(usize::MAX))
}

/// The ceiling on one model's geometry, as bytes. A backstop, not a filter: it exists so a model
/// declaring a billion degenerate triangles is refused instead of allocating 36 GB. Megabytes
/// rather than bytes because the number an operator arrives at is "about 300 MB".
pub fn resolve_max_mesh_bytes(raw: Option<&str>) -> Result<u64, AppError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_MAX_MESH_BYTES);
    };
    let megabytes = require_whole_number(
        "SPM_MAX_MESH_MB",
        raw,
        &format!("a size. Expected a whole number of megabytes from 1 to {MAX_MESH_MB}"),
        MAX_MESH_MB,
    )?;
    Ok(megabytes * 1_000_000)
}

/// The origin activation links are built on, normalised to a bare origin, or `None` to use the
/// origin of the request that asked for the link. Blank is unset: treating it as an origin would
/// build `/activate#tok` with no host in it at all.
pub fn resolve_public_origin(raw: Option<&str>) -> Result<Option<String>, AppError> {
    match raw.map(str::trim).filter(|trimmed| !trimmed.is_empty()) {
        Some(trimmed) => normalize_public_origin(trimmed).map(Some),
        None => Ok(None),
    }
}

/// Where the web bundle is read from when not from the binary: `None` (unset or empty) means the
/// bundle embedded at build time. An explicit value is resolved against the process's working
/// directory, as it always was, so `SPM_WEB_ROOT=dist` means `./dist`.
pub fn resolve_web_root(raw: Option<&str>) -> Option<PathBuf> {
    let raw = raw.filter(|raw| !raw.is_empty())?;
    let path = PathBuf::from(raw);
    Some(std::path::absolute(&path).unwrap_or(path))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerEnv {
    pub library_dir: String,
    pub level: LogLevelSetting,
    pub port: u16,
    pub preview_interval_ms: u64,
    pub preview_concurrency: usize,
    pub max_mesh_bytes: u64,
    pub dev_ui_origin: Option<String>,
    pub public_origin: Option<String>,
    /// `None` serves the embedded bundle.
    pub web_root: Option<PathBuf>,
}

/// Reads and validates the whole environment, failing with a `Validation` [`AppError`] on the
/// first unusable variable (in the order below).
pub fn read_server_env(get: &dyn Fn(&str) -> Option<String>) -> Result<ServerEnv, AppError> {
    let var = |name: &str| get(name);
    Ok(ServerEnv {
        library_dir: resolve_library_dir(var("SPM_LIBRARY_DIR").as_deref())?,
        level: resolve_log_level(var("SPM_LOG_LEVEL").as_deref())?,
        port: resolve_port(var("SPM_PORT").as_deref())?,
        preview_interval_ms: resolve_preview_interval_ms(
            var("SPM_PREVIEW_INTERVAL_MS").as_deref(),
        )?,
        preview_concurrency: resolve_preview_concurrency(
            var("SPM_PREVIEW_CONCURRENCY").as_deref(),
        )?,
        max_mesh_bytes: resolve_max_mesh_bytes(var("SPM_MAX_MESH_MB").as_deref())?,
        // These two already had validators of their own, next to the features they configure.
        // Called from here so that one function is the answer to "what does this server read from
        // the environment", without moving code that is happier where it is.
        dev_ui_origin: resolve_dev_ui_origin(var("SPM_DEV_UI_ORIGIN").as_deref())?,
        public_origin: resolve_public_origin(var("SPM_PUBLIC_ORIGIN").as_deref())?,
        // Cannot fail: any string is a path, and whether it exists is not knowable here (the
        // bundle may be built after the server starts). Read here anyway, so the list is complete.
        web_root: resolve_web_root(var("SPM_WEB_ROOT").as_deref()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn refuses(variable: &str, raw: &str, result: Result<impl std::fmt::Debug, AppError>) {
        let error = result.expect_err(&format!("{variable}={raw:?} must be refused"));
        assert_eq!(error.code, AppErrorCode::Validation);
        assert!(
            error.message.starts_with(variable),
            "message should lead with the variable name: {}",
            error.message
        );
        // The raw value is echoed in quotes, which is the only way an operator sees that their
        // value has a stray space in it.
        assert!(
            error.message.contains(&format!("\"{raw}\"")),
            "message should quote the value: {}",
            error.message
        );
    }

    #[test]
    fn spm_library_dir_is_required_and_otherwise_taken_verbatim() {
        assert_eq!(
            resolve_library_dir(Some("/srv/library")).unwrap(),
            "/srv/library"
        );
        assert_eq!(
            resolve_library_dir(Some("C:\\models")).unwrap(),
            "C:\\models"
        );
        // Unset and blank are the same mistake from the operator's side.
        for raw in [None, Some(""), Some("   ")] {
            let error = resolve_library_dir(raw).unwrap_err();
            assert_eq!(error.message, "SPM_LIBRARY_DIR is required");
        }
    }

    #[test]
    fn spm_log_level_takes_the_default_when_unset_and_refuses_a_typo() {
        assert_eq!(resolve_log_level(None).unwrap(), LogLevelSetting::Info);
        assert_eq!(
            resolve_log_level(Some("debug")).unwrap(),
            LogLevelSetting::Debug
        );
        assert_eq!(
            resolve_log_level(Some("silent")).unwrap(),
            LogLevelSetting::Silent
        );
        // Case and surrounding whitespace are folded, a deliberate difference from the numeric
        // variables: a level is a word an operator types, not a value copied from a table.
        assert_eq!(
            resolve_log_level(Some(" TRACE ")).unwrap(),
            LogLevelSetting::Trace
        );

        refuses(
            "SPM_LOG_LEVEL",
            "verbose",
            resolve_log_level(Some("verbose")),
        );
        refuses("SPM_LOG_LEVEL", "", resolve_log_level(Some("")));
        // The message has to list the alternatives, or the operator's next guess is another typo.
        let error = resolve_log_level(Some("verbose")).unwrap_err();
        assert!(
            error
                .message
                .contains("silent, error, warn, info, debug, trace"),
            "{}",
            error.message
        );
    }

    #[test]
    fn spm_port_accepts_a_plain_decimal_port_and_nothing_else() {
        assert_eq!(resolve_port(None).unwrap(), DEFAULT_PORT);
        assert_eq!(DEFAULT_PORT, 8000);
        assert_eq!(resolve_port(Some("8000")).unwrap(), 8000);
        assert_eq!(resolve_port(Some("1")).unwrap(), 1);
        assert_eq!(resolve_port(Some("65535")).unwrap(), 65535);
        // Unambiguous in decimal, and padding is deliberate often enough to be worth allowing.
        assert_eq!(resolve_port(Some("08000")).unwrap(), 8000);

        refuses("SPM_PORT", "abc", resolve_port(Some("abc")));
        // Every spelling a lenient number parser quietly accepts.
        for raw in [
            "", " 8000 ", "8e3", "0x1f", "Infinity", "80.5", "+8000", "-1", "8000 ", "\t8000",
        ] {
            refuses("SPM_PORT", raw, resolve_port(Some(raw)));
        }
        // In range for a number, but not a port anyone means.
        refuses("SPM_PORT", "0", resolve_port(Some("0")));
        refuses("SPM_PORT", "65536", resolve_port(Some("65536")));
        // And so large it does not fit any integer type.
        let huge = "9".repeat(40);
        refuses("SPM_PORT", &huge, resolve_port(Some(&huge)));
    }

    #[test]
    fn spm_preview_interval_ms_accepts_a_whole_number_of_milliseconds_in_range() {
        assert_eq!(
            resolve_preview_interval_ms(None).unwrap(),
            DEFAULT_PREVIEW_INTERVAL_MS
        );
        assert_eq!(DEFAULT_PREVIEW_INTERVAL_MS, 30_000);
        assert_eq!(resolve_preview_interval_ms(Some("250")).unwrap(), 250);
        assert_eq!(resolve_preview_interval_ms(Some("1")).unwrap(), 1);
        // Literals, not the constant: expressing the boundary through it would make the pair of
        // assertions below move with it and prove nothing.
        assert_eq!(MAX_INTERVAL_MS, 2_147_483_647);
        assert_eq!(
            resolve_preview_interval_ms(Some("2147483647")).unwrap(),
            2_147_483_647
        );

        for raw in ["", " 1000 ", "1e3", "1.5", "-1", "0", "2147483648"] {
            refuses(
                "SPM_PREVIEW_INTERVAL_MS",
                raw,
                resolve_preview_interval_ms(Some(raw)),
            );
        }
    }

    #[test]
    fn spm_preview_concurrency_accepts_a_worker_count_and_refuses_the_rest() {
        // Against core's constant, not a literal: what this pins is the coupling, that the server
        // reads core's default rather than keeping its own copy.
        assert_eq!(
            resolve_preview_concurrency(None).unwrap(),
            DEFAULT_CONCURRENCY
        );
        assert_eq!(resolve_preview_concurrency(Some("2")).unwrap(), 2);
        assert_eq!(resolve_preview_concurrency(Some("64")).unwrap(), 64);

        // Zero workers is not "pause the queue", it is a queue that silently never runs, and 65
        // is 65 meshes in memory at once.
        for raw in ["", " 2 ", "2.5", "-1", "0", "65"] {
            refuses(
                "SPM_PREVIEW_CONCURRENCY",
                raw,
                resolve_preview_concurrency(Some(raw)),
            );
        }
    }

    #[test]
    fn spm_max_mesh_mb_accepts_whole_megabytes_and_converts_them_to_bytes() {
        assert_eq!(
            resolve_max_mesh_bytes(None).unwrap(),
            DEFAULT_MAX_MESH_MB * 1_000_000
        );
        // The measured default: the largest mesh in the reference library needs 208.8 MB, so a
        // default below that would refuse a file the user owns.
        assert_eq!(DEFAULT_MAX_MESH_MB, 256);
        assert_eq!(resolve_max_mesh_bytes(Some("300")).unwrap(), 300_000_000);
        assert_eq!(resolve_max_mesh_bytes(Some("1")).unwrap(), 1_000_000);
        assert_eq!(MAX_MESH_MB, 2_048);
        assert_eq!(resolve_max_mesh_bytes(Some("2048")).unwrap(), 2_048_000_000);

        // Zero permits no mesh at all, which would fail every preview with a message about sizes.
        for raw in ["", " 300 ", "256MB", "2.5", "-1", "0", "2049"] {
            refuses("SPM_MAX_MESH_MB", raw, resolve_max_mesh_bytes(Some(raw)));
        }
    }

    /// `[STEP]` in the legacy suite: `SPM_MAX_STEP_MB accepts whole megabytes and converts them to
    /// bytes`. STEP previews are gone (migration spec 4.1), and so is the variable: it is
    /// *ignored*, which is what this pins, so that nobody re-adds a validator for it by accident.
    #[test]
    fn spm_max_step_mb_is_ignored_not_validated() {
        for raw in ["40", "", " 40 ", "ten", "0", "2049", "-1"] {
            let env: HashMap<&str, &str> = [
                ("SPM_LIBRARY_DIR", "/srv/library"),
                (REMOVED_STEP_VARIABLE, raw),
            ]
            .into_iter()
            .collect();
            let read = read_server_env(&|name| env.get(name).map(|value| (*value).to_owned()));
            assert!(
                read.is_ok(),
                "SPM_MAX_STEP_MB={raw:?} stopped the server: {read:?}"
            );
        }
        assert_eq!(REMOVED_STEP_VARIABLE, "SPM_MAX_STEP_MB");
    }

    #[test]
    fn spm_public_origin_is_normalised_to_a_bare_origin_and_blank_means_unset() {
        assert_eq!(
            resolve_public_origin(Some("https://print.example.com/spm?x=1")).unwrap(),
            Some("https://print.example.com".to_owned())
        );
        assert_eq!(
            resolve_public_origin(Some("https://print.example.com:8443")).unwrap(),
            Some("https://print.example.com:8443".to_owned())
        );

        // Unset and blank both fall back to the request's own origin.
        for raw in [None, Some(""), Some("   ")] {
            assert_eq!(resolve_public_origin(raw).unwrap(), None);
        }

        // Loud at startup beats quietly emitting http:// activation links nobody notices until
        // the Secure session cookie is dropped and the user is activated but not signed in. Not
        // `refuses`: this message appends the URL bare rather than in quotes, which is consistent
        // with SPM_DEV_UI_ORIGIN's, and loses nothing since both are trimmed before validation.
        for raw in [
            "print.example.com",
            "ftp://print.example.com",
            "not a url at all",
        ] {
            let error = resolve_public_origin(Some(raw)).unwrap_err();
            assert_eq!(error.code, AppErrorCode::Validation);
            assert!(
                error.message.starts_with("SPM_PUBLIC_ORIGIN"),
                "{}",
                error.message
            );
            assert!(error.message.contains(raw), "{}", error.message);
        }
    }

    #[test]
    fn the_default_web_root_is_the_embedded_bundle_not_a_path_relative_to_the_cwd() {
        // The legacy default was a path relative to the source file, because a default relative
        // to the working directory resolved somewhere else and the whole UI answered 404. There
        // is no path now: unset is the bundle compiled into the binary, which no working
        // directory can move.
        assert_eq!(resolve_web_root(None), None);
        assert_eq!(resolve_web_root(Some("")), None);
    }

    #[test]
    fn an_explicit_spm_web_root_stays_relative_to_the_process_cwd() {
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            resolve_web_root(Some("dist/web/browser")),
            Some(cwd.join("dist/web/browser"))
        );
        let absolute = std::env::temp_dir().join("bundle");
        assert_eq!(
            resolve_web_root(Some(absolute.to_str().unwrap())),
            Some(absolute)
        );
    }

    #[test]
    fn read_server_env_resolves_every_variable_defaulting_the_optional_ones() {
        let defaults =
            read_server_env(&|name| (name == "SPM_LIBRARY_DIR").then(|| "/srv/library".to_owned()))
                .unwrap();
        assert_eq!(
            defaults,
            ServerEnv {
                library_dir: "/srv/library".into(),
                level: LogLevelSetting::Info,
                port: DEFAULT_PORT,
                preview_interval_ms: DEFAULT_PREVIEW_INTERVAL_MS,
                preview_concurrency: DEFAULT_CONCURRENCY,
                max_mesh_bytes: DEFAULT_MAX_MESH_MB * 1_000_000,
                dev_ui_origin: None,
                public_origin: None,
                web_root: None,
            }
        );

        let full: HashMap<&str, &str> = [
            ("SPM_LIBRARY_DIR", "/srv/library"),
            ("SPM_LOG_LEVEL", "debug"),
            ("SPM_PORT", "9001"),
            ("SPM_PREVIEW_INTERVAL_MS", "250"),
            ("SPM_PREVIEW_CONCURRENCY", "4"),
            ("SPM_MAX_MESH_MB", "512"),
            ("SPM_MAX_STEP_MB", "40"),
            ("SPM_DEV_UI_ORIGIN", "http://localhost:5173/ignored/path"),
            (
                "SPM_PUBLIC_ORIGIN",
                "https://print.example.com/ignored/path",
            ),
            ("SPM_WEB_ROOT", "dist"),
        ]
        .into_iter()
        .collect();
        let read =
            read_server_env(&|name| full.get(name).map(|value| (*value).to_owned())).unwrap();
        assert_eq!(
            read,
            ServerEnv {
                library_dir: "/srv/library".into(),
                level: LogLevelSetting::Debug,
                port: 9001,
                preview_interval_ms: 250,
                preview_concurrency: 4,
                max_mesh_bytes: 512_000_000,
                // Each of these three proves the variable is routed through its own validator
                // rather than passed raw: a stray path is dropped, and a relative web root
                // becomes absolute.
                dev_ui_origin: Some("http://localhost:5173".into()),
                public_origin: Some("https://print.example.com".into()),
                web_root: Some(std::env::current_dir().unwrap().join("dist")),
            }
        );
    }

    #[test]
    fn read_server_env_reports_the_first_unusable_variable_as_an_app_error() {
        let env: HashMap<&str, &str> = [
            ("SPM_LIBRARY_DIR", "/srv/library"),
            ("SPM_PORT", "abc"),
            ("SPM_PREVIEW_INTERVAL_MS", "also-bad"),
        ]
        .into_iter()
        .collect();
        let error =
            read_server_env(&|name| env.get(name).map(|value| (*value).to_owned())).unwrap_err();
        // `main` prints the message and exits; anything that is not an AppError would reach the
        // operator as a stack trace instead of a sentence.
        assert_eq!(error.code, AppErrorCode::Validation);
        assert!(error.message.starts_with("SPM_PORT="), "{}", error.message);

        // A missing library dir is caught even though the numeric variables are fine.
        assert_eq!(
            read_server_env(&|_| None).unwrap_err().message,
            "SPM_LIBRARY_DIR is required"
        );
        // And a library dir alone is not enough to make the rest pass unchecked.
        assert!(
            read_server_env(&|name| Some(
                if name == "SPM_LIBRARY_DIR" {
                    "/x"
                } else {
                    "nonsense"
                }
                .to_owned()
            ))
            .is_err()
        );
    }

    #[test]
    fn a_bad_dev_ui_origin_is_refused_at_startup_too() {
        let error = read_server_env(&|name| match name {
            "SPM_LIBRARY_DIR" => Some("/x".to_owned()),
            "SPM_DEV_UI_ORIGIN" => Some("localhost:5173".to_owned()),
            _ => None,
        })
        .unwrap_err();
        assert!(
            error.message.starts_with("SPM_DEV_UI_ORIGIN"),
            "{}",
            error.message
        );
    }
}
