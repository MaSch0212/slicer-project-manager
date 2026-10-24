//! `match_key`'s own clauses (normalisation, the identity hand-off, the fallback) against a *probe*
//! site rather than a copy of the real registry. The probe is not a re-implementation of anything:
//! it recognises exactly one pathname and records the URL it was handed, so the tests assert what
//! `match_key` promises implementations rather than what any real site's URLs look like. The
//! exhaustive fixtures over the real registry belong to the desktop part, where the registry lives.

use std::cell::RefCell;

use spm_core::match_key::{ModelSiteIdentity, match_key};
use url::Url;

struct Probe {
    hosts: Vec<String>,
    /// Every URL `identity` was handed, in order, so the hand-off itself is observable.
    seen: RefCell<Vec<Url>>,
}

impl Probe {
    fn new() -> Probe {
        Probe {
            hosts: vec!["probe.example".to_owned()],
            seen: RefCell::default(),
        }
    }
}

impl ModelSiteIdentity for Probe {
    fn id(&self) -> &str {
        "probe"
    }

    fn hosts(&self) -> &[String] {
        &self.hosts
    }

    fn identity(&self, url: &Url) -> Option<String> {
        self.seen.borrow_mut().push(url.clone());
        (url.path() == "/model").then(|| "the-one".to_owned())
    }
}

fn key(url: &str, probe: &Probe) -> String {
    match_key(url, &[probe])
}

fn bare(url: &str) -> String {
    match_key::<&Probe>(url, &[])
}

/// `&Probe` is a site too, so tests can keep the probe to inspect it afterwards.
impl ModelSiteIdentity for &Probe {
    fn id(&self) -> &str {
        (**self).id()
    }
    fn hosts(&self) -> &[String] {
        (**self).hosts()
    }
    fn identity(&self, url: &Url) -> Option<String> {
        (**self).identity(url)
    }
}

#[test]
fn match_key_strips_a_leading_www_before_matching_a_row() {
    let probe = Probe::new();
    assert_eq!(
        key("https://WWW.Probe.Example/model", &probe),
        "probe:the-one"
    );
    assert_eq!(key("https://probe.example/model", &probe), "probe:the-one");
}

#[test]
fn the_host_is_lowercased_even_where_the_url_parser_has_not_already_done_it() {
    // A *non-special* scheme is the only shape that reaches the clause: the parser lowercases the
    // host of http(s) itself but leaves `custom://MiXeD/` alone. Written this way because the
    // obvious version of the test (a mixed-case https URL) cannot fail.
    assert_eq!(
        Url::parse("custom://MiXeD/Path").unwrap().host_str(),
        Some("MiXeD")
    );
    assert_eq!(bare("custom://MiXeD/Path"), "mixed/path");
}

#[test]
fn identity_never_sees_a_query_or_a_fragment_and_sees_the_normalised_host() {
    let probe = Probe::new();
    assert_eq!(
        key(
            "https://WWW.Probe.Example/model?lang=de&from=recommend#profileId-9",
            &probe
        ),
        "probe:the-one"
    );
    // The clause is enforced at the hand-off rather than left to each site to remember: Printables
    // puts the locale in `?lang=de` and MakerWorld appends `?from=recommend` and a fragment.
    let seen = probe.seen.borrow();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].query(), None);
    assert_eq!(seen[0].fragment(), None);
    assert_eq!(seen[0].host_str(), Some("probe.example"));
    assert_eq!(seen[0].path(), "/model");
}

#[test]
fn a_row_is_only_offered_urls_on_one_of_its_own_hosts_exactly() {
    let probe = Probe::new();
    // A subdomain is not the site: `cdn.thingiverse.com` must not key as Thingiverse.
    assert_eq!(
        key("https://cdn.probe.example/model", &probe),
        "cdn.probe.example/model"
    );
    assert_eq!(
        key("https://other.example/model", &probe),
        "other.example/model"
    );
    assert!(probe.seen.borrow().is_empty());
}

#[test]
fn a_matched_host_whose_identity_is_none_falls_back_rather_than_keying_to_the_site() {
    let probe = Probe::new();
    // A home page or a listing is not a model, and must not collapse to `probe:` or to the id.
    assert_eq!(key("https://probe.example/", &probe), "probe.example");
    assert_eq!(
        key("https://probe.example/not-a-model", &probe),
        "probe.example/not-a-model"
    );
}

#[test]
fn the_fallback_is_lowercased_hostname_plus_pathname_with_the_trailing_slash_removed() {
    assert_eq!(
        bare("https://example.com/some/path/"),
        "example.com/some/path"
    );
    assert_eq!(
        bare("https://example.com/some/path"),
        "example.com/some/path"
    );
    assert_eq!(
        bare("https://EXAMPLE.com/Some/Path/"),
        "example.com/some/path"
    );
    assert_eq!(
        bare("https://www.example.com/some/path"),
        "example.com/some/path"
    );
    assert_eq!(bare("https://example.com/"), "example.com");
    assert_eq!(bare("https://example.com"), "example.com");
    // A query and a fragment do not survive into the fallback either. (As the legacy test says,
    // the fallback is built from the pathname, which never carries either; this pins the value.
    // The clause itself is pinned by the hand-off test above.)
    assert_eq!(
        bare("https://example.com/some/path/?lang=de#frag"),
        "example.com/some/path"
    );
}

#[test]
fn the_fallback_keeps_the_port_so_two_servers_on_one_hostname_stay_two_keys() {
    assert_eq!(bare("http://localhost:8080/x"), "localhost_8080/x");
    assert_ne!(
        bare("http://localhost:8080/x"),
        bare("http://localhost:9000/x")
    );
}

#[test]
fn a_fallback_key_can_never_spell_a_prefixed_one() {
    // `https://thingiverse:1234/` is a single-label host spelled exactly as a registry id, with a
    // port, and it used to fall back to `thingiverse:1234`, the key a real Thingiverse model
    // produces. The port is rendered `_` so the two namespaces are structurally disjoint.
    assert_eq!(bare("https://thingiverse:1234/"), "thingiverse_1234");

    // A `:` in the *path* is fine and is kept: it always has a `/` in front of it. An IPv6
    // literal keeps its colons too, behind a `[`.
    assert_eq!(
        bare("https://thingiverse/thing:1234"),
        "thingiverse/thing:1234"
    );
    assert_eq!(bare("https://[::1]:8080/x"), "[::1]_8080/x");

    // The property stated as the thing that actually matters, not as "no colons": no fallback key
    // begins with a site id and a colon.
    let probe = Probe::new();
    let ids = [
        "thingiverse",
        "printables",
        "makerworld",
        "cults3d",
        "probe",
    ];
    for url in [
        "https://thingiverse:1234/",
        "https://printables:1807378/",
        "https://probe:1/",
        "https://example.com/some/path/",
        "https://example.com/",
        "http://localhost:8080/x",
        "https://probe.example/not-a-model",
        "https://[::1]:8080/x",
    ] {
        let key = key(url, &probe);
        for id in ids {
            assert!(
                !key.starts_with(&format!("{id}:")),
                "{url} => {key} spells a {id} key"
            );
        }
    }
}

#[test]
fn http_and_https_on_the_same_path_are_one_key_the_scheme_is_not_part_of_the_identity() {
    assert_eq!(bare("http://example.com/a"), bare("https://example.com/a"));
}

#[test]
fn an_unparseable_string_is_its_own_key_and_two_different_ones_are_two_keys() {
    // Never empty-handed: two unrelated failures sharing one key is the silent wrong match this
    // function exists to avoid.
    let probe = Probe::new();
    assert_eq!(key("not a url", &probe), "not a url");
    assert_eq!(key("  NOT A URL  ", &probe), "not a url");
    assert_ne!(bare("not a url"), bare("also not a url"));
}
