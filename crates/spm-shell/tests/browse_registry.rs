//! Ported from `browse-registry.test.ts`: the four measured sites and the key that decides whether
//! a browsed URL is a project the library already has. `match_key` is exercised here against the
//! **real** registry rows, not a probe site.

use spm_core::match_key::ModelSiteIdentity;
use spm_shell::browse::registry::SiteRegistry;
use url::Url;

fn registry() -> SiteRegistry {
    SiteRegistry::standard()
}

fn key(url: &str) -> String {
    registry().match_key(url)
}

fn site_id(url: &str) -> Option<&'static str> {
    registry().site_for_url(url).map(|site| site.id)
}

#[test]
fn the_registry_has_the_four_measured_sites_with_distinct_ids() {
    let registry = registry();
    let ids: Vec<&str> = registry.sites().iter().map(|site| site.id).collect();
    assert_eq!(ids, ["thingiverse", "printables", "makerworld", "cults3d"]);
    let mut unique = ids.clone();
    unique.dedup();
    assert_eq!(unique.len(), ids.len());
}

#[test]
fn every_hosts_entry_is_lowercase_and_carries_no_www() {
    for site in registry().sites() {
        assert!(!site.hosts.is_empty(), "{}", site.id);
        for host in &site.hosts {
            assert_eq!(*host, host.to_lowercase(), "{}: {host}", site.id);
            assert!(!host.starts_with("www."), "{}: {host}", site.id);
        }
    }
}

#[test]
fn every_home_url_parses_is_https_and_is_on_one_of_the_rows_own_hosts() {
    for site in registry().sites() {
        let parsed = Url::parse(site.home_url).unwrap();
        assert_eq!(parsed.scheme(), "https", "{}", site.id);
        let host = parsed.host_str().unwrap();
        let host = host.strip_prefix("www.").unwrap_or(host);
        assert!(
            site.hosts.iter().any(|candidate| candidate == host),
            "{}",
            site.id
        );
        assert!(!site.display_name.is_empty());
    }
}

#[test]
fn identity_is_none_for_the_registry_home_url_but_only_for_that_exact_spelling() {
    for site in registry().sites() {
        assert_eq!(
            site.identity(&Url::parse(site.home_url).unwrap()),
            None,
            "{}",
            site.id
        );
    }
}

#[test]
fn a_registry_home_url_keys_to_its_host_not_to_the_site() {
    let keys: Vec<String> = registry()
        .sites()
        .iter()
        .map(|site| key(site.home_url))
        .collect();
    assert_eq!(
        keys,
        [
            "thingiverse.com",
            "printables.com",
            "makerworld.com",
            "cults3d.com"
        ]
    );
}

#[test]
fn cults3ds_row_puts_every_non_model_page_in_the_model_key_namespace_the_cost_pinned() {
    let model = key("https://cults3d.com/en/3d-model/various/hyper-hopper");
    assert_eq!(model, "cults3d:hyper-hopper");
    for url in [
        "https://cults3d.com/en/users/hyper-hopper",
        "https://cults3d.com/en/tags/hyper-hopper",
    ] {
        assert_eq!(key(url), model, "{url}");
    }
    assert_eq!(key("https://cults3d.com/en"), "cults3d:en");
    assert_eq!(key("https://cults3d.com/de"), "cults3d:de");
}

#[test]
fn the_id_bearing_rows_read_their_marker_at_any_depth_and_that_is_aggressive_in_one_direction() {
    assert_eq!(
        key("https://www.printables.com/social/1-user/model/999-x"),
        "printables:999"
    );
}

/// Every URL below was observed on a live site during the spike (§9): a canonical form, an
/// `hreflang` alternate, a sub-path, or a query/fragment the site's own app appends at runtime.
const MATCH_FIXTURES: &[(&str, &str)] = &[
    (
        "https://www.thingiverse.com/thing:7401409",
        "thingiverse:7401409",
    ),
    (
        "https://www.thingiverse.com/thing:7401409/files",
        "thingiverse:7401409",
    ),
    (
        "https://www.thingiverse.com/thing:7401409/comments",
        "thingiverse:7401409",
    ),
    (
        "https://www.thingiverse.com/thing:7401409/apps",
        "thingiverse:7401409",
    ),
    (
        "https://www.thingiverse.com/thing:7401409/makes",
        "thingiverse:7401409",
    ),
    (
        "https://thingiverse.com/thing:7401409",
        "thingiverse:7401409",
    ),
    (
        "http://www.thingiverse.com/thing:7401409",
        "thingiverse:7401409",
    ),
    (
        "https://www.printables.com/model/1807378-universal-clip-self-tightening",
        "printables:1807378",
    ),
    (
        "https://www.printables.com/model/1807378-universal-clip-self-tightening?lang=de",
        "printables:1807378",
    ),
    (
        "https://www.printables.com/de/model/1807378-universal-clip-self-tightening",
        "printables:1807378",
    ),
    (
        "https://makerworld.com/en/models/2093108-dji-neo-2-the-box",
        "makerworld:2093108",
    ),
    (
        "https://makerworld.com/de/models/2093108-dji-neo-2-the-box",
        "makerworld:2093108",
    ),
    (
        "https://makerworld.com/en/models/2093108-dji-neo-2-the-box?from=recommend",
        "makerworld:2093108",
    ),
    (
        "https://makerworld.com/en/models/2093108-dji-neo-2-the-box#profileId-9",
        "makerworld:2093108",
    ),
    (
        "https://makerworld.com/de/models/2093108",
        "makerworld:2093108",
    ),
    (
        "https://cults3d.com/en/3d-model/various/hyper-hopper",
        "cults3d:hyper-hopper",
    ),
    (
        "https://cults3d.com/de/modell-3d/verschiedene/hyper-hopper",
        "cults3d:hyper-hopper",
    ),
    (
        "https://cults3d.com/ja/3d-moderu/iroiro/hyper-hopper",
        "cults3d:hyper-hopper",
    ),
    (
        "https://cults3d.com/zh/3d-m%C3%B3x%C3%ADng/du%C5%8Dxi%C3%A0ng/hyper-hopper",
        "cults3d:hyper-hopper",
    ),
    ("https://example.com/some/path/", "example.com/some/path"),
];

#[test]
fn match_key_maps_every_url_the_spike_observed_to_its_site_stable_key() {
    for (url, expected) in MATCH_FIXTURES {
        assert_eq!(key(url), *expected, "{url}");
    }
}

#[test]
fn the_four_canonical_forms_are_four_distinct_keys() {
    let canonical: Vec<String> = [
        "https://www.thingiverse.com/thing:7401409",
        "https://www.printables.com/model/1807378-universal-clip-self-tightening",
        "https://makerworld.com/en/models/2093108-dji-neo-2-the-box",
        "https://cults3d.com/en/3d-model/various/hyper-hopper",
    ]
    .iter()
    .map(|url| key(url))
    .collect();
    assert_eq!(
        canonical,
        [
            "thingiverse:7401409",
            "printables:1807378",
            "makerworld:2093108",
            "cults3d:hyper-hopper"
        ]
    );
}

#[test]
fn a_different_model_on_the_same_site_is_a_different_key() {
    let urls = [
        "https://www.thingiverse.com/thing:7401409",
        "https://www.thingiverse.com/thing:7401410",
        "https://www.printables.com/model/1807378-universal-clip-self-tightening",
        "https://www.printables.com/model/1807379-universal-clip-self-tightening",
        "https://makerworld.com/en/models/2093108-dji-neo-2-the-box",
        "https://makerworld.com/en/models/2093109-dji-neo-2-the-box",
        "https://cults3d.com/en/3d-model/various/hyper-hopper",
        "https://cults3d.com/en/3d-model/various/hyper-hopper-2",
        "https://www.printables.com/model/7401409-something",
    ];
    let mut keys: Vec<String> = urls.iter().map(|url| key(url)).collect();
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), urls.len());
}

#[test]
fn a_non_model_page_on_a_known_site_keys_to_its_path_not_to_the_site() {
    for (url, expected) in [
        (
            "https://www.thingiverse.com/marcs/designs",
            "thingiverse.com/marcs/designs",
        ),
        ("https://www.printables.com/model", "printables.com/model"),
        (
            "https://makerworld.com/en/models",
            "makerworld.com/en/models",
        ),
    ] {
        assert_eq!(key(url), expected, "{url}");
    }
}

#[test]
fn url_shapes_no_measured_url_exercises_synthetic_constructed_rather_than_observed() {
    let registry = registry();
    let find = |id: &str| registry.sites().iter().find(|site| site.id == id).unwrap();
    assert_eq!(
        find("cults3d").identity(
            &Url::parse("https://cults3d.com/fr/modele-3d/divers/Porte-Cl%C3%A9").unwrap()
        ),
        Some("porte-clé".to_owned())
    );
    assert_eq!(
        find("printables")
            .identity(&Url::parse("https://www.printables.com/model/1807378abc").unwrap()),
        None
    );
    assert_eq!(
        key("https://cults3d.com/en/3d-model/various/hyper-hopper/"),
        "cults3d:hyper-hopper"
    );
}

#[test]
fn a_url_is_attributed_to_the_site_that_serves_it_and_to_nothing_else() {
    for (url, expected) in [
        (
            "https://www.thingiverse.com/thing:7401409",
            Some("thingiverse"),
        ),
        ("https://www.thingiverse.com/", Some("thingiverse")),
        ("https://thingiverse.com/thing:1", Some("thingiverse")),
        ("https://WWW.Thingiverse.COM/thing:1", Some("thingiverse")),
        (
            "https://www.printables.com/model/1807378-universal-clip?lang=de",
            Some("printables"),
        ),
        (
            "https://makerworld.com/en/models/2093108-dji-neo-2-the-box",
            Some("makerworld"),
        ),
        (
            "https://cults3d.com/en/3d-model/various/hyper-hopper",
            Some("cults3d"),
        ),
        ("https://cdn.thingiverse.com/assets/1.stl", None),
        ("https://thingiverse.com:8443/thing:1", None),
        ("https://example.com/anything", None),
        ("https://not-thingiverse.com/thing:1", None),
        ("blob:https://www.thingiverse.com/ae5e9664", None),
        ("not a url", None),
        ("", None),
    ] {
        assert_eq!(site_id(url), expected, "{url}");
    }
}

#[test]
fn a_test_host_makes_a_fixture_server_stand_in_for_a_site_and_nothing_else_does() {
    let mut registry = registry();
    assert!(registry.add_test_host("thingiverse", "127.0.0.1:4242"));
    assert!(!registry.add_test_host("nonesuch", "127.0.0.1:1"));
    assert_eq!(
        registry
            .site_for_url("http://127.0.0.1:4242/thing:9/files")
            .map(|site| site.id),
        Some("thingiverse")
    );
    assert_eq!(
        registry.match_key("http://127.0.0.1:4242/thing:9/files"),
        "thingiverse:9"
    );
    // Another port on the same machine is not the stand-in.
    assert!(
        registry
            .site_for_url("http://127.0.0.1:4243/thing:9")
            .is_none()
    );
}
