//! Ported from the Electron shell's `capabilities.test.ts`: spec 2.4's two columns and a union.

mod support;

use serde_json::{Value, json};
use spm_core::dto::Capabilities;
use spm_http::{AuthMode, capabilities_for};
use spm_shell::capabilities::{
    LOCAL_SHELL_CAPABILITIES, REMOTE_SHELL_CAPABILITIES, parse_capabilities, union_capabilities,
};
use support::{Client, World, serve};

fn caps(
    requires_auth: bool,
    can_manage_users: bool,
    can_pick_local_folder: bool,
    can_launch_slicer: bool,
    can_configure_slicers: bool,
    can_browse_model_sites: bool,
) -> Capabilities {
    Capabilities {
        requires_auth,
        can_manage_users,
        can_pick_local_folder,
        can_launch_slicer,
        can_configure_slicers,
        can_browse_model_sites,
    }
}

#[test]
fn the_shell_columns_are_exactly_what_spec_2_4_says_the_shell_contributes() {
    // Whole, flag by flag. The two slicer flags are true in *both* columns (desktop part 2: the
    // machine has the slicers whichever library is open); the browser flag stays false until
    // desktop part 3 flips it in both; `canPickLocalFolder` is the one flag that differs, because
    // it is a property of the mode and not of the shell.
    assert_eq!(
        LOCAL_SHELL_CAPABILITIES,
        caps(false, false, true, true, true, false)
    );
    assert_eq!(
        REMOTE_SHELL_CAPABILITIES,
        caps(false, false, false, true, true, false)
    );
    let mut local = LOCAL_SHELL_CAPABILITIES;
    local.can_pick_local_folder = false;
    assert_eq!(
        local, REMOTE_SHELL_CAPABILITIES,
        "the columns differ by canPickLocalFolder and by nothing else"
    );
}

#[tokio::test]
async fn local_mode_answers_the_shell_column_alone_with_no_backend_to_union_with() {
    let world = World::new();
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    let server = serve(&world.shell).await;
    let client = Client::handshake(&server).await;
    let reply = client.get("/api/capabilities").await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.json(),
        serde_json::to_value(LOCAL_SHELL_CAPABILITIES).unwrap()
    );
    assert_eq!(
        reply.json(),
        json!({
            "requiresAuth": false,
            "canManageUsers": false,
            "canPickLocalFolder": true,
            "canLaunchSlicer": true,
            "canConfigureSlicers": true,
            "canBrowseModelSites": false,
        })
    );
}

#[test]
fn remote_mode_is_the_union_and_it_is_spec_2_4_third_column() {
    // A server that requires a login and hosts users.
    let server = caps(true, true, false, false, false, false);
    let merged = union_capabilities(&REMOTE_SHELL_CAPABILITIES, &server);
    assert!(merged.requires_auth && merged.can_manage_users);
    assert!(
        !merged.can_pick_local_folder,
        "the library on screen is the server's: no folder control beside it"
    );
}

#[test]
fn unioning_the_local_column_with_a_backend_would_light_a_folder_control_that_must_not_be() {
    let server = caps(true, true, false, false, false, false);
    assert!(union_capabilities(&LOCAL_SHELL_CAPABILITIES, &server).can_pick_local_folder);
    assert!(!union_capabilities(&REMOTE_SHELL_CAPABILITIES, &server).can_pick_local_folder);
}

#[test]
fn a_backend_cannot_veto_a_capability_the_shell_has() {
    // Literal fixtures, so this holds for the flags parts 2 and 3 will light.
    let shell = caps(false, false, true, true, true, true);
    let backend = caps(true, false, false, false, false, false);
    let merged = union_capabilities(&shell, &backend);
    assert!(merged.can_pick_local_folder);
    assert!(merged.can_launch_slicer);
    assert!(merged.can_configure_slicers);
    assert!(merged.can_browse_model_sites);
    // ...while a backend restriction still wins on `requiresAuth`.
    assert!(merged.requires_auth);
    assert!(
        !union_capabilities(&shell, &caps(false, false, false, false, false, false)).requires_auth
    );
}

#[test]
fn a_shell_cannot_veto_a_capability_the_backend_has() {
    let shell = caps(false, false, false, true, true, true);
    let backend = caps(true, true, false, false, false, false);
    let merged = union_capabilities(&shell, &backend);
    assert!(
        merged.can_manage_users,
        "the shell column says false for it"
    );
    assert!(merged.requires_auth);
}

#[test]
fn a_backend_answer_that_is_not_a_capability_set_is_refused_rather_than_unioned() {
    let full = |extra: Value| {
        let mut value = json!({
            "requiresAuth": true,
            "canManageUsers": true,
            "canPickLocalFolder": false,
            "canLaunchSlicer": false,
            "canConfigureSlicers": false,
            "canBrowseModelSites": false,
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().cloned().unwrap_or_default());
        value
    };
    assert!(parse_capabilities(&full(json!({}))).is_some());
    // Extra keys are tolerated: a newer server may know more than this shell does.
    assert!(parse_capabilities(&full(json!({ "canDoMore": true }))).is_some());
    for rejected in [
        Value::Null,
        json!("capabilities"),
        json!([]),
        json!({}),
        json!({ "requiresAuth": true }),
        {
            let mut wrong = full(json!({}));
            wrong["canManageUsers"] = json!("yes");
            wrong
        },
        {
            let mut missing = full(json!({}));
            missing
                .as_object_mut()
                .unwrap()
                .remove("canBrowseModelSites");
            missing
        },
    ] {
        assert!(parse_capabilities(&rejected).is_none(), "{rejected}");
    }
}

#[test]
fn the_local_backend_contributes_no_flag_the_shell_column_does_not_have() {
    // `spm-http` in local mode says no login and no user management, and nothing else: the union
    // with the local shell column is therefore the shell column.
    let backend = capabilities_for(&AuthMode::Local(spm_core::Ctx {
        user_id: "u".to_owned(),
        is_admin: false,
    }));
    assert_eq!(
        union_capabilities(&LOCAL_SHELL_CAPABILITIES, &backend),
        LOCAL_SHELL_CAPABILITIES
    );
}
