//! The four model sites, as measured: what each is called, where browsing them starts, and how to
//! read a model's identity out of one of its URLs.
//!
//! **Code, not configuration**, for the same reason the slicer registry is: every field is a
//! measured property of somebody else's website (spike `2026-08-28-model-browser-facts.md` §9),
//! and a user has no business editing any of it. A wrong host here is a download attributed to the
//! wrong site; a wrong identity is a file offered to the wrong project.
//!
//! **It drives three things and deliberately not a fourth.** The start page, the URL matching of
//! spec 6.2, and the label a download is attributed to; it does **not** restrict navigation.
//! Containment is the child webview's own storage, its absent permissions and
//! [`crate::browse::policy::browse_navigation_policy`]; a table of four hostnames is not a
//! security boundary and must never be read as one.
//!
//! The matching itself is `spm_core::match_key`, which takes the rows through
//! [`spm_core::match_key::ModelSiteIdentity`]; this module is those rows.

use spm_core::dto::ModelSiteDto;
use spm_core::match_key::{ModelSiteIdentity, match_key};
use url::Url;

/// How a site's model URL is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Identity {
    /// `/thing:<id>`; the numeric id is the whole identity.
    Thing,
    /// The numeric id in the segment that follows a marker segment (`model`, `models`).
    IdAfter(&'static str),
    /// The final path segment, percent-decoded and lowercased.
    LastSegment,
}

/// One row of the registry.
#[derive(Debug, Clone)]
pub struct ModelSite {
    pub id: &'static str,
    pub display_name: &'static str,
    /// Matched against a URL's host (with its port, if any) with a leading `www.` stripped.
    pub hosts: Vec<String>,
    /// Where "browse this site" starts.
    pub home_url: &'static str,
    identity: Identity,
}

/// The non-empty path segments, so every row can stop thinking about slashes.
fn segments(url: &Url) -> Vec<&str> {
    url.path_segments()
        .map(|parts| parts.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default()
}

/// The numeric id in the segment that follows `marker`, or `None`.
///
/// The marker is searched for anywhere in the path rather than pinned to position 0, which is what
/// makes MakerWorld's locale segment free (`/de/models/<id>-<slug>` and `/en/models/<id>-<slug>`
/// both land on `models`). The id is leading digits terminated by `-` or by the end of the
/// segment, so both `2093108-dji-neo-2-the-box` and the slug-less `2093108` read as `2093108`, and
/// a segment that merely *starts* with digits and continues into letters does not.
///
/// What the unpinned marker costs: a path that merely *contains* the segment reads as a model
/// (`/social/1-user/model/999-x` keys as `printables:999`). No such URL is known on either site,
/// and pinning the marker is what breaks the locale segment, so the cost is pinned by a test
/// rather than fixed.
fn id_after(url: &Url, marker: &str) -> Option<String> {
    let parts = segments(url);
    let index = parts.iter().position(|segment| *segment == marker)?;
    let next = parts.get(index + 1)?;
    let digits: String = next.chars().take_while(char::is_ascii_digit).collect();
    let rest = &next[digits.len()..];
    (!digits.is_empty() && (rest.is_empty() || rest.starts_with('-'))).then_some(digits)
}

fn thing_id(url: &Url) -> Option<String> {
    segments(url).into_iter().find_map(|segment| {
        let id = segment.strip_prefix("thing:")?;
        (!id.is_empty() && id.chars().all(|c| c.is_ascii_digit())).then(|| id.to_owned())
    })
}

/// Cults3D: **the final path segment, and nothing else**. There is no numeric id anywhere in a
/// Cults3D URL and the whole path is translated (`/en/3d-model/various/hyper-hopper` has the
/// alternates `/de/modell-3d/verschiedene/…` and `/ja/3d-moderu/iroiro/…`), so only the last
/// segment survives a locale change. Percent-decoded because the alternates are, and lowercased
/// because a slug is; a segment that cannot be decoded keys on its raw text rather than failing a
/// page that is only trying to suggest a project.
///
/// **The known cost, stated as the whole class:** every non-model page on the site lands in the
/// model key namespace (`/en/users/hyper-hopper`, `/en/tags/hyper-hopper` and the locale home
/// `/en`). A match is a suggestion the user confirms, which is what makes that survivable.
fn last_segment(url: &Url) -> Option<String> {
    let last = *segments(url).last()?;
    let decoded = spm_http::percent::try_decode_uri_component(last).unwrap_or_else(|| last.into());
    Some(decoded.to_lowercase())
}

impl ModelSiteIdentity for ModelSite {
    fn id(&self) -> &str {
        self.id
    }

    fn hosts(&self) -> &[String] {
        &self.hosts
    }

    fn identity(&self, url: &Url) -> Option<String> {
        match self.identity {
            Identity::Thing => thing_id(url),
            Identity::IdAfter(marker) => id_after(url, marker),
            Identity::LastSegment => last_segment(url),
        }
    }
}

/// The host a URL is attributed with: lowercased, a leading `www.` stripped, a non-default port
/// kept (so `thingiverse.com:8443` is not Thingiverse, exactly as `match_key` picks a row).
fn normalised_host(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// The four sites.
#[derive(Debug, Clone)]
pub struct SiteRegistry {
    sites: Vec<ModelSite>,
}

impl SiteRegistry {
    /// The four measured sites, in the order the chrome offers them.
    pub fn standard() -> SiteRegistry {
        let site = |id, display_name, host: &str, home_url, identity| ModelSite {
            id,
            display_name,
            hosts: vec![host.to_owned()],
            home_url,
            identity,
        };
        SiteRegistry {
            sites: vec![
                // `/files`, `/comments`, `/apps` and `/makes` all hang off one base, and the page
                // carries no `<link rel=canonical>` and no `og:url`, so there is nothing else to read.
                site(
                    "thingiverse",
                    "Thingiverse",
                    "thingiverse.com",
                    "https://www.thingiverse.com/",
                    Identity::Thing,
                ),
                // `/model/<id>-<slug>`; the slug derives from the title, so only the id is stable.
                site(
                    "printables",
                    "Printables",
                    "printables.com",
                    "https://www.printables.com/",
                    Identity::IdAfter("model"),
                ),
                // No `www.` on the home URL: the site's own canonical is
                // `https://makerworld.com/en/models/…`. The locale is left off so the site picks
                // its own default. Twelve `hreflang` alternates, all differing only in locale.
                site(
                    "makerworld",
                    "MakerWorld",
                    "makerworld.com",
                    "https://makerworld.com/",
                    Identity::IdAfter("models"),
                ),
                site(
                    "cults3d",
                    "Cults3D",
                    "cults3d.com",
                    "https://cults3d.com/",
                    Identity::LastSegment,
                ),
            ],
        }
    }

    /// Makes `host` (a hostname with its port, lowercase) one more host of the site `site_id`.
    ///
    /// **Tests only.** The automated tests cannot depend on the four real sites (Cloudflare,
    /// consent banners, the network), so a fixture server on `127.0.0.1:<port>` stands in for one;
    /// the desktop app calls this from a debug build only, and from nowhere in a release build.
    pub fn add_test_host(&mut self, site_id: &str, host: &str) -> bool {
        match self.sites.iter_mut().find(|site| site.id == site_id) {
            Some(site) => {
                site.hosts.push(host.to_lowercase());
                true
            }
            None => false,
        }
    }

    pub fn sites(&self) -> &[ModelSite] {
        &self.sites
    }

    /// What the page renders its start links from.
    pub fn dtos(&self) -> Vec<ModelSiteDto> {
        self.sites
            .iter()
            .map(|site| ModelSiteDto {
                id: site.id.to_owned(),
                display_name: site.display_name.to_owned(),
                home_url: site.home_url.to_owned(),
            })
            .collect()
    }

    /// Where a browser with nothing to go back to opens.
    pub fn start_url(&self) -> &str {
        self.sites
            .first()
            .map_or("about:blank", |site| site.home_url)
    }

    /// The row a URL belongs to, or `None`.
    ///
    /// **Host only: this answers "who wrote this page", never "may this page be shown".** It is
    /// what `siteId` and a download's attribution are built from. The normalisation is
    /// `match_key`'s, because the two have to agree or a page can be attributed to Thingiverse and
    /// keyed as something else. A subdomain does **not** match: `cdn.thingiverse.com` is a file
    /// host, not a model page.
    pub fn site_for_url(&self, url: &str) -> Option<&ModelSite> {
        let parsed = Url::parse(url).ok()?;
        let host = normalised_host(&parsed)?;
        self.sites.iter().find(|site| site.hosts.contains(&host))
    }

    /// The key two URLs must share to be the same model (`spm_core::match_key`, over these rows).
    pub fn match_key(&self, url: &str) -> String {
        match_key(url, &self.sites)
    }
}

impl Default for SiteRegistry {
    fn default() -> SiteRegistry {
        SiteRegistry::standard()
    }
}
