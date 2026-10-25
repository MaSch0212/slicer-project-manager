//! The desktop app's security configuration, asserted without a window: what the capability
//! grants, to whom, and that the lists that must agree do agree. (What the ACL *does* when a real
//! webview calls `invoke` is asserted in `hidden_smoke.rs`, from inside real webviews.)

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use spm_desktop::app_commands::APP_COMMANDS;
use spm_desktop::security::{
    MAIN_CAPABILITY, MAIN_WEBVIEW, main_capability, permission_for, remote_url_pattern,
};

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(crate_dir().join(path)).unwrap()
}

fn config() -> Value {
    serde_json::from_str(&read("tauri.conf.json")).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_capability_names_one_webview_by_label_and_no_window() {
    let capability = main_capability("http://127.0.0.1:41234");
    assert_eq!(capability["identifier"], MAIN_CAPABILITY);
    // By webview label: a window-scoped capability applies to every webview the window ever hosts,
    // including the model browser's child webview in part 3.
    assert_eq!(strings(&capability["webviews"]), [MAIN_WEBVIEW]);
    assert_eq!(MAIN_WEBVIEW, "main");
    assert!(capability["windows"].as_array().unwrap().is_empty());
    // Not for the app's own `tauri://` origin either: only the loopback origin below.
    assert_eq!(capability["local"], false);
}

#[test]
fn the_remote_url_is_exactly_the_loopback_origin_and_port_with_no_wildcard_in_it() {
    let origin = "http://127.0.0.1:41234";
    let capability = main_capability(origin);
    let urls = strings(&capability["remote"]["urls"]);
    assert_eq!(urls, ["http://127.0.0.1:41234/*"]);
    assert_eq!(remote_url_pattern(origin), urls[0]);
    // The only wildcard is the path's: not the host, not the port, not the scheme.
    let (before_path, _) = urls[0].rsplit_once('/').unwrap();
    assert!(!before_path.contains('*'), "{}", urls[0]);
    assert!(urls[0].starts_with("http://127.0.0.1:"));
    for forbidden in ["localhost", "0.0.0.0", "[::1]", "https://", "*."] {
        assert!(!urls[0].contains(forbidden), "{forbidden} in {}", urls[0]);
    }
    // One entry, and a different port is a different capability.
    assert_eq!(urls.len(), 1);
    assert_ne!(
        main_capability("http://127.0.0.1:41235")["remote"]["urls"],
        capability["remote"]["urls"]
    );
}

#[test]
fn the_grant_is_the_app_commands_and_nothing_from_tauri_or_a_plugin() {
    let capability = main_capability("http://127.0.0.1:41234");
    let granted: BTreeSet<String> = strings(&capability["permissions"]).into_iter().collect();
    let expected: BTreeSet<String> = APP_COMMANDS.iter().map(|c| permission_for(c)).collect();
    assert_eq!(granted, expected);
    for permission in &granted {
        assert!(permission.starts_with("allow-"), "{permission}");
        assert!(
            !permission.contains(':'),
            "{permission} names a core or plugin permission"
        );
    }
    // No `core:default`, no dialog, no window or webview management, no path, no event.
    for banned in [
        "core", "dialog", "window", "webview", "fs", "shell", "opener", "event", "path",
    ] {
        assert!(
            !granted
                .iter()
                .any(|permission| permission.contains(&format!("{banned}:"))),
            "{banned}"
        );
    }
    assert_eq!(
        permission_for("desktop_library_pick"),
        "allow-desktop-library-pick",
        "the name `tauri-build` generates for the command"
    );
}

#[test]
fn the_handler_registers_exactly_the_manifest_commands_so_none_is_callable_without_a_permission() {
    let source = read("src/lib.rs");
    let start = source
        .find("generate_handler![")
        .expect("a handler registration");
    let list = &source[start..source[start..].find(']').unwrap() + start];
    let registered: BTreeSet<String> = list
        .split(',')
        .filter_map(|entry| entry.trim().rsplit("::").next())
        .map(|name| {
            name.trim_start_matches("generate_handler![")
                .trim()
                .to_owned()
        })
        .filter(|name| name.starts_with("desktop_"))
        .collect();
    let manifest: BTreeSet<String> = APP_COMMANDS.iter().map(|c| (*c).to_owned()).collect();
    assert_eq!(
        registered, manifest,
        "the handler and the app manifest disagree"
    );

    // And every one of them is a `#[tauri::command]` that exists.
    let commands = read("src/commands.rs");
    for name in &manifest {
        assert!(
            commands.contains(&format!("pub fn {name}("))
                || commands.contains(&format!("pub async fn {name}(")),
            "{name} is not a command"
        );
    }
    // The build script reads the same list the capability does.
    let build = read("build.rs");
    assert!(build.contains("src/app_commands.rs") && build.contains("app_manifest"));
    assert!(build.contains("APP_COMMANDS"));
}

#[test]
fn no_command_takes_a_path_the_page_could_choose_so_the_page_can_name_no_file() {
    for source in ["src/commands.rs"] {
        let text = read(source);
        for signature in text.lines().filter(|line| {
            line.contains("pub async fn desktop_") || line.contains("pub fn desktop_")
        }) {
            for banned in ["path", "dir:", "file:", "PathBuf", "folder"] {
                assert!(!signature.contains(banned), "{signature}");
            }
        }
        // The one thing the page supplies is a server address, validated before anything uses it.
        assert!(text.contains("connect_remote(&url)"));
    }
}

#[test]
fn nothing_is_granted_at_build_time_and_no_remote_origin_appears_in_the_static_config() {
    let config = config();
    // No window is declared in the config: the app builds its own, so no window inherits anything.
    assert!(config["app"]["windows"].as_array().unwrap().is_empty());
    // No static capability: `app.security.capabilities` is an empty list, so even a stray file in
    // `capabilities/` would grant nothing.
    assert!(
        config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let capabilities_dir = crate_dir().join("capabilities");
    assert!(
        !capabilities_dir.exists() || fs::read_dir(&capabilities_dir).unwrap().next().is_none(),
        "a static capability file exists"
    );
    // The page gets no global `window.__TAURI__` convenience object (the bridge is still there;
    // the ACL decides), and nothing weakens the asset policy.
    assert_eq!(config["app"]["withGlobalTauri"], false);
    let text = config.to_string();
    for banned in [
        "dangerousDisableAssetCspModification",
        "dangerousRemoteDomainIpcAccess",
        "assetProtocol",
        "\"remote\"",
        "freezePrototype\":false",
    ] {
        assert!(!text.contains(banned), "{banned} in tauri.conf.json");
    }
}

#[test]
fn the_build_generated_a_permission_for_every_app_command_and_for_nothing_else() {
    // `tauri-build` writes the resolved ACL manifests next to the config: the app manifest is the
    // `__app-acl__` entry. This is the proof that `build.rs` wired the list in.
    let manifests: Value = serde_json::from_str(&read("gen/schemas/acl-manifests.json")).unwrap();
    let app = &manifests["__app-acl__"];
    assert!(app.is_object(), "no app manifest was generated");
    let permissions: BTreeSet<String> = app["permissions"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let expected: BTreeSet<String> = APP_COMMANDS
        .iter()
        .map(|c| permission_for(c).trim_start_matches("allow-").to_owned())
        .map(|c| format!("allow-{c}"))
        .collect();
    let denies: BTreeSet<String> = APP_COMMANDS
        .iter()
        .map(|c| permission_for(c).replacen("allow-", "deny-", 1))
        .collect();
    let allows: BTreeSet<String> = permissions
        .iter()
        .filter(|p| p.starts_with("allow-"))
        .cloned()
        .collect();
    assert_eq!(
        allows, expected,
        "the generated permissions are not the app commands"
    );
    for deny in denies {
        assert!(permissions.contains(&deny), "{deny}");
    }
    // No default permission: nothing is granted by naming the app's identifier.
    assert!(
        app["default_permission"].is_null(),
        "{}",
        app["default_permission"]
    );
}
