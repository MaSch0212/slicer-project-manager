//! The policies the windows apply: where the main webview may go (the Electron shell's
//! `navigationPolicy`, tested in `files.test.ts`) and which permission requests it grants
//! (`permissions.test.ts`).

mod support;

use spm_shell::nav::{NavigationPolicy, is_openable_externally, navigation_policy};
use spm_shell::permissions::{APP_PERMISSIONS, is_permission_allowed};
use spm_shell::smoke::{SmokeExpect, run};
use support::{World, serve};

const APP: &str = "http://127.0.0.1:41234";

#[test]
fn navigation_allows_the_apps_own_origin_externalises_web_pages_and_blocks_the_rest() {
    use NavigationPolicy::{Allow, Block, External};
    for (url, expected) in [
        // The app's own origin, any path, query or fragment.
        ("http://127.0.0.1:41234/", Allow),
        ("http://127.0.0.1:41234/projects/abc?x=1#top", Allow),
        ("http://127.0.0.1:41234/_spm/handshake?k=abc", Allow),
        // Not this app: another port on the same host, another host, another scheme.
        ("http://127.0.0.1:41235/", External),
        ("http://127.0.0.1/", External),
        ("http://localhost:41234/", External),
        ("https://127.0.0.1:41234/", External),
        ("https://example.com/page", External),
        ("http://example.com/", External),
        // A host spelled to read as ours.
        ("http://127.0.0.1:41234@evil.example/", Block),
        ("http://127.0.0.1:41234.evil.example/", Block), // not even a URL: the port is not a number
        ("https://user:pass@example.com/", Block),
        // Everything that is not a web page.
        ("about:blank", Block),
        ("about:srcdoc", Block),
        ("blob:http://127.0.0.1:41234/abc", Block),
        ("data:text/html,<script>1</script>", Block),
        ("file:///C:/Windows/System32/calc.exe", Block),
        ("javascript:alert(1)", Block),
        ("ipc://localhost/cmd", Block),
        ("tauri://localhost/", Block),
        ("spm://app/projects", Block),
        ("bambustudio://open?file=x", Block),
        ("ws://127.0.0.1:41234/", Block),
        // Not URLs.
        ("", Block),
        ("not a url", Block),
        ("/relative/path", Block),
        ("//host/path", Block),
    ] {
        assert_eq!(navigation_policy(url, APP), expected, "{url:?}");
    }
}

#[test]
fn only_web_pages_are_ever_handed_to_the_operating_system() {
    for url in [
        "https://example.com/",
        "http://example.com/page?q=1",
        "http://192.168.1.2:8080/",
    ] {
        assert!(is_openable_externally(url), "{url}");
    }
    for url in [
        "file:///C:/Windows/System32/cmd.exe",
        "javascript:alert(1)",
        "data:text/html,x",
        "ms-msdt:/id PCWDiagnostic",
        "search-ms:query=x",
        "calc:",
        "https://user:pw@example.com/",
        "not a url",
        "",
    ] {
        assert!(!is_openable_externally(url), "{url}");
    }
}

#[test]
fn the_app_grants_no_permission_request_and_refuses_the_whole_list() {
    // The Electron shell granted one (`clipboard-sanitized-write`); the web app's copy buttons go
    // through `navigator.clipboard.writeText`, which needs no grant, so the list is empty.
    assert!(APP_PERMISSIONS.is_empty());
    for permission in [
        "clipboard-sanitized-write",
        "clipboard-read",
        "geolocation",
        "notifications",
        "media",
        "camera",
        "microphone",
        "midi",
        "midiSysex",
        "display-capture",
        "fullscreen",
        "pointerLock",
        "openExternal",
        "idle-detection",
        "persistent-storage",
        "window-management",
        "local-fonts",
        "hid",
        "serial",
        "usb",
        "unknown-future-permission",
        "",
    ] {
        assert!(!is_permission_allowed(permission), "{permission:?}");
    }
}

#[tokio::test]
async fn the_smoke_checks_pass_against_a_listener_over_a_local_library() {
    // The same checks the hidden desktop run makes on its own listener, here on one this test
    // started (no window needed for any of them).
    let world = World::new();
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    let server = serve(&world.shell).await;
    let report = run(
        server.addr(),
        server.gate(),
        &SmokeExpect {
            local_library: true,
            // `serve` has no UI, so `/` is a 404, which is what the check wants then.
            ui_embedded: false,
        },
    )
    .await;
    let failed: Vec<_> = report.checks.iter().filter(|check| !check.ok).collect();
    assert!(report.ok && failed.is_empty(), "{failed:#?}");
    assert!(report.checks.len() >= 10, "{}", report.checks.len());
    assert_eq!(report.port, server.addr().port());
}
