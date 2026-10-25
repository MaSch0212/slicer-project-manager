//! Ported from the former TypeScript server test `rate-limit.test.ts`. The unit-level flood test lives beside the
//! limiter itself (`src/rate_limit.rs`); the peer-address tests over a real socket are in
//! `wire.rs`.

use serde_json::json;

use crate::support::{PASSWORD, Reply, Req, TestServer};

async fn bad_login(server: &TestServer, ip: &str) -> Reply {
    server
        .fetch(
            "/api/auth/login",
            Req::post()
                .ip(ip)
                .json(&json!({ "username": "admin", "password": "the wrong password entirely" })),
        )
        .await
}

async fn bogus_activation(server: &TestServer, ip: &str) -> Reply {
    server
        .fetch(
            "/api/auth/activation/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Req::post()
                .ip(ip)
                .json(&json!({ "password": PASSWORD, "confirm": PASSWORD })),
        )
        .await
}

#[tokio::test]
async fn login_is_rate_limited_per_ip_and_reports_when_to_retry() {
    let server = TestServer::new();
    // The rule is 10 per 60s, so the first ten are refused on the merits (401).
    for _ in 0..10 {
        assert_eq!(bad_login(&server, "10.0.0.1").await.status, 401);
    }
    let limited = bad_login(&server, "10.0.0.1").await;
    assert_eq!(limited.status, 429);
    assert_eq!(limited.error_code(), "TooManyRequests");
    // A client needs to know how long to wait, not just that it was refused.
    let retry = limited.header("retry-after").unwrap();
    assert!(retry.bytes().all(|byte| byte.is_ascii_digit()), "{retry}");
}

#[tokio::test]
async fn one_ip_hitting_the_limit_does_not_lock_out_another() {
    let server = TestServer::new();
    for _ in 0..11 {
        bad_login(&server, "10.0.0.1").await;
    }
    assert_eq!(bad_login(&server, "10.0.0.1").await.status, 429);
    // A shared-limiter bug would show up here and nowhere else.
    assert_eq!(bad_login(&server, "10.0.0.2").await.status, 401);
}

#[tokio::test]
async fn the_limiter_counts_attempts_not_successes_and_a_good_password_still_gets_in() {
    let server = TestServer::new();
    // The bootstrap admin starts pending with no password at all, so a good-password login can
    // only succeed once the account is activated.
    server.login_as_admin().await;
    for _ in 0..9 {
        bad_login(&server, "10.0.0.3").await;
    }
    let ok = server
        .fetch(
            "/api/auth/login",
            Req::post()
                .ip("10.0.0.3")
                .json(&json!({ "username": "admin", "password": PASSWORD })),
        )
        .await;
    assert_eq!(ok.status, 200);
}

#[tokio::test]
async fn an_unlimited_route_is_not_affected_by_an_exhausted_auth_budget() {
    let server = TestServer::new();
    for _ in 0..11 {
        bad_login(&server, "10.0.0.4").await;
    }
    // capabilities carries no rate-limit rule, so it must stay reachable.
    let reply = server
        .fetch("/api/capabilities", Req::get().ip("10.0.0.4"))
        .await;
    assert_eq!(reply.status, 200);
}

#[tokio::test]
async fn the_window_expires_so_a_locked_out_client_recovers() {
    let server = TestServer::new();
    for _ in 0..11 {
        bad_login(&server, "10.0.0.5").await;
    }
    assert_eq!(bad_login(&server, "10.0.0.5").await.status, 429);
    // Advance past the window without sleeping for a real minute.
    server.advance(61_000);
    assert_eq!(bad_login(&server, "10.0.0.5").await.status, 401);
}

#[tokio::test]
async fn activation_is_rate_limited_too_since_it_also_takes_a_token_guess() {
    let server = TestServer::new();
    for _ in 0..10 {
        bogus_activation(&server, "10.0.0.6").await;
    }
    assert_eq!(bogus_activation(&server, "10.0.0.6").await.status, 429);
}

#[tokio::test]
async fn exhausting_the_login_budget_for_an_ip_leaves_the_activation_route_reachable_for_it() {
    let server = TestServer::new();
    for _ in 0..11 {
        bad_login(&server, "10.0.0.7").await;
    }
    assert_eq!(bad_login(&server, "10.0.0.7").await.status, 429);
    // Same IP, but a different route pattern, so it must be a different budget.
    assert_ne!(bogus_activation(&server, "10.0.0.7").await.status, 429);
}

#[tokio::test]
async fn the_activation_budget_is_one_per_route_pattern_not_one_per_token() {
    // Every distinct token must not get a fresh budget, or the limit would do nothing.
    let server = TestServer::new();
    for attempt in 0..10 {
        let reply = server
            .fetch(
                &format!("/api/auth/activation/guess-{attempt}"),
                Req::post()
                    .ip("10.0.0.8")
                    .json(&json!({ "password": PASSWORD, "confirm": PASSWORD })),
            )
            .await;
        assert_ne!(reply.status, 429);
    }
    let eleventh = server
        .fetch(
            "/api/auth/activation/guess-11",
            Req::post()
                .ip("10.0.0.8")
                .json(&json!({ "password": PASSWORD, "confirm": PASSWORD })),
        )
        .await;
    assert_eq!(eleventh.status, 429);
}

#[tokio::test]
async fn reading_an_activation_token_is_not_limited() {
    // Only the POST takes a password guess.
    let server = TestServer::new();
    for _ in 0..15 {
        let reply = server
            .fetch(
                "/api/auth/activation/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                Req::get().ip("10.0.0.9"),
            )
            .await;
        assert_eq!(reply.status, 200);
    }
}

#[tokio::test]
async fn x_forwarded_for_buys_no_fresh_budget() {
    // The key is the peer address; a header the client controls must not move it.
    let server = TestServer::new();
    for attempt in 0..10 {
        let reply = server
            .fetch(
                "/api/auth/login",
                Req::post()
                    .ip("10.0.0.10")
                    .header("x-forwarded-for", &format!("203.0.113.{attempt}"))
                    .header("x-real-ip", &format!("203.0.113.{attempt}"))
                    .json(&json!({ "username": "admin", "password": "wrong password entirely" })),
            )
            .await;
        assert_eq!(reply.status, 401);
    }
    let limited = server
        .fetch(
            "/api/auth/login",
            Req::post()
                .ip("10.0.0.10")
                .header("x-forwarded-for", "203.0.113.200")
                .json(&json!({ "username": "admin", "password": "wrong password entirely" })),
        )
        .await;
    assert_eq!(limited.status, 429);
}
