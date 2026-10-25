//! Ported from the Electron shell's `shell.test.ts`: which library the app is looking at, how it got
//! there, and what it lets go of on the way. The Electron shell replaced its window when the
//! transport changed; here there is one transport, so "replace the window" is
//! `Navigate(...)` and "reload the window" is `Reload`.

mod support;

use std::fs;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use spm_shell::library::{
    ModeChoice, PickerLanguage, PromptTrigger, confirm_remote_options, confirmed_at,
    mode_picker_options,
};
use spm_shell::shell::{ActiveMode, ShellRoute, StartOutcome};
use spm_shell::state::{
    ShellMode, read_remembered_dir, read_remembered_mode, read_remembered_remote,
};
use support::{Event, Upstream, World, answer, env_of, no_env, proxy_request};

const SERVER: &str = "https://print.example.com";

fn remote_state(world: &World, url: &str) {
    fs::create_dir_all(world.state_file().parent().unwrap()).unwrap();
    fs::write(
        world.state_file(),
        serde_json::json!({ "mode": "remote", "remoteUrl": url }).to_string(),
    )
    .unwrap();
}

fn connect(world: &World, url: &str) -> Option<String> {
    world.prompts.will_confirm(true);
    world
        .shell
        .connect_remote(url)
        .unwrap()
        .map(|library| library.origin)
}

// ---- the mode question -----------------------------------------------------------------------------

#[test]
fn the_mode_question_offers_exactly_the_two_modes_and_a_way_out() {
    let options = mode_picker_options(PickerLanguage::En);
    assert_eq!(
        options.buttons,
        ["Open a local folder…", "Connect to a server…", "Not now"]
    );
    assert_eq!(options.default_index, 0, "local is the default");
    assert_eq!(options.cancel_index, 2, "'not now' is the escape");
    assert_eq!(
        mode_picker_options(PickerLanguage::De).buttons,
        [
            "Lokalen Ordner öffnen…",
            "Mit einem Server verbinden…",
            "Später"
        ]
    );
}

#[test]
fn first_run_asks_which_mode_and_nothing_is_open_until_it_is_answered() {
    let world = World::new();
    assert!(matches!(
        world.shell.start(&no_env).unwrap(),
        StartOutcome::Ask(None)
    ));
    assert_eq!(world.shell.mode(), ActiveMode::Unset);
    assert!(world.shell.session().is_none() && world.shell.remote().is_none());
    // `start` decides; it asks nothing itself.
    assert_eq!(world.prompts.mode_calls.load(Ordering::SeqCst), 0);
    assert!(world.events.events().is_empty());
}

#[test]
fn answering_local_goes_on_to_the_folder_dialog_and_remembers_the_mode_with_the_folder() {
    let world = World::new();
    let dir = world.folder("lib");
    world.prompts.will_choose(ModeChoice::Local);
    world.prompts.will_pick(Some(&dir));
    assert_eq!(
        world.shell.ask_for_mode(PromptTrigger::User),
        ModeChoice::Local
    );
    assert_eq!(world.shell.mode(), ActiveMode::Local);
    assert_eq!(
        read_remembered_mode(&world.state_file()),
        Some(ShellMode::Local)
    );
    assert_eq!(
        read_remembered_dir(&world.state_file()),
        Some(dir.display().to_string())
    );
    // The page is reloaded onto the library, not sent somewhere else.
    assert!(world.events.reloads() >= 1);
    assert!(
        !world
            .events
            .events()
            .iter()
            .any(|e| matches!(e, Event::Navigate(_)))
    );
}

#[test]
fn answering_remote_sends_the_page_to_the_connect_page_and_opens_nothing_yet() {
    let world = World::new();
    world.prompts.will_choose(ModeChoice::Remote);
    assert_eq!(
        world.shell.ask_for_mode(PromptTrigger::User),
        ModeChoice::Remote
    );
    assert_eq!(
        world.events.events(),
        [Event::Navigate(ShellRoute::Connect)]
    );
    assert_eq!(world.shell.mode(), ActiveMode::Unset);
    assert!(!world.state_file().exists(), "no server is saved");
    assert_eq!(world.prompts.confirm_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn cancelling_changes_nothing_at_all() {
    let world = World::new();
    assert_eq!(connect(&world, SERVER).as_deref(), Some(SERVER));
    world.events.clear();
    world.prompts.will_choose(ModeChoice::Cancel);
    assert_eq!(
        world.shell.ask_for_mode(PromptTrigger::User),
        ModeChoice::Cancel
    );
    assert_eq!(world.shell.mode(), ActiveMode::Remote);
    assert_eq!(world.shell.remote().unwrap().origin(), SERVER);
    assert!(world.events.events().is_empty());
}

#[test]
fn two_mode_questions_at_once_are_one_dialog() {
    let world = World::new();
    world
        .prompts
        .hold_dialogs_open_for(Duration::from_millis(400));
    world.prompts.will_choose(ModeChoice::Cancel);
    let (shell_a, shell_b) = (Arc::clone(&world.shell), Arc::clone(&world.shell));
    let first = std::thread::spawn(move || shell_a.ask_for_mode(PromptTrigger::User));
    while world.prompts.mode_calls.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(5));
    }
    let second = shell_b.ask_for_mode(PromptTrigger::User);
    assert_eq!(first.join().unwrap(), second);
    assert_eq!(world.prompts.mode_calls.load(Ordering::SeqCst), 1);
}

// ---- startup ----------------------------------------------------------------------------------------

#[tokio::test]
async fn a_remembered_server_is_reconnected_at_startup_without_asking_or_contacting_it() {
    let upstream = Upstream::start(|_| answer(200, &[], "{}")).await;
    let world = World::new();
    remote_state(&world, &upstream.origin);
    let before = fs::read(world.state_file()).unwrap();

    assert!(matches!(
        world.shell.start(&no_env).unwrap(),
        StartOutcome::Opened
    ));
    assert_eq!(world.shell.mode(), ActiveMode::Remote);
    assert_eq!(world.shell.remote().unwrap().origin(), upstream.origin);
    assert_eq!(
        world.prompts.confirm_calls.load(Ordering::SeqCst),
        0,
        "not re-confirmed"
    );
    assert!(
        upstream.requests().is_empty(),
        "the server was not contacted"
    );
    assert!(
        world.events.events().is_empty(),
        "no window was asked to move"
    );
    assert_eq!(
        fs::read(world.state_file()).unwrap(),
        before,
        "state.json was not rewritten"
    );
}

#[test]
fn a_state_file_written_before_modes_existed_a_folder_and_no_mode_still_opens_its_folder() {
    let world = World::new();
    let dir = world.folder("lib");
    fs::create_dir_all(world.state_file().parent().unwrap()).unwrap();
    fs::write(
        world.state_file(),
        serde_json::json!({ "libraryDir": dir.display().to_string() }).to_string(),
    )
    .unwrap();
    assert!(matches!(
        world.shell.start(&no_env).unwrap(),
        StartOutcome::Opened
    ));
    assert_eq!(world.shell.mode(), ActiveMode::Local);
    assert_eq!(world.prompts.folder_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn a_remembered_remote_mode_with_no_usable_url_asks_again_rather_than_guessing() {
    for state in [
        serde_json::json!({ "mode": "remote" }),
        serde_json::json!({ "mode": "remote", "remoteUrl": "" }),
        serde_json::json!({ "mode": "remote", "remoteUrl": "not a url" }),
        serde_json::json!({ "mode": "remote", "remoteUrl": "ftp://example.com" }),
        serde_json::json!({ "mode": "remote", "remoteUrl": "https://example.com/path" }),
        serde_json::json!({ "mode": "cloud", "remoteUrl": SERVER }),
    ] {
        let world = World::new();
        fs::create_dir_all(world.state_file().parent().unwrap()).unwrap();
        fs::write(world.state_file(), state.to_string()).unwrap();
        assert!(
            matches!(world.shell.start(&no_env).unwrap(), StartOutcome::Ask(None)),
            "{state}"
        );
        assert_eq!(world.shell.mode(), ActiveMode::Unset, "{state}");
    }
}

#[test]
fn switching_modes_keeps_the_other_mode_target_written_down() {
    let world = World::new();
    let dir = world.folder("lib");
    world.shell.library().open(&dir, true).unwrap();
    assert_eq!(connect(&world, SERVER).as_deref(), Some(SERVER));
    assert_eq!(
        read_remembered_mode(&world.state_file()),
        Some(ShellMode::Remote)
    );
    assert_eq!(
        read_remembered_remote(&world.state_file()).as_deref(),
        Some(SERVER)
    );
    assert_eq!(
        read_remembered_dir(&world.state_file()),
        Some(dir.display().to_string())
    );
}

#[test]
fn spm_remote_url_points_one_launch_at_a_server_and_is_not_remembered() {
    let world = World::new();
    let env = env_of(&[("SPM_REMOTE_URL", SERVER)]);
    assert!(matches!(
        world.shell.start(&env).unwrap(),
        StartOutcome::Opened
    ));
    assert_eq!(world.shell.mode(), ActiveMode::Remote);
    assert!(!world.state_file().exists());
    assert_eq!(world.prompts.confirm_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn naming_both_a_folder_and_a_server_for_one_launch_is_refused_not_resolved() {
    let world = World::new();
    let env = env_of(&[("SPM_REMOTE_URL", SERVER), ("SPM_LIBRARY_DIR", "somewhere")]);
    let error = world.shell.start(&env).unwrap_err();
    assert_eq!(error.code.as_str(), "Conflict");
    assert!(error.message.contains("SPM_LIBRARY_DIR") && error.message.contains("SPM_REMOTE_URL"));
    assert_eq!(world.shell.mode(), ActiveMode::Unset);
}

#[test]
fn an_spm_remote_url_that_is_not_a_url_fails_the_launch_rather_than_asking_something_else() {
    let world = World::new();
    let error = world
        .shell
        .start(&env_of(&[("SPM_REMOTE_URL", "not a url")]))
        .unwrap_err();
    assert_eq!(error.code.as_str(), "Validation");
    assert_eq!(world.prompts.mode_calls.load(Ordering::SeqCst), 0);
}

// ---- moving between a folder and a server --------------------------------------------------------------

#[test]
fn connecting_to_a_server_lets_go_of_the_local_library_and_of_its_worker() {
    let world = World::new();
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    assert_eq!(world.previews.started.load(Ordering::SeqCst), 1);
    assert_eq!(connect(&world, SERVER).as_deref(), Some(SERVER));
    world.shell.library().settle();
    assert!(world.shell.session().is_none());
    assert_eq!(
        world.previews.stopped.load(Ordering::SeqCst),
        1,
        "the worker was stopped"
    );
    assert_eq!(world.shell.mode(), ActiveMode::Remote);
}

#[tokio::test]
async fn opening_a_folder_lets_go_of_the_server_its_session_and_the_api_route_with_it() {
    let upstream = Upstream::start(|_| answer(200, &[], "{}")).await;
    let world = World::new();
    assert_eq!(
        connect(&world, &upstream.origin).as_deref(),
        Some(upstream.origin.as_str())
    );
    let remote = world.shell.remote().unwrap();

    world.prompts.will_pick(Some(&world.folder("lib")));
    world.shell.pick_local_folder(PromptTrigger::User).unwrap();

    assert!(world.shell.remote().is_none());
    assert!(remote.is_closed() && !remote.has_session());
    let reply = remote
        .proxy(proxy_request("GET", "/api/projects", &[], Body::empty()))
        .await;
    assert_eq!(reply.status(), 503);
    assert!(upstream.requests().is_empty());
}

#[test]
fn the_page_moves_when_the_target_moves_and_not_when_it_does_not() {
    let world = World::new();
    // Nothing to a server: the target moved.
    connect(&world, SERVER);
    assert_eq!(world.events.events(), [Event::Navigate(ShellRoute::Home)]);

    // The same server again: nothing moved, and nobody is asked.
    world.events.clear();
    let asked = world.prompts.confirm_calls.load(Ordering::SeqCst);
    assert_eq!(
        world.shell.connect_remote(SERVER).unwrap().unwrap().origin,
        SERVER
    );
    assert_eq!(world.prompts.confirm_calls.load(Ordering::SeqCst), asked);
    assert!(world.events.events().is_empty());

    // Out of server mode into a folder: moved.
    world.prompts.will_pick(Some(&world.folder("one")));
    world.shell.pick_local_folder(PromptTrigger::User).unwrap();
    assert!(
        world
            .events
            .events()
            .contains(&Event::Navigate(ShellRoute::Home))
    );

    // One folder to another: the page is reloaded, not replaced.
    world.events.clear();
    world.prompts.will_pick(Some(&world.folder("two")));
    world.shell.pick_local_folder(PromptTrigger::User).unwrap();
    assert!(world.events.reloads() >= 1);
    assert!(
        !world
            .events
            .events()
            .iter()
            .any(|e| matches!(e, Event::Navigate(_)))
    );
}

#[test]
fn connecting_to_a_different_server_replaces_the_page_and_lets_go_of_the_first() {
    let world = World::new();
    connect(&world, SERVER);
    let first = world.shell.remote().unwrap();
    world.events.clear();
    assert_eq!(
        connect(&world, "https://other.example.com").as_deref(),
        Some("https://other.example.com")
    );
    assert!(first.is_closed());
    assert_eq!(
        world.shell.remote().unwrap().origin(),
        "https://other.example.com"
    );
    assert_eq!(world.events.events(), [Event::Navigate(ShellRoute::Home)]);
    assert_eq!(
        read_remembered_remote(&world.state_file()).as_deref(),
        Some("https://other.example.com")
    );
}

#[test]
fn the_mode_is_remote_only_while_a_server_is_connected() {
    let world = World::new();
    assert_ne!(world.shell.mode(), ActiveMode::Remote, "unset");
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    assert_eq!(world.shell.mode(), ActiveMode::Local);
    connect(&world, SERVER);
    assert_eq!(world.shell.mode(), ActiveMode::Remote);
}

// ---- connecting: the renderer's request, untrusted -------------------------------------------------------

#[test]
fn a_bad_server_url_from_the_page_is_a_validation_failure_and_changes_nothing() {
    let world = World::new();
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    world.events.clear();
    for url in [
        "file:///etc/passwd",
        "not a url",
        "",
        "https://user:pw@example.com",
        "https://x/api",
    ] {
        let error = world.shell.connect_remote(url).unwrap_err();
        assert_eq!(error.code.as_str(), "Validation", "{url:?}");
    }
    assert_eq!(
        world.shell.mode(),
        ActiveMode::Local,
        "the open library was not lost"
    );
    assert_eq!(
        world.prompts.confirm_calls.load(Ordering::SeqCst),
        0,
        "no confirmation was raised"
    );
    assert!(world.events.events().is_empty());
}

#[test]
fn a_server_the_page_named_is_not_connected_to_until_the_user_says_so() {
    let world = World::new();
    world.prompts.will_confirm(false);
    assert!(world.shell.connect_remote(SERVER).unwrap().is_none());
    assert_eq!(world.shell.mode(), ActiveMode::Unset);
    assert!(!world.state_file().exists(), "declining writes nothing");
    let question = world.prompts.confirm_questions.lock().unwrap()[0].clone();
    assert!(
        question.message.contains(SERVER),
        "the question names the server: {}",
        question.message
    );
}

#[test]
fn a_page_asking_to_connect_in_a_loop_gets_one_dialog_not_one_per_call() {
    let world = World::new();
    world
        .prompts
        .hold_dialogs_open_for(Duration::from_millis(500));
    world.prompts.will_confirm(false);
    let answers = Arc::new(Mutex::new(Vec::new()));
    let threads: Vec<_> = (0..25)
        .map(|_| {
            let (shell, answers) = (Arc::clone(&world.shell), Arc::clone(&answers));
            std::thread::spawn(move || {
                // Computed before the lock is taken: a guard held across the call would serialise
                // the threads and prove nothing.
                let answer = shell.connect_remote(SERVER).unwrap();
                answers.lock().unwrap().push(answer);
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(world.prompts.confirm_calls.load(Ordering::SeqCst), 1);
    let answers = answers.lock().unwrap();
    assert_eq!(answers.len(), 25);
    assert!(answers.iter().all(Option::is_none));
}

#[test]
fn a_second_connect_to_a_different_server_is_refused_not_answered_with_the_first() {
    let world = World::new();
    world
        .prompts
        .hold_dialogs_open_for(Duration::from_millis(500));
    world.prompts.will_confirm(false);
    let shell = Arc::clone(&world.shell);
    let first = std::thread::spawn(move || shell.connect_remote(SERVER));
    while world.prompts.confirm_calls.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(5));
    }
    let error = world
        .shell
        .connect_remote("https://other.example.com")
        .unwrap_err();
    assert_eq!(error.code.as_str(), "Conflict");
    assert!(first.join().unwrap().unwrap().is_none());
    assert_eq!(world.prompts.confirm_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn the_confirmation_defaults_to_refusing_and_is_refused_by_dismissal() {
    for language in [PickerLanguage::En, PickerLanguage::De] {
        let options = confirm_remote_options(SERVER, language);
        assert_eq!(
            options.default_index, options.cancel_index,
            "the default is the refusal"
        );
        assert!(!confirmed_at(options.default_index) && !confirmed_at(options.cancel_index));
        assert!(confirmed_at(1) && !confirmed_at(0) && !confirmed_at(2) && !confirmed_at(99));
        assert!(options.message.contains(SERVER), "{}", options.message);
    }
    assert_eq!(
        confirm_remote_options(SERVER, PickerLanguage::En).buttons,
        ["Cancel", "Connect"]
    );
    assert_eq!(
        confirm_remote_options(SERVER, PickerLanguage::De).buttons,
        ["Abbrechen", "Verbinden"]
    );
}

// ---- leaving a server -------------------------------------------------------------------------------------

#[test]
fn asking_to_connect_while_a_server_is_live_releases_it_and_lands_on_the_connect_page() {
    let world = World::new();
    connect(&world, SERVER);
    let remote = world.shell.remote().unwrap();
    world.events.clear();
    world.prompts.will_choose(ModeChoice::Remote);
    world.shell.ask_for_mode(PromptTrigger::User);
    assert!(remote.is_closed());
    assert_eq!(world.shell.mode(), ActiveMode::Unset);
    assert_eq!(
        world.events.events(),
        [Event::Navigate(ShellRoute::Connect)]
    );
}

#[test]
fn the_same_question_with_nothing_open_only_navigates() {
    let world = World::new();
    world.prompts.will_choose(ModeChoice::Remote);
    world.shell.ask_for_mode(PromptTrigger::User);
    assert_eq!(
        world.events.events(),
        [Event::Navigate(ShellRoute::Connect)]
    );
    assert_eq!(world.shell.mode(), ActiveMode::Unset);
}

#[test]
fn choosing_a_folder_from_the_connect_page_still_gets_there_after_leaving_a_server() {
    let world = World::new();
    connect(&world, SERVER);
    world.prompts.will_choose(ModeChoice::Remote);
    world.shell.ask_for_mode(PromptTrigger::User);
    world.events.clear();

    world.prompts.will_pick(Some(&world.folder("lib")));
    world.shell.pick_local_folder(PromptTrigger::User).unwrap();
    assert_eq!(world.shell.mode(), ActiveMode::Local);
    // One reload (the page, on the connect route, is sent home by whoever handles it) and no
    // second navigation: the server was already let go of.
    assert!(world.events.reloads() >= 1);
    assert!(
        !world
            .events
            .events()
            .iter()
            .any(|e| matches!(e, Event::Navigate(_)))
    );
}

#[test]
fn the_reload_is_declined_while_a_switch_away_from_a_server_is_still_in_flight() {
    let world = World::new();
    connect(&world, SERVER);
    world.events.clear();
    // A folder opens underneath while the server is still connected (the picker's `open` has run,
    // the switch has not finished): no reload, the switch's own navigation follows.
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    assert_eq!(world.events.reloads(), 0);
    // The switch itself finishes with its navigation, not a reload.
    world.prompts.will_pick(Some(&world.folder("other")));
    world.shell.pick_local_folder(PromptTrigger::User).unwrap();
    assert_eq!(world.shell.mode(), ActiveMode::Local);
    assert_eq!(world.events.reloads(), 0);
    assert_eq!(world.events.events(), [Event::Navigate(ShellRoute::Home)]);
    // Once the server has been let go of, an ordinary library change reloads.
    world.prompts.will_pick(Some(&world.folder("third")));
    world.shell.pick_local_folder(PromptTrigger::User).unwrap();
    assert!(world.events.reloads() >= 1);
}
