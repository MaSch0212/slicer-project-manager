use std::sync::{Arc, Barrier};
use std::thread;

use rusqlite::params;
use spm_core::AppErrorCode;
use spm_core::auth::activation::{
    check_activation_token, consume_activation_token, issue_activation_token,
};
use spm_core::auth::password::{
    PW_ALGO, PW_ITERATIONS, hash_password_with, needs_rehash, verify_password,
};
use spm_core::auth::sessions::{
    create_session, delete_session, prune_expired_sessions, resolve_session,
};
use spm_core::auth::tokens::{random_token, sha256_bytes, timing_safe_equal};
use spm_core::testing::{SeedUser, TempLibrary, seed_user_row};
use spm_core::{Ctx, Library};

use crate::common::{code_of, is_url_safe_token};

const FAST: u32 = 1000;
const EIGHT_DAYS: i64 = 8 * 24 * 60 * 60 * 1000;

fn seed(lib: &Library, admin: bool, status: &str) -> String {
    let id = spm_core::new_id();
    // Distinct username and folder per call, as the legacy helper made them.
    let username = format!("u-{}", &id[..8]);
    seed_user_row(
        lib,
        &SeedUser {
            username: &username,
            is_admin: admin,
            status,
        },
    )
}

fn consumed_at_rows(lib: &Library, user_id: &str) -> Vec<Option<i64>> {
    lib.db()
        .prepare("SELECT consumed_at FROM activation_tokens WHERE user_id = ?")
        .unwrap()
        .query_map(params![user_id], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn the_production_pbkdf2_parameters_are_the_ones_the_spec_fixes() {
    assert_eq!(PW_ITERATIONS, 600_000);
    assert_eq!(PW_ALGO, "pbkdf2-sha256");
}

#[test]
fn hash_password_verifies_the_right_password_and_rejects_the_wrong_one() {
    let stored = hash_password_with("correct horse battery", FAST);
    assert_eq!(stored.hash.len(), 32);
    assert_eq!(stored.salt.len(), 16);
    assert!(verify_password("correct horse battery", &stored));
    assert!(!verify_password("correct horse batterz", &stored));
}

#[test]
fn two_hashes_of_the_same_password_differ_by_salt() {
    let a = hash_password_with("same password", FAST);
    let b = hash_password_with("same password", FAST);
    assert!(!timing_safe_equal(&a.hash, &b.hash));
}

#[test]
fn needs_rehash_flags_weaker_stored_parameters_only() {
    let weak = hash_password_with("pw", FAST);
    assert!(needs_rehash(weak.iterations, &weak.algo));
    assert!(!needs_rehash(i64::from(PW_ITERATIONS), PW_ALGO));
    assert!(needs_rehash(i64::from(PW_ITERATIONS), "pbkdf2-sha1"));
}

#[test]
fn random_token_is_url_safe_and_256_bits_wide() {
    let token = random_token();
    assert!(is_url_safe_token(&token), "{token}");
    assert_ne!(token, random_token());
}

#[test]
fn sha256_bytes_is_stable_and_32_bytes() {
    let a = sha256_bytes("abc");
    assert_eq!(a.len(), 32);
    assert!(timing_safe_equal(&a, &sha256_bytes("abc")));
    // An independent implementation's answer for "abc" (the FIPS 180 test vector).
    let hex: String = a.iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(
        hex,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn a_session_resolves_to_its_user_and_stores_only_the_hash() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, true, "active");
    let session = create_session(&lib, &user_id, Some("test-agent"), 0).unwrap();
    let ctx = resolve_session(&lib, &session.token, 1).unwrap();
    assert_eq!(
        ctx,
        Some(Ctx {
            user_id,
            is_admin: true
        })
    );

    let hashes: Vec<Vec<u8>> = lib
        .db()
        .prepare("SELECT token_hash FROM sessions")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(hashes.len(), 1);
    assert!(timing_safe_equal(&hashes[0], &sha256_bytes(&session.token)));
    assert_ne!(hashes[0], session.token.as_bytes());
}

#[test]
fn an_expired_session_does_not_resolve_and_is_pruned() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, false, "active");
    let session = create_session(&lib, &user_id, None, 0).unwrap();
    assert_eq!(
        resolve_session(&lib, &session.token, session.expires_at + 1).unwrap(),
        None
    );
    assert_eq!(
        prune_expired_sessions(&lib, session.expires_at + 1).unwrap(),
        1
    );
}

#[test]
fn a_disabled_user_cannot_resolve_a_live_session() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, false, "active");
    let session = create_session(&lib, &user_id, None, 0).unwrap();
    lib.db()
        .execute(
            "UPDATE users SET status = 'disabled' WHERE id = ?",
            params![user_id],
        )
        .unwrap();
    assert_eq!(resolve_session(&lib, &session.token, 1).unwrap(), None);
}

#[test]
fn delete_session_revokes_immediately() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, false, "active");
    let session = create_session(&lib, &user_id, None, 0).unwrap();
    delete_session(&lib, &session.token).unwrap();
    assert_eq!(resolve_session(&lib, &session.token, 1).unwrap(), None);
}

#[test]
fn an_activation_token_checks_out_once_then_is_consumed() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, false, "pending");
    let token = issue_activation_token(&lib, &user_id, 0).unwrap();
    let check = check_activation_token(&lib, &token, 1).unwrap();
    assert!(check.valid);
    assert_eq!(check.user_id.as_deref(), Some(user_id.as_str()));

    assert_eq!(consume_activation_token(&lib, &token, 1).unwrap(), user_id);
    assert!(!check_activation_token(&lib, &token, 1).unwrap().valid);
    assert!(consume_activation_token(&lib, &token, 1).is_err());
}

#[test]
fn consuming_an_activation_token_twice_never_yields_two_consumptions() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, false, "pending");
    let token = issue_activation_token(&lib, &user_id, 0).unwrap();

    assert_eq!(consume_activation_token(&lib, &token, 1).unwrap(), user_id);
    assert!(consume_activation_token(&lib, &token, 1).is_err());
    assert!(consume_activation_token(&lib, &token, 1).is_err());

    let rows = consumed_at_rows(&lib, &user_id);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].is_some());
}

// The legacy version of this test interleaved two promises on one thread. Here the two consumers
// are real threads released together, which is a stronger test of the same promise: the atomic
// UPDATE (and the lock around it) lets exactly one of them win.
#[test]
fn two_concurrent_consumptions_of_the_same_token_exactly_one_wins() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, false, "pending");
    let token = issue_activation_token(&lib, &user_id, 0).unwrap();

    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let (lib, token, barrier) = ((*lib).clone(), token.clone(), Arc::clone(&barrier));
            thread::spawn(move || {
                barrier.wait();
                consume_activation_token(&lib, &token, 1)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();

    let won: Vec<_> = results.iter().filter(|result| result.is_ok()).collect();
    let lost: Vec<_> = results
        .iter()
        .filter_map(|result| result.as_ref().err())
        .collect();
    assert_eq!(won.len(), 1);
    assert_eq!(lost.len(), 1);
    assert_eq!(*won[0].as_ref().unwrap(), user_id);
    assert_eq!(lost[0].code, AppErrorCode::InvalidToken);

    let rows = consumed_at_rows(&lib, &user_id);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].is_some());
}

#[test]
fn an_expired_activation_token_is_invalid() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, false, "pending");
    let token = issue_activation_token(&lib, &user_id, 0).unwrap();
    assert!(
        !check_activation_token(&lib, &token, EIGHT_DAYS)
            .unwrap()
            .valid
    );
    // And consuming it says it expired, which is what lets the UI offer a re-invite.
    assert_eq!(
        code_of(consume_activation_token(&lib, &token, EIGHT_DAYS)),
        AppErrorCode::TokenExpired
    );
}

#[test]
fn an_already_consumed_token_reports_invalid_token_even_after_it_also_expires() {
    let lib = TempLibrary::new();
    let user_id = seed(&lib, false, "pending");
    let token = issue_activation_token(&lib, &user_id, 0).unwrap();
    consume_activation_token(&lib, &token, 0).unwrap();

    assert_eq!(
        code_of(consume_activation_token(&lib, &token, EIGHT_DAYS)),
        AppErrorCode::InvalidToken
    );
}

#[test]
fn an_unknown_token_is_invalid_rather_than_an_error() {
    let lib = TempLibrary::new();
    assert!(
        !check_activation_token(&lib, &random_token(), 0)
            .unwrap()
            .valid
    );
}
