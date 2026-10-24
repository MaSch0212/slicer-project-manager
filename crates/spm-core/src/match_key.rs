//! Turning a URL into the key two URLs must share to be "the same model".
//!
//! Pure, and the renderer's only caller in the original; here it lives in core beside the
//! validation of the `website` it parses. A match is a *suggestion the user confirms*, never
//! something applied silently: a wrong silent match puts someone's file in someone else's project.
//!
//! Every clause answers a measured site behaviour, not a taste:
//!
//! * **The query and the fragment are dropped** before any site sees the URL, because Printables
//!   puts the locale in a query and MakerWorld appends `?from=recommend` and a `#profileId-n`
//!   fragment. This is the precondition on [`ModelSiteIdentity::identity`]: a site is handed a URL
//!   with both already removed, so no site has to remember to.
//! * **A per-site identity rather than `host + pathname`**, because sites that translate their
//!   path segments (or carry the locale in them) defeat a naive path match.
//! * **The fallback is `hostname + pathname`**, lowercased, trailing slashes removed, `www.`
//!   stripped, the scheme ignored. A port is kept (two servers on one hostname are two keys) but
//!   rendered `hostname_port`, and that separator is load-bearing: `https://thingiverse:1234/`
//!   would otherwise fall back to `thingiverse:1234`, the key a real Thingiverse model produces,
//!   so a crafted website could synthesise a real model's key. With `_`, a fallback key's `:` can
//!   only come from the path (always behind a `/`) or an IPv6 literal (always behind a `[`), and a
//!   site id contains neither, so the two key namespaces are structurally disjoint.
//! * **Erring narrow on purpose.** A host must match a site row *exactly* after the `www.` strip
//!   (`cdn.thingiverse.com` is not Thingiverse), and a recognised host whose `identity` says
//!   `None` (a home page, a listing) falls back to the full path rather than being keyed to the
//!   site.
//! * **Total, and never empty-handed.** An unparseable string comes back as itself, trimmed and
//!   lowercased: two different unparseable strings are two different keys, and "no key" is never a
//!   value two unrelated failures could share.

use url::Url;

/// The part of a model-site registry row that [`match_key`] needs.
pub trait ModelSiteIdentity {
    /// Prefixes the key, so two sites cannot collide on a bare id. It must not contain `:` or `/`.
    fn id(&self) -> &str;

    /// Matched against the URL's host, lowercased, with a leading `www.` stripped.
    fn hosts(&self) -> &[String];

    /// The site-stable identity of a model URL, or `None` if this URL is not a model page.
    ///
    /// Called with the *normalised* URL: host lowercased and `www.`-stripped, query and fragment
    /// already emptied.
    fn identity(&self, url: &Url) -> Option<String>;
}

/// The match key for `url`: `"<site id>:<identity>"` where a site recognises it, and the lowercased
/// `hostname[_port]` + `pathname` where none does.
pub fn match_key<S: ModelSiteIdentity>(url: &str, sites: &[S]) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return url.trim().to_lowercase();
    };

    parsed.set_query(None);
    parsed.set_fragment(None);

    // `host` in the URL standard includes a non-default port.
    let hostname = parsed.host_str().unwrap_or_default().to_lowercase();
    let hostname = hostname
        .strip_prefix("www.")
        .unwrap_or(&hostname)
        .to_owned();
    let host = match parsed.port() {
        Some(port) => format!("{hostname}:{port}"),
        None => hostname.clone(),
    };
    // The `url` crate lowercases the host of a special scheme (http, https, ...) itself, so the
    // `to_lowercase` above only does work for a non-special one (`custom://MiXeD/x`), where the
    // standard leaves the case alone. Writing the normalised host back is what makes a site's
    // `identity` see the same host the row was matched on rather than a `www.` form. A host the
    // parser then refuses (`www.` alone) is left as it was, as the standard's setter does.
    let _ = parsed.set_host(Some(&hostname));

    let fallback_host = match parsed.port() {
        Some(port) => format!("{}_{port}", parsed.host_str().unwrap_or_default()),
        None => parsed.host_str().unwrap_or_default().to_owned(),
    };
    // Captured before the loop, so a site's `identity` cannot move the fallback.
    let fallback = format!(
        "{}{}",
        fallback_host.to_lowercase(),
        parsed.path().to_lowercase().trim_end_matches('/')
    );

    for site in sites {
        if !site.hosts().contains(&host) {
            continue;
        }
        if let Some(identity) = site.identity(&parsed) {
            return format!("{}:{identity}", site.id());
        }
    }

    fallback
}
