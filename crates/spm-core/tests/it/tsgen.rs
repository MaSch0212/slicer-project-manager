use spm_core::tsgen;

/// The gate that keeps the Rust DTOs and the TypeScript the web package compiles against in step:
/// the files under `packages/web/src/api/generated/` are checked in, and this fails the moment they
/// differ from what the Rust would generate today. Fix it with `pnpm gen:types`.
#[test]
fn generated_typescript_is_up_to_date() {
    let dir = tsgen::generated_dir();
    let stale = tsgen::stale_files(&dir);
    assert!(
        stale.is_empty(),
        "{} is stale ({stale:?}); run `pnpm gen:types` and commit the result",
        dir.display()
    );
}

#[test]
fn generation_is_deterministic_and_writes_every_file() {
    let first = tsgen::generate();
    let second = tsgen::generate();
    assert_eq!(first, second);

    let dir = tempfile::tempdir().unwrap();
    tsgen::write_to(dir.path()).unwrap();
    assert!(tsgen::stale_files(dir.path()).is_empty());
    let names: Vec<&str> = first.iter().map(|(name, _)| *name).collect();
    assert_eq!(names, ["types.ts", "constants.ts", "index.ts"]);
}

#[test]
fn a_missing_or_edited_generated_file_is_reported_stale() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(tsgen::stale_files(dir.path()).len(), 3);

    tsgen::write_to(dir.path()).unwrap();
    std::fs::write(dir.path().join("types.ts"), "// hand edit\n").unwrap();
    assert_eq!(tsgen::stale_files(dir.path()), ["types.ts"]);
}

#[test]
fn the_generated_types_carry_the_contract_the_ui_depends_on() {
    let (_, types) = tsgen::generate()
        .into_iter()
        .find(|(name, _)| *name == "types.ts")
        .unwrap();
    // Error codes are the i18n keys.
    assert!(types.contains(r#"export type AppErrorCode = "Unauthorized" | "Forbidden""#));
    // Absent-not-null optional fields, and 64-bit counters as plain numbers.
    assert!(types.contains("thumbUrl?: string"));
    assert!(types.contains("diskUsageBytes: number"));
    assert!(!types.contains("bigint"));
    // The three states of a patchable field.
    assert!(types.contains("website?: string | null"));

    let (_, constants) = tsgen::generate()
        .into_iter()
        .find(|(name, _)| *name == "constants.ts")
        .unwrap();
    assert!(constants.contains(r#""viewMode": "grid""#));
    assert!(constants.contains("export const SEARCH_MAX_LENGTH = 200"));
}
