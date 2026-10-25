//! Ported from the Electron shell's `packaging.test.ts` and `icons.test.ts`: what the installer
//! must carry. The Electron checks named files inside an unpacked `app/` directory (its main
//! script, the preload, the OCCT wasm, the migrations); a Tauri app is one executable with the web
//! bundle, the migrations and the SQLite library compiled in, so what is left to check is the
//! licence artifacts the bundler is told to ship, the icons it is given, and the names. The OCCT
//! and LGPL rows are gone with STEP support (what the notices *say* is the migration's last step,
//! not this app's: the installer ships whatever the repository's notices file holds).
//!
//! `apps/desktop/scripts/verify-bundle.mjs` checks the *built* bundle (the installer exists, its
//! shipped files are the repository's, nothing of Chromium is in it) as the last step of
//! `pnpm build:desktop`.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use spm_desktop::window::APP_NAME;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_root() -> PathBuf {
    crate_dir().join("../../..").canonicalize().unwrap()
}

fn config() -> Value {
    serde_json::from_str(&fs::read_to_string(crate_dir().join("tauri.conf.json")).unwrap()).unwrap()
}

/// The width and height a PNG declares.
fn png_size(path: &Path) -> (u32, u32) {
    let bytes = fs::read(path).unwrap();
    assert_eq!(
        &bytes[..8],
        &[137, 80, 78, 71, 13, 10, 26, 10],
        "{} is not a PNG",
        path.display()
    );
    (
        u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
        u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
    )
}

/// The frame sizes an `.ico` carries (a stored 0 means 256).
fn ico_frames(path: &Path) -> Vec<u32> {
    let bytes = fs::read(path).unwrap();
    assert_eq!(
        &bytes[..4],
        &[0, 0, 1, 0],
        "{} is not an ICO",
        path.display()
    );
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    (0..count)
        .map(|index| {
            let entry = 6 + index * 16;
            let (width, height) = (bytes[entry], bytes[entry + 1]);
            assert_eq!(width, height, "frame {index} is not square");
            // Every frame's payload is inside the file.
            let size =
                u32::from_le_bytes(bytes[entry + 8..entry + 12].try_into().unwrap()) as usize;
            let offset =
                u32::from_le_bytes(bytes[entry + 12..entry + 16].try_into().unwrap()) as usize;
            assert!(
                offset + size <= bytes.len(),
                "frame {index} runs past the end of the file"
            );
            if width == 0 { 256 } else { u32::from(width) }
        })
        .collect()
}

#[test]
fn the_licence_artifacts_exist_at_the_repository_root_and_are_not_empty() {
    for name in ["LICENSE", "THIRD-PARTY-NOTICES.md"] {
        let path = repo_root().join(name);
        let metadata = fs::metadata(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(metadata.is_file() && metadata.len() > 0, "{name} is empty");
    }
}

#[test]
fn the_installer_is_told_to_ship_the_licence_and_the_notices_and_they_are_the_repositorys_own() {
    let config = config();
    let bundle = &config["bundle"];
    assert_eq!(bundle["active"], true);
    // The installer's licence page.
    assert_eq!(bundle["license"], "MIT");
    let licence_file = crate_dir().join(bundle["licenseFile"].as_str().unwrap());
    assert_eq!(
        fs::read(&licence_file).unwrap(),
        fs::read(repo_root().join("LICENSE")).unwrap()
    );
    // And installed next to the program: the notices travel with the binary.
    let resources = bundle["resources"].as_object().unwrap();
    let mut shipped: Vec<(String, String)> = resources
        .iter()
        .map(|(from, to)| (from.clone(), to.as_str().unwrap().to_owned()))
        .collect();
    shipped.sort();
    assert_eq!(
        shipped,
        [
            (
                "../../../LICENSE".to_owned(),
                "third-party/LICENSE".to_owned()
            ),
            (
                "../../../THIRD-PARTY-NOTICES.md".to_owned(),
                "third-party/THIRD-PARTY-NOTICES.md".to_owned()
            ),
        ]
    );
    for (from, _) in shipped {
        let source = crate_dir().join(&from);
        assert!(source.is_file(), "{from} does not exist");
        let name = source.file_name().unwrap();
        assert_eq!(
            fs::read(&source).unwrap(),
            fs::read(repo_root().join(name)).unwrap(),
            "{from} is not the repository's own file"
        );
    }
}

#[test]
fn the_executable_and_the_installer_are_named_for_the_app() {
    let config = config();
    assert_eq!(APP_NAME, "Slicer Project Manager");
    assert_eq!(config["productName"], APP_NAME);
    // Explorer shows the file name: the product name, with its spaces, as the Electron build did.
    assert_eq!(config["mainBinaryName"], APP_NAME);
    assert_eq!(config["bundle"]["targets"], serde_json::json!(["nsis"]));
    // One installer, per user: nothing in it asks for elevation.
    assert_eq!(
        config["bundle"]["windows"]["nsis"]["installMode"],
        "currentUser"
    );
    assert_eq!(config["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn the_database_migrations_are_compiled_in_so_there_is_nothing_to_ship_beside_the_program() {
    let migrations = repo_root().join("crates/spm-core/src/db/migrations");
    let migrate =
        fs::read_to_string(repo_root().join("crates/spm-core/src/db/migrate.rs")).unwrap();
    for name in [
        "001_init.sql",
        "002_preview_claim.sql",
        "003_classifier_version.sql",
    ] {
        assert!(migrations.join(name).is_file(), "{name}");
        assert!(
            migrate.contains(&format!("include_str!(\"migrations/{name}\")")),
            "{name} is not embedded"
        );
    }
}

#[test]
fn the_icons_the_bundler_is_given_exist_and_decode_at_the_sizes_they_claim() {
    let config = config();
    let listed: Vec<String> = config["bundle"]["icon"]
        .as_array()
        .unwrap()
        .iter()
        .map(|icon| icon.as_str().unwrap().to_owned())
        .collect();
    for icon in &listed {
        assert!(crate_dir().join(icon).is_file(), "{icon} does not exist");
    }
    // Windows wants the .ico; the PNGs are the window icon and what the bundler derives from.
    assert!(listed.iter().any(|icon| icon.ends_with("icon.ico")));
    assert!(listed.iter().any(|icon| icon.ends_with("icon.png")));

    let icons = crate_dir().join("icons");
    assert_eq!(png_size(&icons.join("32x32.png")), (32, 32));
    assert_eq!(png_size(&icons.join("128x128.png")), (128, 128));
    assert_eq!(png_size(&icons.join("128x128@2x.png")), (256, 256));
    assert_eq!(png_size(&icons.join("icon.png")), (512, 512));

    // The .ico carries every frame Windows asks for: 16 for the title bar, 32 and 48 and 64 as the
    // taskbar scales, 256 for Explorer's extra-large view and Alt-Tab.
    let frames = ico_frames(&icons.join("icon.ico"));
    for wanted in [16, 24, 32, 48, 64, 128, 256] {
        assert!(
            frames.contains(&wanted),
            "no {wanted}px frame in {frames:?}"
        );
    }
}

#[test]
fn the_window_icon_the_app_embeds_is_one_of_the_files_above() {
    // `tauri::generate_context!` embeds the default window icon from the bundle icon list; the
    // Electron shell shipped `icon.ico` beside the bundle for the same purpose. Both spellings it
    // can use are files this repository has.
    let icons = crate_dir().join("icons");
    assert!(icons.join("icon.ico").is_file() && icons.join("icon.png").is_file());
}

#[test]
fn the_icon_generator_writes_where_this_app_reads_them_from() {
    // `tools/generate-icons.ts` is the pipeline that makes the icons; if it wrote somewhere else
    // the tracked files would silently go stale.
    let generator = fs::read_to_string(repo_root().join("tools/generate-icons.ts")).unwrap();
    assert!(
        generator.contains("'apps', 'desktop', 'src-tauri', 'icons'"),
        "tools/generate-icons.ts does not write to apps/desktop/src-tauri/icons"
    );
}
