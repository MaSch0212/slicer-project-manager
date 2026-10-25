//! Ported from `browse-policy.test.ts` and from the policy and arithmetic cases of
//! `browse-host.test.ts`: the navigation table, the new-window decision, the refusal sentences and
//! the rectangle the shell computes for the view.

use spm_core::dto::BrowseBounds;
use spm_shell::browse::bounds::{Inset, MIN_AREA, Rect, view_bounds};
use spm_shell::browse::policy::{
    BrowsePolicy::{self, Allow, Block},
    MAX_REFUSAL_SCHEME, OpenDecision, browse_navigation_policy, browse_open_decision,
    describe_refusal,
};
use spm_shell::nav::{NavigationPolicy, navigation_policy};

const POLICY_TABLE: &[(&str, BrowsePolicy)] = &[
    ("https://www.thingiverse.com/thing:1", Allow),
    ("http://example.com/", Allow),
    (
        "https://makerworld.com/en/models/2093108-dji-neo-2-the-box?from=recommend",
        Allow,
    ),
    ("HTTPS://EXAMPLE.COM/", Allow),
    // A download depends on these: Thingiverse's download URL is a `blob:`.
    (
        "blob:https://www.thingiverse.com/ae5e9664-0d63-4a6f-9c0a-2b0b4b8b0e21",
        Allow,
    ),
    ("blob:https://www.printables.com/1234", Allow),
    ("data:text/html,x", Allow),
    ("data:application/octet-stream;base64,AAAA", Allow),
    ("about:blank", Allow),
    ("about:srcdoc", Block),
    ("about:config", Block),
    ("spm://app/", Block),
    ("spm://app/_spm/files/1/raw", Block),
    ("spm://evil/", Block),
    ("file:///C:/Users/x/secret.stl", Block),
    ("file:///etc/passwd", Block),
    ("javascript:alert(1)", Block),
    ("bambustudio://open?model=1", Block),
    ("chrome://settings", Block),
    ("devtools://devtools/bundled/inspector.html", Block),
    ("ws://example.com/", Block),
    ("mailto:someone@example.com", Block),
    ("not a url", Block),
    ("", Block),
    ("//example.com/", Block),
];

#[test]
fn browse_navigation_policy_answers_the_measured_table_allows_and_blocks_alike() {
    for (url, expected) in POLICY_TABLE {
        assert_eq!(browse_navigation_policy(url), *expected, "{url}");
    }
}

#[test]
fn the_browse_policy_and_the_renderer_policy_are_different_functions_and_invert_on_http() {
    let app = "http://127.0.0.1:4000";
    assert_eq!(
        navigation_policy("https://example.com/", app),
        NavigationPolicy::External
    );
    assert_eq!(browse_navigation_policy("https://example.com/"), Allow);
    assert_eq!(
        navigation_policy("about:blank", app),
        NavigationPolicy::Block
    );
    assert_eq!(
        navigation_policy("blob:http://127.0.0.1:4000/1", app),
        NavigationPolicy::Block
    );
    assert_eq!(browse_navigation_policy("about:blank"), Allow);
    // The app's own origin is just another web page to the browse view, and it holds no bridge.
    assert_eq!(
        navigation_policy("http://127.0.0.1:4000/projects", app),
        NavigationPolicy::Allow
    );
}

#[test]
fn the_window_open_decision_navigates_a_link_never_makes_a_window_and_denies_the_rest() {
    for (url, expected, why) in [
        (
            "https://example.com/next",
            OpenDecision::Navigate,
            "a link goes where it was going",
        ),
        (
            "http://example.com/next",
            OpenDecision::Navigate,
            "plain http as well",
        ),
        (
            "blob:https://www.thingiverse.com/ae5e",
            OpenDecision::Navigate,
            "window.open(blobUrl) is the third download idiom",
        ),
        (
            "data:text/html,x",
            OpenDecision::Navigate,
            "data: is allowed by the policy",
        ),
        (
            "about:blank",
            OpenDecision::Popup,
            "the deferred popup has nothing to load",
        ),
        ("file:///C:/x", OpenDecision::Deny, "never a file"),
        ("javascript:alert(1)", OpenDecision::Deny, "never a script"),
        (
            "bambustudio://open?model=1",
            OpenDecision::Deny,
            "a custom scheme",
        ),
        ("about:srcdoc", OpenDecision::Deny, "srcdoc"),
        ("not a url", OpenDecision::Deny, "unparseable"),
        ("", OpenDecision::Deny, "empty"),
    ] {
        assert_eq!(browse_open_decision(url), expected, "{why}: {url}");
    }
}

#[test]
fn a_refusal_names_the_scheme_and_never_the_url_and_a_stranger_cannot_make_it_long() {
    assert_eq!(
        describe_refusal("bambustudio://open?model=1"),
        "the model browser does not open bambustudio: URLs"
    );
    assert_eq!(
        describe_refusal("not a url"),
        "the model browser refused a navigation to a URL it could not parse"
    );
    let long = format!("{}://x/", "a".repeat(200));
    let sentence = describe_refusal(&long);
    assert!(sentence.contains(&"a".repeat(MAX_REFUSAL_SCHEME - 1)));
    assert!(!sentence.contains(&"a".repeat(MAX_REFUSAL_SCHEME + 1)));
    assert!(!describe_refusal("javascript:alert(document.cookie)").contains("cookie"));
}

// ---- the rectangle -----------------------------------------------------------------------------

const LEGACY_INSET: Inset = Inset {
    top: 120.0,
    right: 0.0,
    bottom: 0.0,
    left: 0.0,
};

fn ask(x: f64, y: f64, width: f64, height: f64) -> BrowseBounds {
    BrowseBounds {
        x,
        y,
        width,
        height,
    }
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Option<Rect> {
    Some(Rect {
        x,
        y,
        width,
        height,
    })
}

#[test]
fn a_request_taller_than_the_content_area_is_intersected_down_never_over_the_chrome_inset() {
    // A request for the whole window is not given the whole window: the chrome band is kept.
    assert_eq!(
        view_bounds(
            &ask(0.0, 0.0, 1280.0, 860.0),
            (1280.0, 860.0),
            1.0,
            LEGACY_INSET,
            MIN_AREA
        ),
        rect(0.0, 120.0, 1280.0, 740.0)
    );
    // And the shell's own inset keeps the sidebar's column too.
    let own = view_bounds(
        &ask(0.0, 0.0, 1280.0, 860.0),
        (1280.0, 860.0),
        1.0,
        spm_shell::browse::bounds::CHROME_INSET,
        MIN_AREA,
    )
    .unwrap();
    assert!(own.x >= 64.0 && own.y >= 100.0, "{own:?}");
}

#[test]
fn a_request_already_inside_the_allowed_rectangle_is_honoured_as_it_stands() {
    assert_eq!(
        view_bounds(
            &ask(40.0, 200.0, 600.0, 400.0),
            (1280.0, 860.0),
            1.0,
            LEGACY_INSET,
            MIN_AREA
        ),
        rect(40.0, 200.0, 600.0, 400.0)
    );
}

#[test]
fn a_request_that_intersects_to_less_than_the_minimum_is_no_rectangle_at_all() {
    let at = |request| view_bounds(&request, (1280.0, 860.0), 1.0, LEGACY_INSET, MIN_AREA);
    // Entirely over the chrome: nothing is left.
    assert_eq!(at(ask(0.0, 0.0, 800.0, 100.0)), None);
    // Off the right and bottom edges.
    assert_eq!(at(ask(2000.0, 300.0, 400.0, 400.0)), None);
    assert_eq!(at(ask(0.0, 2000.0, 400.0, 400.0)), None);
    // 1x1 is the reverse attack.
    assert_eq!(at(ask(300.0, 300.0, 1.0, 1.0)), None);
    // The boundary, both sides: exactly the minimum is a rectangle, one pixel short is not.
    assert!(at(ask(0.0, 200.0, MIN_AREA.0, MIN_AREA.1)).is_some());
    assert_eq!(at(ask(0.0, 200.0, MIN_AREA.0 - 1.0, MIN_AREA.1)), None);
    assert_eq!(at(ask(0.0, 200.0, MIN_AREA.0, MIN_AREA.1 - 1.0)), None);
    // A request that starts over the chrome loses only the part over it.
    assert_eq!(at(ask(0.0, 100.0, 400.0, 219.0)), None);
    assert!(at(ask(0.0, 100.0, 400.0, 320.0)).is_some());
}

#[test]
fn the_zoom_factor_converts_the_request_the_inset_and_the_minimum_together() {
    // At 2x the content is 2560x1720 device pixels; the request and the inset are CSS pixels.
    assert_eq!(
        view_bounds(
            &ask(0.0, 0.0, 1280.0, 860.0),
            (2560.0, 1720.0),
            2.0,
            LEGACY_INSET,
            MIN_AREA
        ),
        rect(0.0, 240.0, 2560.0, 1480.0)
    );
    // The minimum is CSS pixels as well: 150 CSS px is under it at any zoom.
    assert_eq!(
        view_bounds(
            &ask(0.0, 200.0, 150.0, 400.0),
            (2560.0, 1720.0),
            2.0,
            LEGACY_INSET,
            MIN_AREA
        ),
        None
    );
}

#[test]
fn a_rectangle_that_is_not_a_rectangle_is_no_rectangle_rather_than_an_exception() {
    let content = (1280.0, 860.0);
    for request in [
        ask(f64::NAN, 200.0, 400.0, 400.0),
        ask(0.0, f64::INFINITY, 400.0, 400.0),
        ask(0.0, 200.0, f64::NEG_INFINITY, 400.0),
        ask(0.0, 200.0, 0.0, 400.0),
        ask(0.0, 200.0, 400.0, -5.0),
    ] {
        assert_eq!(
            view_bounds(&request, content, 1.0, LEGACY_INSET, MIN_AREA),
            None
        );
    }
    for zoom in [0.0, -1.0, f64::NAN] {
        assert_eq!(
            view_bounds(
                &ask(0.0, 200.0, 400.0, 400.0),
                content,
                zoom,
                LEGACY_INSET,
                MIN_AREA
            ),
            None
        );
    }
}
