/**
 * Turning a URL into the key two URLs must share to be "the same model".
 *
 * **Here, in `contract`, rather than in the shell**, for two reasons. It belongs beside the schema
 * that validates the string it parses — `schemas.ts`'s `z.url()` on `website` is what guarantees a
 * stored `projects.website` is a URL at all — and the renderer is its only caller: the download
 * landing page runs it over `projects.list`, which it is already fetching for its project picker
 * (spec 6.4). It adds **no method to `ApiClient`**, so nothing about dispatch, the server or the
 * IPC surface moves because this exists.
 */

/**
 * The part of a site registry row that `matchKey` needs.
 *
 * The registry itself lives in the shell (`packages/desktop/src/browse/registry.ts`) because its
 * other fields — `displayName`, `homeUrl` — are things only the browse view uses, and because a
 * `contract` that carried a table of third-party websites would be describing the outside world
 * rather than this app's API. `ModelSiteDef` is structurally assignable to this, which is what
 * `packages/desktop/test/browse.test.ts` relies on when it passes the real registry in.
 */
export type ModelSiteIdentity = {
  /** Prefixes the key, so two sites cannot collide on a bare id. */
  id: string
  /** Matched against the URL's host, lowercased, with a leading `www.` stripped. */
  hosts: readonly string[]
  /**
   * The site-stable identity of a model URL, or `null` if this URL is not a model page.
   *
   * Called with the **normalised** URL: host lowercased and `www.`-stripped, and query and
   * fragment already emptied. An implementation therefore never has to think about `?lang=de`,
   * and one that reads `url.search` will find nothing there by construction.
   */
  identity(url: URL): string | null
}

/**
 * The match key for a URL: `"<site id>:<identity>"` where a registry row recognises it, and
 * lowercased `host + pathname` where none does.
 *
 * **Every clause answers a row the spike measured** (`.superpowers/spikes/2026-08-28-model-browser-facts.md`
 * §9), not a taste:
 *
 * - **The query and the fragment are dropped entirely**, before any row sees the URL, because
 *   Printables puts the locale in a *query* — a request for `/de/model/1807378-…` landed on
 *   `/model/1807378-…?lang=de` with the canonical unchanged — and MakerWorld appends
 *   `?from=recommend` on referral links and a `#profileId-<n>` fragment at runtime.
 *
 *   **What this clause is, stated exactly, because the obvious claim for it is false.** It does not
 *   change any key this file can produce today. Every key here is built from `URL.pathname`, which
 *   never contains a query or a fragment in the first place — deleting both assignments leaves
 *   every Printables and MakerWorld fixture green, which was measured by deleting them. What the
 *   clause is, is the **precondition on `identity()`** stated in `ModelSiteIdentity` above: a row
 *   is handed a URL that has already had them removed, so no row has to remember to, and a row
 *   that reaches for `url.search` finds nothing. It is enforced at that hand-off and tested there
 *   (`packages/contract/test/match-key.test.ts`), not through a key that would differ.
 * - **A per-site identity rather than `host + pathname`**, because a naive path match fails on
 *   exactly the two sites that emit `hreflang` alternates. MakerWorld's locale is a path *segment*
 *   (twelve alternates observed); Cults3D translates the path segments themselves
 *   (`/de/modell-3d/verschiedene/…`, `/ja/3d-moderu/iroiro/…`), which no generic normalisation can
 *   undo.
 * - **`<id>-<slug>` matches on the id alone** because the slug derives from the title, so a
 *   retitled model changes it.
 * - **Cults3D is the final path segment alone** because nothing else in its URL survives a locale
 *   change, and the category segment (`various`, `home`) also differs per model.
 * - **The fallback is `host + pathname`**, honest about being the weaker key rather than pretending
 *   the four measured rows are the whole web. The trailing slash goes so that a stored
 *   `https://example.com/thing/` and a browsed `https://example.com/thing` are one key.
 *
 * **This is a consequence of the measured rows and not a rule that was tested** against real
 * `projects.website` values (spec 9.8). The URL *shapes* were measured on live sites; the key
 * derived from them has never been run over a real library. Do not upgrade this to a certainty.
 * The exhaustive fixture test over the spike's own URLs is the cheapest available substitute, and
 * it is the only coverage this rule will ever get until someone runs it over a real library.
 *
 * Because of that, a match is a **suggestion the user confirms**, never something applied silently
 * (spec 6.3) — a wrong silent match puts someone's file in someone else's project.
 *
 * **Erring narrow on purpose.** Where a choice was available this function prefers *not* matching
 * to matching: an unrecognised host keeps its whole pathname rather than being trimmed towards
 * some common prefix; a host must match a registry row *exactly* after the `www.` strip, so
 * `cdn.thingiverse.com` is not Thingiverse; and a recognised host whose `identity()` says `null` —
 * a site's home page, a listing — falls back to the full path rather than being keyed to the site.
 *
 * **Total, and never `null`.** An unparseable string comes back as itself, trimmed and lowercased.
 * That is deliberate: `null` would be a key two unrelated failures shared, and `null === null`
 * inside a caller comparing two keys is exactly the silent wrong match this function is supposed
 * to avoid. Two different unparseable strings give two different keys; two identical ones are the
 * same string and matching them is correct.
 */
export function matchKey(url: string, sites: readonly ModelSiteIdentity[]): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url.trim().toLowerCase()
  }

  parsed.search = ''
  parsed.hash = ''
  const host = parsed.host.toLowerCase().replace(/^www\./, '')
  // `new URL()` lowercases the host itself for a *special* scheme (http, https, file, ws…), so the
  // `toLowerCase()` above only does work for a non-special one — `new URL('spm://APP/x').host` is
  // `APP`. Writing the normalised host back is what makes `identity()` see the same host the row
  // was matched on rather than a `www.` form.
  parsed.host = host

  // Captured before the loop, so a row's `identity()` cannot move the fallback out from under it
  // by mutating the URL object it is handed.
  const fallback = `${host}${parsed.pathname.toLowerCase().replace(/\/+$/, '')}`

  for (const site of sites) {
    if (!site.hosts.includes(host)) continue
    const identity = site.identity(parsed)
    if (identity !== null) return `${site.id}:${identity}`
  }

  return fallback
}
