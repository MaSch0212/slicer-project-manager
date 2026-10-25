//! `spm-server import-curamanager`, driven through `import_cli::run` with captured output. The
//! legacy script had no test of its own (core's importer carries the behaviour tests); these pin
//! the command's arguments, output and exit status.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use spm_core::ensure_bootstrap_admin;
use spm_server::import_cli::{USAGE, run};
use spm_server::progress::{Progress, ProgressDeps};

use crate::common::open;

struct Outcome {
    code: i32,
    out: String,
    err: String,
    drawn: String,
}

fn silent(name: &str) -> Option<String> {
    (name == "SPM_LOG_LEVEL").then(|| "silent".to_owned())
}

fn run_command(args: &[&str], get_env: &dyn Fn(&str) -> Option<String>) -> Outcome {
    let drawn = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&drawn);
    let progress = Progress::new(ProgressDeps {
        is_terminal: false,
        write: Box::new(move |text| sink.lock().unwrap().push_str(text)),
        now: Box::new(|| 0),
    });
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let code = run(&args, get_env, &progress, &mut out, &mut err);
    let drawn = drawn.lock().unwrap().clone();
    Outcome {
        code,
        out: String::from_utf8(out).unwrap(),
        err: String::from_utf8(err).unwrap(),
        drawn,
    }
}

/// A flat CuraManager library in `dir`, and an `admin` account (pending is enough: the command
/// only looks the account up).
fn flat_library(dir: &Path) {
    let lib = open(dir, None);
    ensure_bootstrap_admin(&lib)
        .unwrap()
        .expect("a fresh library");
    let widget = dir.join("Widget A");
    fs::create_dir_all(&widget).unwrap();
    fs::write(widget.join("part.stl"), "solid a").unwrap();
    fs::write(
        widget.join("metadata.json"),
        r#"{"Tags":["toys"],"IsArchived":true,"Url":"https://a.example"}"#,
    )
    .unwrap();
    let bracket = dir.join("Bracket");
    fs::create_dir_all(&bracket).unwrap();
    fs::write(bracket.join("model.3mf"), "x").unwrap();
}

#[test]
fn it_moves_adopts_indexes_and_applies_sidecars_then_reports_the_counts() {
    let dir = tempfile::tempdir().unwrap();
    flat_library(dir.path());

    let outcome = run_command(&[dir.path().to_str().unwrap(), "admin"], &silent);

    assert_eq!(outcome.code, 0, "{}", outcome.err);
    assert_eq!(
        outcome.out,
        concat!(
            "imported into \"admin\":\n",
            "  folders moved:    2\n",
            "  projects adopted: 2\n",
            "  files indexed:    3\n",
            "  sidecars applied: 1\n",
            "  tags applied:     1\n",
            "  marked missing:   0\n",
            "Previews are queued; the server generates them on its next pass.\n",
        )
    );
    // The folders really moved under the user's own folder.
    assert!(dir.path().join("admin/Widget A/part.stl").exists());
    assert!(dir.path().join("admin/Bracket/model.3mf").exists());
    assert!(!dir.path().join("Widget A").exists());
    assert_eq!(outcome.err, "");
}

#[test]
fn it_draws_a_progress_line_per_phase() {
    let dir = tempfile::tempdir().unwrap();
    flat_library(dir.path());
    let outcome = run_command(&[dir.path().to_str().unwrap(), "admin"], &silent);
    assert_eq!(outcome.code, 0);
    // Not a terminal, so plain appended lines with no escape codes; the phase change is forced
    // through the throttle, so both phases show.
    assert!(
        outcome.drawn.contains("indexing [1/2] "),
        "{}",
        outcome.drawn
    );
    assert!(
        outcome.drawn.contains("applying sidecars [1/2] "),
        "{}",
        outcome.drawn
    );
    assert!(!outcome.drawn.contains('\x1b'), "{}", outcome.drawn);
}

#[test]
fn in_place_skips_the_move() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path(), None);
    ensure_bootstrap_admin(&lib).unwrap().unwrap();
    // Folders that already sit under the right user directory.
    let widget = dir.path().join("admin").join("Widget A");
    fs::create_dir_all(&widget).unwrap();
    fs::write(widget.join("part.stl"), "solid a").unwrap();

    let outcome = run_command(
        &[dir.path().to_str().unwrap(), "admin", "--in-place"],
        &silent,
    );
    assert_eq!(outcome.code, 0, "{}", outcome.err);
    assert!(
        outcome.out.contains("  folders moved:    0\n"),
        "{}",
        outcome.out
    );
    assert!(
        outcome.out.contains("  projects adopted: 1\n"),
        "{}",
        outcome.out
    );
    // The flag may come first, too.
    let again = run_command(
        &["--in-place", dir.path().to_str().unwrap(), "admin"],
        &silent,
    );
    assert_eq!(again.code, 0, "{}", again.err);
}

#[test]
fn the_user_name_is_matched_without_regard_to_case() {
    let dir = tempfile::tempdir().unwrap();
    flat_library(dir.path());
    let outcome = run_command(&[dir.path().to_str().unwrap(), "ADMIN"], &silent);
    assert_eq!(outcome.code, 0, "{}", outcome.err);
    assert!(
        outcome.out.starts_with("imported into \"admin\":"),
        "{}",
        outcome.out
    );
}

#[test]
fn an_unknown_user_is_refused_before_anything_moves() {
    let dir = tempfile::tempdir().unwrap();
    flat_library(dir.path());
    let outcome = run_command(&[dir.path().to_str().unwrap(), "nobody"], &silent);
    assert_eq!(outcome.code, 1);
    assert_eq!(
        outcome.err,
        "NotFound: no such user: nobody. Create the account first.\n"
    );
    assert_eq!(outcome.out, "");
    assert!(dir.path().join("Widget A").exists(), "something moved");
}

#[test]
fn a_collision_is_refused_whole_names_the_folders_and_moves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    flat_library(dir.path());
    // The same folder name already under the user's own folder.
    fs::create_dir_all(dir.path().join("admin").join("Widget A")).unwrap();

    let outcome = run_command(&[dir.path().to_str().unwrap(), "admin"], &silent);
    assert_eq!(outcome.code, 1);
    assert!(outcome.err.starts_with("Conflict: "), "{}", outcome.err);
    assert!(outcome.err.contains("Widget A"), "{}", outcome.err);
    assert_eq!(outcome.out, "");
    // All-or-nothing: the other folder did not move either.
    assert!(dir.path().join("Bracket").exists());
    assert!(dir.path().join("Widget A").exists());
}

#[test]
fn missing_or_extra_arguments_print_the_usage_and_fail() {
    for args in [
        vec![],
        vec!["/some/library"],
        vec!["/some/library", "admin", "extra"],
        vec!["--in-place"],
    ] {
        let outcome = run_command(&args, &silent);
        assert_eq!(outcome.code, 1, "{args:?}");
        assert_eq!(outcome.err, format!("{USAGE}\n"), "{args:?}");
        assert_eq!(outcome.out, "");
    }
}

#[test]
fn a_bad_log_level_is_one_line_and_exit_status_1() {
    let dir = tempfile::tempdir().unwrap();
    let outcome = run_command(&[dir.path().to_str().unwrap(), "admin"], &|name| {
        (name == "SPM_LOG_LEVEL").then(|| "verbose".to_owned())
    });
    assert_eq!(outcome.code, 1);
    assert_eq!(
        outcome.err,
        "SPM_LOG_LEVEL=\"verbose\" is not a log level. Use one of: silent, error, warn, info, \
         debug, trace\n"
    );
}
