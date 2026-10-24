//! Ported from the legacy `projects.test.ts`: project lifecycle, tags, and the list query
//! (search, tag filter, archived, sort, paging, cover).

use rusqlite::params;
use spm_core::dto::{FileCounts, PreviewState, ProjectQuery, ProjectState, SortDir, SortKey};
use spm_core::projects::usecases::sanitize_dir_name;
use spm_core::testing::{TempLibrary, seed_file_row, seed_user};
use spm_core::validate::{CreateProjectInput, ProjectPatch};
use spm_core::{
    AppErrorCode, Ctx, Library, add_tag, create_project, delete_project, get_project,
    list_projects, list_tags, new_id, remove_tag, update_project,
};

use crate::common::code_of;

fn input(name: &str) -> CreateProjectInput {
    CreateProjectInput {
        name: name.to_owned(),
        ..CreateProjectInput::default()
    }
}

fn tagged(name: &str, tags: &[&str]) -> CreateProjectInput {
    CreateProjectInput {
        tags: Some(tags.iter().map(|tag| (*tag).to_owned()).collect()),
        ..input(name)
    }
}

fn names(lib: &Library, ctx: &Ctx, query: &ProjectQuery) -> Vec<String> {
    list_projects(lib, ctx, query)
        .unwrap()
        .into_iter()
        .map(|project| project.name)
        .collect()
}

fn search(term: &str) -> ProjectQuery {
    ProjectQuery {
        search: Some(term.to_owned()),
        ..ProjectQuery::default()
    }
}

fn with_tags(tags: &[&str]) -> ProjectQuery {
    ProjectQuery {
        tags: Some(tags.iter().map(|tag| (*tag).to_owned()).collect()),
        ..ProjectQuery::default()
    }
}

fn paged(limit: i64, offset: i64) -> ProjectQuery {
    ProjectQuery {
        limit: Some(limit),
        offset: Some(offset),
        ..ProjectQuery::default()
    }
}

#[test]
fn sanitize_dir_name_strips_separators_and_trims() {
    assert_eq!(sanitize_dir_name("Gridfinity Bin"), "Gridfinity Bin");
    assert_eq!(sanitize_dir_name("  a/b:c*d?  "), "a-b-c-d");
    assert_eq!(sanitize_dir_name("..."), "project");
}

#[test]
fn create_project_makes_the_folder_and_returns_the_dto() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project = create_project(&lib, &ctx, input("Benchy")).unwrap();
    assert_eq!(project.name, "Benchy");
    assert_eq!(project.state, ProjectState::Ok);
    assert!(!project.is_archived);
    assert!(project.tags.is_empty());
    assert_eq!(project.file_counts, FileCounts::default());
    assert!(lib.dir().join("marc").join("Benchy").is_dir());
}

#[test]
fn two_projects_with_the_same_name_get_distinct_folders() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    create_project(&lib, &ctx, input("Benchy")).unwrap();
    create_project(&lib, &ctx, input("Benchy")).unwrap();
    assert!(lib.dir().join("marc").join("Benchy (2)").is_dir());
}

#[test]
fn create_project_applies_website_notes_and_tags() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project = create_project(
        &lib,
        &ctx,
        CreateProjectInput {
            website: Some("https://printables.com/model/1".to_owned()),
            notes: Some("PETG only".to_owned()),
            ..tagged("Bracket", &["Functional", "petg"])
        },
    )
    .unwrap();
    assert_eq!(
        project.website.as_deref(),
        Some("https://printables.com/model/1")
    );
    assert_eq!(project.tags, ["Functional", "petg"]);
}

#[test]
fn one_user_cannot_see_or_fetch_another_user_project() {
    let lib = TempLibrary::new();
    let marc = seed_user(&lib, "marc");
    let anna = seed_user(&lib, "anna");
    let mine = create_project(&lib, &marc, input("Benchy")).unwrap();

    assert!(
        list_projects(&lib, &anna, &ProjectQuery::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        code_of(get_project(&lib, &anna, &mine.id)),
        AppErrorCode::NotFound
    );
    let stolen = ProjectPatch {
        name: Some("Stolen".to_owned()),
        ..ProjectPatch::default()
    };
    assert_eq!(
        code_of(update_project(&lib, &anna, &mine.id, stolen)),
        AppErrorCode::NotFound
    );
    assert_eq!(
        code_of(delete_project(&lib, &anna, &mine.id, false)),
        AppErrorCode::NotFound
    );
}

#[test]
fn update_project_patches_only_what_is_given_and_clears_with_null() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let created = create_project(
        &lib,
        &ctx,
        CreateProjectInput {
            website: Some("https://a.example".to_owned()),
            ..input("Benchy")
        },
    )
    .unwrap();
    let renamed = update_project(
        &lib,
        &ctx,
        &created.id,
        ProjectPatch {
            name: Some("Benchy v2".to_owned()),
            ..ProjectPatch::default()
        },
    )
    .unwrap();
    assert_eq!(renamed.name, "Benchy v2");
    assert_eq!(renamed.website.as_deref(), Some("https://a.example"));

    let cleared = update_project(
        &lib,
        &ctx,
        &created.id,
        ProjectPatch {
            website: Some(None),
            is_archived: Some(true),
            ..ProjectPatch::default()
        },
    )
    .unwrap();
    assert_eq!(cleared.website, None);
    assert!(cleared.is_archived);
    assert!(cleared.updated_at >= created.updated_at);
}

#[test]
fn renaming_a_project_does_not_move_its_folder() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let created = create_project(&lib, &ctx, input("Benchy")).unwrap();
    update_project(
        &lib,
        &ctx,
        &created.id,
        ProjectPatch {
            name: Some("Something else".to_owned()),
            ..ProjectPatch::default()
        },
    )
    .unwrap();
    // dir_name is independent of the display name, exactly as library_dir is of username.
    assert!(lib.dir().join("marc").join("Benchy").is_dir());
}

#[test]
fn delete_project_keeps_the_folder_unless_delete_files_is_set() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let keep = create_project(&lib, &ctx, input("Keep")).unwrap();
    let wipe = create_project(&lib, &ctx, input("Wipe")).unwrap();
    std::fs::write(lib.dir().join("marc").join("Wipe").join("a.stl"), "solid").unwrap();

    delete_project(&lib, &ctx, &keep.id, false).unwrap();
    assert!(lib.dir().join("marc").join("Keep").is_dir());

    delete_project(&lib, &ctx, &wipe.id, true).unwrap();
    assert!(!lib.dir().join("marc").join("Wipe").exists());
    assert!(
        list_projects(&lib, &ctx, &ProjectQuery::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn tags_are_per_owner_case_insensitive_and_cleaned_up_when_orphaned() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project = create_project(&lib, &ctx, input("Benchy")).unwrap();

    add_tag(&lib, &ctx, &project.id, "Boat").unwrap();
    add_tag(&lib, &ctx, &project.id, "boat").unwrap();
    assert_eq!(
        get_project(&lib, &ctx, &project.id).unwrap().project.tags,
        ["Boat"]
    );

    remove_tag(&lib, &ctx, &project.id, "BOAT").unwrap();
    assert!(
        get_project(&lib, &ctx, &project.id)
            .unwrap()
            .project
            .tags
            .is_empty()
    );
    let n: i64 = lib
        .db()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn list_filters_by_search_across_name_notes_and_tags() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    create_project(&lib, &ctx, input("Benchy")).unwrap();
    create_project(
        &lib,
        &ctx,
        CreateProjectInput {
            notes: Some("needs PETG".to_owned()),
            ..input("Bracket")
        },
    )
    .unwrap();
    let bin = create_project(&lib, &ctx, input("Bin")).unwrap();
    add_tag(&lib, &ctx, &bin.id, "gridfinity").unwrap();

    assert_eq!(names(&lib, &ctx, &search("bench")), ["Benchy"]);
    assert_eq!(names(&lib, &ctx, &search("PETG")), ["Bracket"]);
    assert_eq!(names(&lib, &ctx, &search("GRIDFINITY")), ["Bin"]);
    assert!(names(&lib, &ctx, &search("nothing here")).is_empty());
}

#[test]
fn a_search_term_with_like_wildcards_is_matched_literally() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    create_project(&lib, &ctx, input("Benchy")).unwrap();
    create_project(&lib, &ctx, input("100% infill")).unwrap();
    assert_eq!(names(&lib, &ctx, &search("%")), ["100% infill"]);
}

#[test]
fn a_tags_filter_requires_every_tag() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let both = create_project(&lib, &ctx, tagged("Both", &["petg", "functional"])).unwrap();
    create_project(&lib, &ctx, tagged("One", &["petg"])).unwrap();

    let matched = list_projects(&lib, &ctx, &with_tags(&["petg", "functional"])).unwrap();
    assert_eq!(
        matched.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        [both.id.as_str()]
    );
    assert_eq!(
        list_projects(&lib, &ctx, &with_tags(&["petg"]))
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn a_case_variant_or_literal_duplicate_in_the_tags_filter_still_matches() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let both = create_project(&lib, &ctx, tagged("Both", &["petg", "functional"])).unwrap();

    // A case-variant duplicate ('PETG' vs 'petg') must not inflate the required count past what
    // the project can ever satisfy.
    for filter in [["petg", "PETG"], ["petg", "petg"]] {
        let matched = list_projects(&lib, &ctx, &with_tags(&filter)).unwrap();
        assert_eq!(
            matched.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            [both.id.as_str()],
            "filter {filter:?}"
        );
    }
}

#[test]
fn archived_projects_are_hidden_unless_asked_for() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project = create_project(&lib, &ctx, input("Old")).unwrap();
    update_project(
        &lib,
        &ctx,
        &project.id,
        ProjectPatch {
            is_archived: Some(true),
            ..ProjectPatch::default()
        },
    )
    .unwrap();

    assert!(names(&lib, &ctx, &ProjectQuery::default()).is_empty());
    let all = ProjectQuery {
        include_archived: Some(true),
        ..ProjectQuery::default()
    };
    assert_eq!(names(&lib, &ctx, &all).len(), 1);
}

#[test]
fn sort_and_direction_are_honoured() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    create_project(&lib, &ctx, input("beta")).unwrap();
    create_project(&lib, &ctx, input("Alpha")).unwrap();

    let by_name = |dir| ProjectQuery {
        sort: Some(SortKey::Name),
        dir: Some(dir),
        ..ProjectQuery::default()
    };
    assert_eq!(names(&lib, &ctx, &by_name(SortDir::Asc)), ["Alpha", "beta"]);
    assert_eq!(
        names(&lib, &ctx, &by_name(SortDir::Desc)),
        ["beta", "Alpha"]
    );
}

#[test]
fn a_tied_updated_at_still_yields_both_projects_across_two_single_row_pages() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let a = create_project(&lib, &ctx, input("Alpha")).unwrap();
    let b = create_project(&lib, &ctx, input("Beta")).unwrap();

    // Two create calls can already land on the same millisecond by accident, which would make
    // this pass for the wrong reason. Setting updated_at explicitly makes the tie genuine.
    lib.db()
        .execute(
            "UPDATE projects SET updated_at = 1000 WHERE id IN (?, ?)",
            params![a.id, b.id],
        )
        .unwrap();

    let page0 = list_projects(&lib, &ctx, &paged(1, 0)).unwrap();

    // The defect this guards against only shows once the table is written to between two page
    // fetches: a later write can move a tied row to a different physical spot. Reproduce that by
    // deleting and reinserting `a`'s row verbatim: same id, same (still tied) updated_at, fresh
    // position.
    {
        let conn = lib.db();
        #[allow(clippy::type_complexity)]
        let row: (String, String, String, String, Option<String>, Option<String>, i64, String, i64, i64) = conn
            .query_row(
                "SELECT id, owner_id, name, dir_name, website, notes, is_archived, state, created_at, updated_at
                 FROM projects WHERE id = ?",
                params![a.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                    ))
                },
            )
            .unwrap();
        conn.execute("DELETE FROM projects WHERE id = ?", params![a.id])
            .unwrap();
        conn.execute(
            "INSERT INTO projects (id, owner_id, name, dir_name, website, notes, is_archived, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9],
        )
        .unwrap();
    }

    let page1 = list_projects(&lib, &ctx, &paged(1, 1)).unwrap();

    assert_eq!(page0.len(), 1);
    assert_eq!(page1.len(), 1);
    // Not one project twice, and not one of them missing: `p.id ASC` as a final tiebreaker is what
    // makes the two pages agree on a total order over the tied rows even after that write.
    let mut got = vec![page0[0].id.clone(), page1[0].id.clone()];
    let mut want = vec![a.id, b.id];
    got.sort();
    want.sort();
    assert_eq!(got, want);
}

#[test]
fn offset_beyond_the_end_returns_an_empty_array_not_an_error() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    create_project(&lib, &ctx, input("Solo")).unwrap();
    assert!(
        list_projects(&lib, &ctx, &paged(10, 50))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn omitting_limit_still_returns_every_row_unchanged_from_before_paging_existed() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    // Past the validation cap on `limit` (200), so no value the cap would accept as a default
    // could satisfy this by accident. Raw inserts, not create_project: this only needs rows, not
    // 201 real folders on disk.
    let total = 201;
    for i in 0..total {
        lib.db()
            .execute(
                "INSERT INTO projects (id, owner_id, name, dir_name, is_archived, state, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 0, 'ok', 0, 0)",
                params![new_id(), ctx.user_id, format!("Project {i}"), format!("dir-{i}")],
            )
            .unwrap();
    }
    assert_eq!(
        list_projects(&lib, &ctx, &ProjectQuery::default())
            .unwrap()
            .len(),
        total
    );
}

#[test]
fn offset_without_limit_is_ignored_not_treated_as_skip_everything() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    create_project(&lib, &ctx, input("One")).unwrap();
    create_project(&lib, &ctx, input("Two")).unwrap();
    // Spec 3.1: offset is "only meaningful with limit". A caller that sends offset alone must
    // still get the whole list back, not a list with rows silently skipped and no limit to bound
    // it.
    let query = ProjectQuery {
        offset: Some(1),
        ..ProjectQuery::default()
    };
    assert_eq!(list_projects(&lib, &ctx, &query).unwrap().len(), 2);
}

#[test]
fn the_id_tiebreaker_is_always_ascending_even_when_dir_is_desc() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let a = create_project(&lib, &ctx, input("Alpha")).unwrap();
    let b = create_project(&lib, &ctx, input("Beta")).unwrap();
    lib.db()
        .execute(
            "UPDATE projects SET updated_at = 1000 WHERE id IN (?, ?)",
            params![a.id, b.id],
        )
        .unwrap();
    let mut ids = [a.id.clone(), b.id.clone()];
    ids.sort();

    // "Always ASC, never following dir": it is there to make the order total, not to be
    // meaningful. Set membership (as the tied-page test above checks) cannot catch the tiebreaker
    // being made to track `dir`; this checks the actual emitted order.
    for dir in [SortDir::Asc, SortDir::Desc] {
        let query = ProjectQuery {
            dir: Some(dir),
            ..ProjectQuery::default()
        };
        let got: Vec<String> = list_projects(&lib, &ctx, &query)
            .unwrap()
            .into_iter()
            .map(|project| project.id)
            .collect();
        assert_eq!(got, ids, "dir {dir:?}");
    }
}

#[test]
fn file_counts_and_the_cover_file_id_come_back_on_the_list_dto() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project = create_project(&lib, &ctx, input("Benchy")).unwrap();
    seed_file_row(&lib, &project.id, "benchy.stl", "model", "pending");
    seed_file_row(&lib, &project.id, "notes.txt", "other", "pending");
    let ready = seed_file_row(&lib, &project.id, "benchy.3mf", "slicer_project", "ready");

    let listed = list_projects(&lib, &ctx, &ProjectQuery::default()).unwrap();
    assert_eq!(
        listed[0].file_counts,
        FileCounts {
            model: 1,
            slicer_project: 1,
            other: 1
        }
    );
    // No model preview is ready yet, so the slicer project thumbnail is the cover.
    assert_eq!(listed[0].cover_file_id.as_deref(), Some(ready.as_str()));

    let model_ready = seed_file_row(&lib, &project.id, "a-model.stl", "model", "ready");
    let listed = list_projects(&lib, &ctx, &ProjectQuery::default()).unwrap();
    assert_eq!(
        listed[0].cover_file_id.as_deref(),
        Some(model_ready.as_str())
    );
}

#[test]
fn list_tags_returns_the_owners_distinct_tags_sorted_case_insensitively() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    create_project(&lib, &ctx, tagged("A", &["Zebra"])).unwrap();
    create_project(&lib, &ctx, tagged("B", &["apple", "functional"])).unwrap();

    // 'Zebra' sorts before 'apple' under plain (case-sensitive) ordering ('Z' is 90, 'a' is 97),
    // so this only passes with COLLATE NOCASE actually applied, not by accident.
    assert_eq!(
        list_tags(&lib, &ctx).unwrap(),
        ["apple", "functional", "Zebra"]
    );
}

#[test]
fn list_tags_does_not_return_another_users_tags() {
    let lib = TempLibrary::new();
    let marc = seed_user(&lib, "marc");
    let anna = seed_user(&lib, "anna");
    create_project(&lib, &marc, tagged("Mine", &["petg"])).unwrap();

    assert!(list_tags(&lib, &anna).unwrap().is_empty());
    assert_eq!(list_tags(&lib, &marc).unwrap(), ["petg"]);
}

#[test]
fn get_project_returns_its_files_with_preview_state() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project = create_project(&lib, &ctx, input("Benchy")).unwrap();
    seed_file_row(&lib, &project.id, "benchy.stl", "model", "pending");

    let detail = get_project(&lib, &ctx, &project.id).unwrap();
    assert_eq!(detail.files.len(), 1);
    assert_eq!(detail.files[0].name, "benchy.stl");
    assert_eq!(detail.files[0].kind, spm_core::dto::FileKind::Model);
    assert_eq!(detail.files[0].preview_state, PreviewState::Pending);
}

// ---------------------------------------------------------------------------------------------
// Beyond the legacy suite: what the Rust port adds
// ---------------------------------------------------------------------------------------------

#[test]
fn create_and_update_validate_their_input_in_core() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    assert_eq!(
        code_of(create_project(&lib, &ctx, input("   "))),
        AppErrorCode::Validation
    );
    let created = create_project(&lib, &ctx, input("Benchy")).unwrap();
    let bad_url = ProjectPatch {
        website: Some(Some("not a url".to_owned())),
        ..ProjectPatch::default()
    };
    assert_eq!(
        code_of(update_project(&lib, &ctx, &created.id, bad_url)),
        AppErrorCode::Validation
    );
}
