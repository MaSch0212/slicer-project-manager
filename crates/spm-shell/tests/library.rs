//! Ported from the Electron shell's `library.test.ts` and `library.spec.ts`: planning the startup,
//! what the dialogs say, and holding one library folder open while letting the previous one go.
//! (The state-file cases of that file are in `state.rs`.)

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use spm_core::Library;
use spm_shell::library::{
    ConfirmOptions, FOLDER_PICKER_TITLE, LibraryHost, LibraryHostOptions, OpenFailure,
    PickerLanguage, PlanSource, PreviewRunner, PromptReason, PromptTrigger, StartPreviews,
    StartupPlan, confirm_remote_options, confirmed_at, explain_reason, folder_picker_options,
    menu_strings, mode_choice_at, mode_picker_options, picker_language, plan_startup,
    resolve_library_dir,
};
use spm_shell::state::{read_remembered_dir, remember_dir};
use spm_shell::sync::Done;
use support::{Event, IdlePreviews, ScriptedPrompts, World, env_of, eventually, fixtures, no_env};

fn is_dir(path: &Path) -> bool {
    path.is_dir()
}

fn plan(world: &World, env: &dyn Fn(&str) -> Option<String>) -> StartupPlan {
    plan_startup(env, &world.state_file(), &is_dir).unwrap()
}

// ---- planning --------------------------------------------------------------------------------------

#[test]
fn an_unreadable_state_file_is_treated_as_nothing_remembered_and_startup_asks() {
    let world = World::new();
    fs::create_dir_all(world.state_file().parent().unwrap()).unwrap();
    fs::write(world.state_file(), "{\"libraryDir\": \"D:\\\\Lib").unwrap(); // truncated
    assert_eq!(plan(&world, &no_env), StartupPlan::Ask);
}

#[test]
fn first_run_with_nothing_remembered_asks_which_mode() {
    let world = World::new();
    assert_eq!(plan(&world, &no_env), StartupPlan::Ask);
}

#[test]
fn a_remembered_folder_that_is_still_there_is_opened_without_asking() {
    let world = World::new();
    let dir = world.folder("lib");
    remember_dir(&world.state_file(), &dir.display().to_string()).unwrap();
    assert_eq!(
        plan(&world, &no_env),
        StartupPlan::Local {
            source: PlanSource::Remembered,
            dir
        }
    );
}

#[test]
fn a_remembered_folder_that_is_gone_renamed_away_or_now_a_file_returns_to_the_picker_naming_it() {
    let world = World::new();
    let dir = world.folder("lib");
    remember_dir(&world.state_file(), &dir.display().to_string()).unwrap();

    // Deleted.
    fs::remove_dir_all(&dir).unwrap();
    let StartupPlan::Picker { reason } = plan(&world, &no_env) else {
        panic!("a deleted folder must plan a picker");
    };
    assert_eq!(
        reason,
        PromptReason::Missing {
            dir: dir.display().to_string()
        }
    );
    assert!(
        explain_reason(&reason, PickerLanguage::En).contains("no longer there"),
        "{}",
        explain_reason(&reason, PickerLanguage::En)
    );

    // Renamed away: the folder is back under another name, the remembered one is still absent.
    let moved = world.folder("lib-moved");
    assert!(matches!(plan(&world, &no_env), StartupPlan::Picker { .. }));
    drop(moved);

    // Replaced by a file.
    fs::write(&dir, "not a folder").unwrap();
    assert!(matches!(
        plan(&world, &no_env),
        StartupPlan::Picker {
            reason: PromptReason::Missing { .. }
        }
    ));
}

#[test]
fn spm_library_dir_overrides_whatever_is_remembered_and_is_made_absolute() {
    let world = World::new();
    let remembered = world.folder("remembered");
    remember_dir(&world.state_file(), &remembered.display().to_string()).unwrap();
    let env = env_of(&[("SPM_LIBRARY_DIR", "relative-lib")]);
    let StartupPlan::Local { source, dir } = plan(&world, &env) else {
        panic!("the environment names a folder");
    };
    assert_eq!(source, PlanSource::Env);
    assert!(dir.is_absolute(), "{dir:?}");
    assert!(dir.ends_with("relative-lib"));
    assert_eq!(resolve_library_dir(&no_env), None);
    assert_eq!(
        resolve_library_dir(&env_of(&[("SPM_LIBRARY_DIR", "")])),
        None
    );
}

// ---- what the dialogs say --------------------------------------------------------------------------

#[test]
fn the_picker_asks_for_a_directory_and_lets_the_user_create_one() {
    let options = folder_picker_options(None, PickerLanguage::En);
    assert!(options.directory && options.create_directory);
    assert_eq!(options.title, FOLDER_PICKER_TITLE);
    assert_eq!(options.message, FOLDER_PICKER_TITLE);
    assert_eq!(options.button_label, "Open");
}

#[test]
fn an_explanation_reaches_the_picker_in_both_the_title_and_the_message() {
    // Which of the two a platform shows differs; the reason must be readable on either.
    let reason = PromptReason::Missing {
        dir: "D:\\Gone".to_owned(),
    };
    let options = folder_picker_options(Some(&reason), PickerLanguage::En);
    assert!(options.title.starts_with(FOLDER_PICKER_TITLE));
    assert!(options.title.contains("D:\\Gone"), "{}", options.title);
    assert!(options.message.contains("D:\\Gone"), "{}", options.message);
}

#[test]
fn the_picker_speaks_the_language_the_shell_was_told_to_speak() {
    let german = folder_picker_options(None, PickerLanguage::De);
    assert_eq!(german.title, "Bibliotheksordner auswählen");
    assert_eq!(german.button_label, "Öffnen");
    assert_eq!(picker_language(Some("de")), PickerLanguage::De);
    assert_eq!(picker_language(Some("DE")), PickerLanguage::De);
    assert_eq!(picker_language(Some("de-DE")), PickerLanguage::De);
    assert_eq!(picker_language(Some("en-GB")), PickerLanguage::En);
    assert_eq!(picker_language(Some("fr")), PickerLanguage::En);
    assert_eq!(picker_language(None), PickerLanguage::En);
}

#[test]
fn every_native_dialog_in_the_shell_speaks_the_same_set_of_languages() {
    let reasons = [
        PromptReason::Missing { dir: "D".into() },
        PromptReason::Unopenable {
            dir: "D".into(),
            detail: "why".into(),
        },
    ];
    for reason in &reasons {
        let (en, de) = (
            explain_reason(reason, PickerLanguage::En),
            explain_reason(reason, PickerLanguage::De),
        );
        assert!(!en.is_empty() && !de.is_empty() && en != de);
    }
    let (en, de) = (
        mode_picker_options(PickerLanguage::En),
        mode_picker_options(PickerLanguage::De),
    );
    assert_ne!(en.message, de.message);
    for (a, b) in en.buttons.iter().zip(&de.buttons) {
        assert!(!a.is_empty() && !b.is_empty() && a != b);
    }
    let (en, de): (ConfirmOptions, ConfirmOptions) = (
        confirm_remote_options("https://h", PickerLanguage::En),
        confirm_remote_options("https://h", PickerLanguage::De),
    );
    assert_ne!(en.message, de.message);
    assert_ne!(en.detail, de.detail);
    assert_ne!(
        menu_strings(PickerLanguage::En),
        menu_strings(PickerLanguage::De)
    );
    assert_eq!(mode_choice_at(2), spm_shell::library::ModeChoice::Cancel);
    assert_eq!(mode_choice_at(99), spm_shell::library::ModeChoice::Cancel);
    assert!(confirmed_at(1) && !confirmed_at(0));
}

// ---- opening folders ---------------------------------------------------------------------------------

#[test]
fn first_run_shows_the_picker_and_what_it_opens_is_remembered_for_next_time() {
    let world = World::new();
    let dir = world.folder("lib");
    fs::create_dir_all(dir.join("Benchy")).unwrap();
    fs::write(dir.join("Benchy").join("a.stl"), fixtures::cube_stl()).unwrap();

    let outcome = world.shell.start(&no_env).unwrap();
    assert!(matches!(outcome, spm_shell::shell::StartOutcome::Ask(None)));
    world.prompts.will_pick(Some(&dir));
    let opened = world
        .shell
        .pick_local_folder(PromptTrigger::Startup)
        .unwrap()
        .expect("a folder was picked");
    assert_eq!(opened.dir, dir.display().to_string());
    // Opened as a migrated library with its one local user.
    let session = world.shell.session().expect("the library is open");
    assert_eq!(
        session
            .lib
            .db()
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    world.shell.library().settle();
    assert_eq!(
        read_remembered_dir(&world.state_file()),
        Some(dir.display().to_string())
    );

    // The next launch opens it without prompting.
    let next = world.relaunch();
    let outcome = next.shell.start(&no_env).unwrap();
    assert!(matches!(outcome, spm_shell::shell::StartOutcome::Opened));
    assert_eq!(next.prompts.folder_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        next.shell.library().dir(),
        Some(std::path::absolute(&dir).unwrap())
    );
}

#[test]
fn a_remembered_folder_that_is_gone_lands_in_the_picker_with_the_explanation() {
    let world = World::new();
    let gone = world.folder("gone");
    remember_dir(&world.state_file(), &gone.display().to_string()).unwrap();
    fs::remove_dir_all(&gone).unwrap();
    let replacement = world.folder("replacement");

    let outcome = world.shell.start(&no_env).unwrap();
    let spm_shell::shell::StartOutcome::Ask(Some(reason)) = outcome else {
        panic!("a missing folder asks, with a reason");
    };
    world.prompts.will_pick(Some(&replacement));
    world
        .shell
        .prompt_for_folder(Some(&reason), PromptTrigger::Startup)
        .unwrap()
        .expect("opened");
    let (question, _) = world.prompts.folder_questions.lock().unwrap()[0].clone();
    assert!(
        question.title.contains(&gone.display().to_string()),
        "{}",
        question.title
    );
    assert!(question.message.contains("no longer there"));
    assert_eq!(
        world.shell.library().dir(),
        Some(std::path::absolute(&replacement).unwrap())
    );
    assert_eq!(
        read_remembered_dir(&world.state_file()),
        Some(replacement.display().to_string())
    );
}

#[test]
fn the_picker_is_told_whether_the_shell_or_the_user_asked() {
    let world = World::new();
    world.prompts.will_pick(None);
    world.prompts.will_pick(None);
    world
        .shell
        .pick_local_folder(PromptTrigger::Startup)
        .unwrap();
    world.shell.pick_local_folder(PromptTrigger::User).unwrap();
    let triggers: Vec<PromptTrigger> = world
        .prompts
        .folder_questions
        .lock()
        .unwrap()
        .iter()
        .map(|(_, trigger)| *trigger)
        .collect();
    assert_eq!(triggers, [PromptTrigger::Startup, PromptTrigger::User]);
}

#[test]
fn a_cancelled_picker_leaves_the_library_that_was_open_alone() {
    let world = World::new();
    let dir = world.folder("lib");
    world.shell.library().open(&dir, true).unwrap();
    let before = world.shell.session().unwrap();
    world.prompts.will_pick(None);
    assert!(
        world
            .shell
            .pick_local_folder(PromptTrigger::User)
            .unwrap()
            .is_none()
    );
    // The same open library, the same remembered folder, no second worker.
    assert_eq!(
        world.shell.library().dir(),
        Some(before.lib.dir().to_path_buf())
    );
    assert_eq!(
        read_remembered_dir(&world.state_file()),
        Some(dir.display().to_string())
    );
    assert_eq!(world.previews.started.load(Ordering::SeqCst), 1);
}

#[test]
fn a_cancelled_first_run_picker_leaves_a_usable_app_and_writes_no_state() {
    // library.spec: "a cancelled picker leaves a usable window, not a login screen or a dead app".
    let world = World::new();
    world.prompts.will_pick(None);
    assert!(
        world
            .shell
            .pick_local_folder(PromptTrigger::Startup)
            .unwrap()
            .is_none()
    );
    assert_eq!(world.shell.mode(), spm_shell::shell::ActiveMode::Unset);
    assert!(!world.state_file().exists());
    // A later pick works.
    let dir = world.folder("lib");
    world.prompts.will_pick(Some(&dir));
    assert!(
        world
            .shell
            .pick_local_folder(PromptTrigger::User)
            .unwrap()
            .is_some()
    );
    assert_eq!(world.shell.mode(), spm_shell::shell::ActiveMode::Local);
}

#[test]
fn re_picking_the_folder_that_is_already_open_changes_nothing() {
    let world = World::new();
    let dir = world.folder("lib");
    world.shell.library().open(&dir, true).unwrap();
    world.shell.library().settle();
    world.events.clear();
    world.prompts.will_pick(Some(&dir));
    world.shell.pick_local_folder(PromptTrigger::User).unwrap();
    assert_eq!(
        world.previews.started.load(Ordering::SeqCst),
        1,
        "no second worker"
    );
    assert!(
        world.events.events().is_empty(),
        "no reload: {:?}",
        world.events.events()
    );
}

#[test]
fn switching_folders_closes_the_one_that_was_open_stops_its_worker_and_reloads_the_window() {
    let released = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let world = {
        let released = Arc::clone(&released);
        World::with(move |options| {
            options.on_released =
                Arc::new(move |dir| released.lock().unwrap().push(dir.to_path_buf()));
        })
    };
    let (first, second) = (world.folder("one"), world.folder("two"));
    fs::create_dir_all(second.join("Second Project")).unwrap();
    fs::write(
        second.join("Second Project").join("a.stl"),
        fixtures::cube_stl(),
    )
    .unwrap();

    world.shell.library().open(&first, true).unwrap();
    world.shell.library().open(&second, true).unwrap();
    world.shell.library().settle();

    assert_eq!(
        world.previews.stopped.load(Ordering::SeqCst),
        1,
        "the old worker was stopped"
    );
    assert_eq!(
        *released.lock().unwrap(),
        [std::path::absolute(&first).unwrap()]
    );
    // The window was reloaded for the switch, and the new folder's project was adopted.
    assert!(world.events.reloads() >= 1);
    let projects = spm_core::list_projects(
        &world.shell.session().unwrap().lib,
        &world.shell.session().unwrap().ctx,
        &Default::default(),
    )
    .unwrap();
    assert_eq!(projects.len(), 1, "{projects:?}");
    assert_eq!(
        read_remembered_dir(&world.state_file()),
        Some(second.display().to_string())
    );
    // On Windows an open database file cannot be deleted: the old folder really is let go of.
    #[cfg(windows)]
    fs::remove_dir_all(&first).expect("the old folder's database is closed");
}

#[test]
fn a_folder_that_will_not_open_leaves_the_previous_one_open_and_remembered() {
    let world = World::new();
    let good = world.folder("good");
    world.shell.library().open(&good, true).unwrap();
    // A path *under a file* cannot be created or opened.
    let blocker = world.root.path().join("blocker");
    fs::write(&blocker, "x").unwrap();
    let result = world.shell.library().open(&blocker.join("sub"), true);
    assert!(result.is_err());
    assert_eq!(
        world.shell.library().dir(),
        Some(std::path::absolute(&good).unwrap())
    );
    assert_eq!(
        read_remembered_dir(&world.state_file()),
        Some(good.display().to_string())
    );
}

#[test]
fn a_remembered_folder_that_will_not_open_degrades_to_the_picker_rather_than_failing() {
    let world = World::new();
    let blocker = world.root.path().join("blocker");
    fs::write(&blocker, "x").unwrap();
    let dir = blocker.join("sub");
    match world
        .shell
        .library()
        .open_planned(&dir, PlanSource::Remembered)
    {
        Err(OpenFailure::Prompt(PromptReason::Unopenable { dir: named, detail })) => {
            assert_eq!(named, dir.display().to_string());
            assert!(!detail.is_empty());
        }
        other => panic!("expected an unopenable prompt reason, got {other:?}"),
    }
}

#[test]
fn spm_library_dir_naming_a_folder_that_will_not_open_is_a_startup_failure_not_a_prompt() {
    let world = World::new();
    let blocker = world.root.path().join("blocker");
    fs::write(&blocker, "x").unwrap();
    let env = env_of(&[(
        "SPM_LIBRARY_DIR",
        &blocker.join("sub").display().to_string(),
    )]);
    assert!(world.shell.start(&env).is_err());
    assert_eq!(world.prompts.folder_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn an_environment_override_is_not_written_to_the_state_file() {
    let world = World::new();
    let dir = world.folder("lib");
    let env = env_of(&[("SPM_LIBRARY_DIR", &dir.display().to_string())]);
    assert!(matches!(
        world.shell.start(&env).unwrap(),
        spm_shell::shell::StartOutcome::Opened
    ));
    assert!(!world.state_file().exists(), "{:?}", world.state());
}

#[test]
fn opening_a_folder_adopts_what_is_in_it_and_reloads_the_window_when_it_finds_something() {
    let world = World::new();
    let dir = world.folder("lib");
    fs::create_dir_all(dir.join("Benchy")).unwrap();
    fs::write(dir.join("Benchy").join("a.stl"), fixtures::cube_stl()).unwrap();
    world.shell.library().open(&dir, true).unwrap();
    // Once at open, and again when the rescan has adopted the project.
    eventually(
        Duration::from_secs(10),
        "a second reload after the rescan",
        || world.events.reloads() >= 2,
    )
    .await_blocking();
    world.shell.library().settle();
    assert_eq!(world.events.reloads(), 2);
}

#[test]
fn an_empty_folder_is_not_reloaded_a_second_time_for_a_rescan_that_found_nothing() {
    let world = World::new();
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    world.shell.library().settle();
    assert_eq!(world.events.reloads(), 1);
}

// ---- letting go ----------------------------------------------------------------------------------------

/// Preview runners whose `stop` blocks until the test lets it, in the order they were started.
#[derive(Default)]
struct BlockingPreviews {
    stops_called: Arc<AtomicUsize>,
    gates: Mutex<Vec<Arc<Done>>>,
}

struct BlockingRunner {
    stops_called: Arc<AtomicUsize>,
    gate: Arc<Done>,
}

impl PreviewRunner for BlockingRunner {
    fn stop(self: Box<Self>) {
        self.stops_called.fetch_add(1, Ordering::SeqCst);
        self.gate.wait();
    }
}

impl BlockingPreviews {
    fn starter(self: &Arc<Self>) -> StartPreviews {
        let this = Arc::clone(self);
        Arc::new(move |_lib: &Library| {
            let gate = Arc::new(Done::default());
            this.gates.lock().unwrap().push(Arc::clone(&gate));
            Box::new(BlockingRunner {
                stops_called: Arc::clone(&this.stops_called),
                gate,
            })
        })
    }

    fn release(&self, index: usize) {
        self.gates.lock().unwrap()[index].finish();
    }
}

fn host_with(
    previews: &Arc<BlockingPreviews>,
    released: &Arc<Mutex<Vec<PathBuf>>>,
) -> (Arc<LibraryHost>, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let mut options =
        LibraryHostOptions::new(root.path().join("state.json"), ScriptedPrompts::new());
    options.start_previews = previews.starter();
    let released = Arc::clone(released);
    options.on_released = Arc::new(move |dir| released.lock().unwrap().push(dir.to_path_buf()));
    (LibraryHost::new(options), root)
}

#[test]
fn a_switch_does_not_wait_for_a_preview_run_and_the_old_library_closes_when_it_ends() {
    let previews = Arc::new(BlockingPreviews::default());
    let released = Arc::new(Mutex::new(Vec::new()));
    let (host, root) = host_with(&previews, &released);
    let (one, two) = (root.path().join("one"), root.path().join("two"));
    host.open(&one, false).unwrap();

    let started = std::time::Instant::now();
    host.open(&two, false).unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the switch waited for the old run"
    );
    // The old run was told to stop at once and is still "rendering"; the folder is not closed.
    wait_until(|| previews.stops_called.load(Ordering::SeqCst) == 1);
    assert!(released.lock().unwrap().is_empty());

    previews.release(0);
    wait_until(|| released.lock().unwrap().len() == 1);
    assert_eq!(
        *released.lock().unwrap(),
        [std::path::absolute(&one).unwrap()]
    );
    host.close_current();
    previews.release(1);
    host.settle();
}

#[test]
fn a_second_switch_stops_the_middle_library_at_once_not_after_the_first_release_finishes() {
    let previews = Arc::new(BlockingPreviews::default());
    let released = Arc::new(Mutex::new(Vec::new()));
    let (host, root) = host_with(&previews, &released);
    let (a, b, c) = (
        root.path().join("a"),
        root.path().join("b"),
        root.path().join("c"),
    );
    host.open(&a, false).unwrap();
    host.open(&b, false).unwrap();
    wait_until(|| previews.stops_called.load(Ordering::SeqCst) == 1); // A is stopping, blocked
    host.open(&c, false).unwrap();
    // B's worker is stopped *while A's stop is still blocked*.
    wait_until(|| previews.stops_called.load(Ordering::SeqCst) == 2);
    assert!(released.lock().unwrap().is_empty(), "nothing is closed yet");

    previews.release(0);
    previews.release(1);
    wait_until(|| released.lock().unwrap().len() == 2);
    host.close_current();
    previews.release(2);
    host.settle();
}

#[test]
fn a_folders_handle_is_held_until_every_earlier_release_has_finished() {
    let previews = Arc::new(BlockingPreviews::default());
    let released = Arc::new(Mutex::new(Vec::new()));
    let (host, root) = host_with(&previews, &released);
    let (a, b, c) = (
        root.path().join("a"),
        root.path().join("b"),
        root.path().join("c"),
    );
    host.open(&a, false).unwrap();
    host.open(&b, false).unwrap();
    host.open(&c, false).unwrap();
    wait_until(|| previews.stops_called.load(Ordering::SeqCst) == 2);

    // B's worker finishes first, but B's database stays open: A's release is still pending.
    previews.release(1);
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        released.lock().unwrap().is_empty(),
        "{:?}",
        released.lock().unwrap()
    );

    previews.release(0);
    wait_until(|| released.lock().unwrap().len() == 2);
    assert_eq!(
        *released.lock().unwrap(),
        [
            std::path::absolute(&a).unwrap(),
            std::path::absolute(&b).unwrap()
        ],
        "closed oldest first"
    );
    host.close_current();
    previews.release(2);
    host.settle();
}

#[test]
fn a_state_file_that_cannot_be_written_does_not_fail_the_open() {
    let root = tempfile::tempdir().unwrap();
    // The state file's parent is a file, so no write can succeed.
    let blocker = root.path().join("blocker");
    fs::write(&blocker, "x").unwrap();
    let prompts = ScriptedPrompts::new();
    let events = support::Recorder::new();
    let mut options =
        spm_shell::shell::ShellOptions::new(blocker.join("state.json"), prompts, events.clone());
    options.start_previews = Arc::new(IdlePreviews::default()).starter();
    let shell = spm_shell::shell::Shell::new(options);
    let dir = root.path().join("lib");
    shell
        .library()
        .open(&dir, true)
        .expect("the folder still opens");
    assert!(shell.session().is_some());
    assert!(events.events().contains(&Event::Reload));
}

#[test]
fn a_second_prompt_while_one_is_open_does_not_open_a_second_dialog() {
    let world = World::new();
    let dir = world.folder("lib");
    world
        .prompts
        .hold_dialogs_open_for(Duration::from_millis(400));
    world.prompts.will_pick(Some(&dir));
    let host = Arc::clone(world.shell.library());
    let first = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.prompt(None, PromptTrigger::User))
    };
    wait_until(|| world.prompts.folder_calls.load(Ordering::SeqCst) == 1);
    let second = host.prompt(None, PromptTrigger::User);
    let first = first.join().unwrap();
    // One dialog, one answer, shared.
    assert_eq!(world.prompts.folder_calls.load(Ordering::SeqCst), 1);
    assert!(first.unwrap().is_some() && second.unwrap().is_some());
    // A prompt after the answer is a new dialog.
    world.prompts.will_pick(None);
    host.prompt(None, PromptTrigger::User).unwrap();
    assert_eq!(world.prompts.folder_calls.load(Ordering::SeqCst), 2);
}

#[test]
fn the_default_worker_is_the_real_one_and_shutdown_stops_it() {
    let root = tempfile::tempdir().unwrap();
    let options = LibraryHostOptions::new(root.path().join("state.json"), ScriptedPrompts::new());
    let host = LibraryHost::new(options);
    host.open(&root.path().join("lib"), false).unwrap();
    assert!(host.session().is_some());
    assert!(
        host.shutdown(Duration::from_secs(30)),
        "the worker stopped and the library closed"
    );
    assert!(host.session().is_none());
}

fn wait_until(mut check: impl FnMut() -> bool) {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out");
}

trait AwaitBlocking {
    fn await_blocking(self);
}

impl<F: std::future::Future<Output = ()>> AwaitBlocking for F {
    fn await_blocking(self) {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(self);
    }
}
