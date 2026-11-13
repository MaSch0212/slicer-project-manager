//! The desktop sync against a real library: a [`SyncServer`] that calls the same core use cases the
//! HTTP routes do, in this process, so every pass is the real comparison with real files on both
//! sides.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use spm_core::library_sync::{
    BaseVersion, SyncFile, SyncManifest, put_file_at, sync_manifest, trash_file, trash_project,
};
use spm_core::testing::{TempLibrary, seed_user};
use spm_core::validate::CreateProjectInput;
use spm_core::{AppError, AppErrorCode, Ctx, create_project, resolve_file_path};
use spm_shell::library_sync::{
    SYNC_STATE_DIR, SyncEngine, SyncError, SyncPhase, SyncReport, SyncServer, SyncState, sync_once,
};

struct CoreServer {
    lib: TempLibrary,
    ctx: Ctx,
    signed_in: AtomicBool,
}

fn mapped(error: AppError) -> SyncError {
    match error.code {
        AppErrorCode::Conflict => SyncError::Conflict,
        AppErrorCode::Unauthorized => SyncError::Unauthorized,
        _ => SyncError::Other(error),
    }
}

impl SyncServer for CoreServer {
    fn has_session(&self) -> bool {
        self.signed_in.load(Ordering::SeqCst)
    }
    fn manifest(&self) -> Result<SyncManifest, SyncError> {
        sync_manifest(&self.lib, &self.ctx).map_err(mapped)
    }
    fn create_project(&self, name: &str) -> Result<String, SyncError> {
        create_project(
            &self.lib,
            &self.ctx,
            CreateProjectInput {
                name: name.to_owned(),
                ..Default::default()
            },
        )
        .map(|project| project.id)
        .map_err(mapped)
    }
    fn download(&self, file_id: &str, destination: &Path) -> Result<(), SyncError> {
        let resolved = resolve_file_path(&self.lib, &self.ctx, file_id).map_err(mapped)?;
        fs::copy(resolved.abs_path, destination)?;
        Ok(())
    }
    fn put_file(
        &self,
        project_id: &str,
        rel_path: &str,
        base: BaseVersion,
        file: &Path,
        size_bytes: u64,
    ) -> Result<SyncFile, SyncError> {
        put_file_at(
            &self.lib,
            &self.ctx,
            project_id,
            rel_path,
            base,
            size_bytes as i64,
            fs::File::open(file)?,
        )
        .map_err(mapped)
    }
    fn trash_file(&self, file_id: &str, base: BaseVersion) -> Result<(), SyncError> {
        trash_file(&self.lib, &self.ctx, file_id, base).map_err(mapped)
    }
    fn trash_project(&self, project_id: &str) -> Result<(), SyncError> {
        trash_project(&self.lib, &self.ctx, project_id).map_err(mapped)
    }
}

struct World {
    server: Arc<CoreServer>,
    local: tempfile::TempDir,
    state: SyncState,
}

impl World {
    fn new() -> World {
        let lib = TempLibrary::new();
        let ctx = seed_user(&lib, "marc");
        World {
            server: Arc::new(CoreServer {
                lib,
                ctx,
                signed_in: AtomicBool::new(true),
            }),
            local: tempfile::tempdir().unwrap(),
            state: SyncState::default(),
        }
    }

    fn root(&self) -> &Path {
        self.local.path()
    }

    fn sync(&mut self) -> SyncReport {
        let report = sync_once(self.server.as_ref(), self.local.path(), &mut self.state)
            .unwrap_or_else(|error| panic!("the pass failed: {error:?}"));
        self.state.save(self.local.path()).unwrap();
        report
    }

    /// A project on the server with files, as if made in the web app.
    fn server_project(&self, name: &str, files: &[(&str, &str)]) -> String {
        let id = self.server.create_project(name).unwrap();
        for (rel, text) in files {
            self.server_put(&id, rel, BaseVersion::Absent, text);
        }
        id
    }

    fn server_put(&self, project_id: &str, rel: &str, base: BaseVersion, text: &str) -> SyncFile {
        put_file_at(
            &self.server.lib,
            &self.server.ctx,
            project_id,
            rel,
            base,
            text.len() as i64,
            std::io::Cursor::new(text.as_bytes().to_vec()),
        )
        .unwrap()
    }

    fn server_dir(&self, dir_name: &str) -> PathBuf {
        self.server.lib.dir().join("marc").join(dir_name)
    }

    fn server_files(&self) -> Vec<(String, String)> {
        let manifest = sync_manifest(&self.server.lib, &self.server.ctx).unwrap();
        let mut out = Vec::new();
        for project in manifest.projects {
            for file in project.files {
                let path = resolve_file_path(&self.server.lib, &self.server.ctx, &file.id)
                    .unwrap()
                    .abs_path;
                out.push((
                    format!("{}/{}", project.dir_name, file.rel_path),
                    fs::read_to_string(path).unwrap(),
                ));
            }
        }
        out.sort();
        out
    }

    fn local_files(&self) -> Vec<(String, String)> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, String)>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                let rel = if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}/{name}")
                };
                if entry.file_type().unwrap().is_dir() {
                    walk(&entry.path(), &rel, out);
                } else {
                    out.push((rel, fs::read_to_string(entry.path()).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(self.root(), "", &mut out);
        out.sort();
        out
    }

    fn write_local(&self, rel: &str, text: &str) {
        let path = rel
            .split('/')
            .fold(self.root().to_path_buf(), |path, part| path.join(part));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn sha_of(&self, project_id: &str, rel: &str) -> [u8; 32] {
        let manifest = sync_manifest(&self.server.lib, &self.server.ctx).unwrap();
        let file = manifest
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .and_then(|project| project.files.iter().find(|file| file.rel_path == rel))
            .unwrap();
        spm_core::library_sync::parse_hex(&file.sha256).unwrap()
    }
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = items
        .iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect();
    out.sort();
    out
}

/// A local edit must look changed even within the file system's timestamp resolution.
fn later() {
    std::thread::sleep(Duration::from_millis(20));
}

#[test]
fn a_first_pass_brings_every_project_down_and_a_second_does_nothing() {
    let mut world = World::new();
    world.server_project("Robot", &[("arm.stl", "arm"), ("parts/leg.stl", "leg")]);
    world.server_project("Benchy", &[("benchy.3mf", "boat")]);

    let report = world.sync();
    assert_eq!(report.downloaded, 3);
    assert_eq!(
        world.local_files(),
        pairs(&[
            ("Benchy/benchy.3mf", "boat"),
            ("Robot/arm.stl", "arm"),
            ("Robot/parts/leg.stl", "leg"),
        ])
    );
    assert!(
        world
            .root()
            .join(SYNC_STATE_DIR)
            .join("state.json")
            .is_file()
    );
    assert!(!world.sync().changed_anything());
}

#[test]
fn a_folder_made_here_becomes_a_project_on_the_server_with_its_files() {
    let mut world = World::new();
    world.write_local("Made Here/cube.stl", "cube");
    world.write_local("Made Here/sub/part.stl", "part");

    let report = world.sync();
    assert_eq!(report.projects_created, 1);
    assert_eq!(report.uploaded, 2);
    assert_eq!(
        world.server_files(),
        pairs(&[
            ("Made Here/cube.stl", "cube"),
            ("Made Here/sub/part.stl", "part")
        ])
    );
    assert!(!world.sync().changed_anything());
}

#[test]
fn an_edit_on_either_side_reaches_the_other() {
    let mut world = World::new();
    let id = world.server_project("Robot", &[("arm.stl", "one")]);
    world.sync();

    later();
    world.write_local("Robot/arm.stl", "two (here)");
    assert_eq!(world.sync().uploaded, 1);
    assert_eq!(
        world.server_files(),
        pairs(&[("Robot/arm.stl", "two (here)")])
    );

    let sha = world.sha_of(&id, "arm.stl");
    world.server_put(&id, "arm.stl", BaseVersion::Hash(sha), "three (there)");
    assert_eq!(world.sync().downloaded, 1);
    assert_eq!(
        world.local_files(),
        pairs(&[("Robot/arm.stl", "three (there)")])
    );
}

#[test]
fn an_edit_on_both_sides_keeps_both() {
    let mut world = World::new();
    let id = world.server_project("Robot", &[("arm.stl", "one")]);
    world.sync();

    later();
    world.write_local("Robot/arm.stl", "mine");
    let sha = world.sha_of(&id, "arm.stl");
    world.server_put(&id, "arm.stl", BaseVersion::Hash(sha), "theirs");

    let report = world.sync();
    assert_eq!(report.conflicts, 1);
    let local = world.local_files();
    assert_eq!(local.len(), 2, "{local:?}");
    assert!(
        local[0].0.starts_with("Robot/arm (conflict from ") && local[0].0.ends_with(").stl"),
        "{local:?}"
    );
    assert_eq!(local[0].1, "mine");
    assert_eq!(local[1], ("Robot/arm.stl".to_owned(), "theirs".to_owned()));
    assert_eq!(world.server_files(), local);
    assert!(!world.sync().changed_anything());
}

#[test]
fn deletions_go_to_the_trash_on_the_other_side() {
    let mut world = World::new();
    world.server_project("Robot", &[("arm.stl", "arm"), ("leg.stl", "leg")]);
    world.sync();

    fs::remove_file(world.root().join("Robot").join("arm.stl")).unwrap();
    assert_eq!(world.sync().deleted_there, 1);
    assert_eq!(world.server_files(), pairs(&[("Robot/leg.stl", "leg")]));
    assert!(world.server.lib.dir().join(".spm").join("trash").is_dir());

    let manifest = sync_manifest(&world.server.lib, &world.server.ctx).unwrap();
    let leg = &manifest.projects[0].files[0];
    trash_file(
        &world.server.lib,
        &world.server.ctx,
        &leg.id,
        BaseVersion::Any,
    )
    .unwrap();
    assert_eq!(world.sync().deleted_here, 1);
    assert!(world.local_files().is_empty());
    assert!(world.root().join(SYNC_STATE_DIR).join("trash").is_dir());
}

#[test]
fn a_folder_deleted_here_trashes_its_project_and_one_deleted_there_trashes_the_folder() {
    let mut world = World::new();
    world.server_project("Robot", &[("arm.stl", "arm")]);
    let benchy = world.server_project("Benchy", &[("boat.stl", "boat")]);
    world.sync();

    fs::remove_dir_all(world.root().join("Robot")).unwrap();
    assert_eq!(world.sync().deleted_there, 1);
    assert!(!world.server_dir("Robot").exists());

    trash_project(&world.server.lib, &world.server.ctx, &benchy).unwrap();
    // The last folder: the pass refuses to act on a folder that came back empty, so keep one.
    world.write_local("Keep/keep.stl", "keep");
    let report = world.sync();
    assert_eq!(report.deleted_here, 1);
    assert!(!world.root().join("Benchy").exists());
}

#[test]
fn a_project_deleted_there_but_changed_here_comes_back_as_a_new_project() {
    let mut world = World::new();
    let id = world.server_project("Robot", &[("arm.stl", "arm")]);
    world.sync();

    later();
    world.write_local("Robot/arm.stl", "edited here");
    trash_project(&world.server.lib, &world.server.ctx, &id).unwrap();
    let report = world.sync();
    assert_eq!(report.projects_created, 1);
    assert_eq!(
        world.server_files(),
        pairs(&[("Robot/arm.stl", "edited here")])
    );
}

#[test]
fn an_emptied_sync_folder_deletes_nothing_on_the_server() {
    let mut world = World::new();
    world.server_project("Robot", &[("arm.stl", "arm")]);
    world.sync();

    fs::remove_dir_all(world.root().join("Robot")).unwrap();
    let error = sync_once(world.server.as_ref(), world.local.path(), &mut world.state).unwrap_err();
    assert!(matches!(error, SyncError::Other(_)), "{error:?}");
    assert_eq!(world.server_files(), pairs(&[("Robot/arm.stl", "arm")]));
}

#[test]
fn a_folder_synced_for_one_account_refuses_another() {
    let mut world = World::new();
    world.sync();
    world.state.user_id = Some("somebody-else".to_owned());
    let error = sync_once(world.server.as_ref(), world.local.path(), &mut world.state).unwrap_err();
    assert!(matches!(error, SyncError::Other(ref e) if e.code == AppErrorCode::Conflict));
}

fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn the_engine_waits_for_a_sign_in_then_follows_the_folder_by_its_watcher() {
    let world = World::new();
    world.server.signed_in.store(false, Ordering::SeqCst);
    world.server_project("Robot", &[("arm.stl", "arm")]);
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&changes);
    let engine = SyncEngine::start(
        world.server.clone(),
        world.root().to_path_buf(),
        // A long poll: only the watcher or a kick can start the passes this test waits for.
        Duration::from_secs(600),
        Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .unwrap();

    eventually("the worker to wait for a sign-in", || {
        engine.status().phase == SyncPhase::WaitingForSignIn
    });
    world.server.signed_in.store(true, Ordering::SeqCst);
    eventually("the first pass", || {
        world.root().join("Robot").join("arm.stl").is_file()
    });
    eventually("the page to be told", || {
        changes.load(Ordering::SeqCst) >= 1
    });
    let manifest = sync_manifest(&world.server.lib, &world.server.ctx).unwrap();
    let arm = &manifest.projects[0].files[0];
    assert_eq!(
        engine
            .local_path_of(&arm.id)
            .map(|path| fs::canonicalize(path).unwrap()),
        Some(fs::canonicalize(world.root().join("Robot").join("arm.stl")).unwrap())
    );

    // A folder made in Explorer: only the watcher can notice.
    world.write_local("New One/cube.stl", "cube");
    eventually("the new folder to reach the server", || {
        world
            .server_files()
            .contains(&("New One/cube.stl".to_owned(), "cube".to_owned()))
    });
    eventually("the worker to settle", || {
        engine.status().phase == SyncPhase::Idle
    });
    drop(engine);
}
