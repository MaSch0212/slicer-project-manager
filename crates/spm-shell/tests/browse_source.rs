//! Ported from `browse-source.test.ts`: source-level assertions that keep the model browser inside
//! the shell. A page route, a core module or a server table that learned about browsing would be a
//! second place that has to be right about somebody else's website.

use std::fs;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn sources(crate_dir: &str) -> Vec<(PathBuf, String)> {
    let mut files = Vec::new();
    rust_files(&root().join(crate_dir).join("src"), &mut files);
    assert!(!files.is_empty(), "{crate_dir} was read");
    files
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path).unwrap();
            (path, text)
        })
        .collect()
}

#[test]
fn subsystem_e_added_no_route_to_the_server() {
    // Every route literal in the HTTP crate, and none of them is about browsing or downloads.
    let mut routes = 0;
    for (path, text) in sources("crates/spm-http") {
        for line in text.lines().filter(|line| line.contains(".route(")) {
            routes += 1;
            let line = line.to_lowercase();
            assert!(
                !line.contains("browse") && !line.contains("model-download"),
                "{}: {line}",
                path.display()
            );
        }
    }
    assert!(routes > 10, "the walk saw the routes");
    for crate_dir in ["crates/spm-http", "crates/spm-server"] {
        for (path, text) in sources(crate_dir) {
            for banned in [
                "BrowseHost",
                "BrowseServices",
                "model-downloads",
                "desktop_browse",
            ] {
                assert!(!text.contains(banned), "{}: {banned}", path.display());
            }
        }
    }
}

#[test]
fn subsystem_e_added_to_core_only_its_dtos_and_the_match_key_it_was_always_meant_to_share() {
    let allowed = ["dto/desktop.rs", "dto/mod.rs", "tsgen.rs", "match_key.rs"];
    for (path, text) in sources("crates/spm-core") {
        let relative = path
            .strip_prefix(root().join("crates/spm-core/src"))
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if allowed.contains(&relative.as_str()) {
            continue;
        }
        for banned in ["Browse", "model browser", "model-downloads", "ModelSite"] {
            assert!(!text.contains(banned), "{relative}: {banned}");
        }
    }
}

#[test]
fn the_browser_logic_lives_in_the_shell_crate_and_has_no_window_in_it() {
    for (path, text) in sources("crates/spm-shell") {
        let text = text.replace("`tauri", "").replace("Tauri", "");
        assert!(
            !text.contains("use tauri"),
            "{} depends on the GUI",
            path.display()
        );
    }
}
