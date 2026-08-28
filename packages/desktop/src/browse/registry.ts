/**
 * The four model sites, as measured — what each is called, where browsing them starts, and how to
 * read a model's identity out of one of its URLs.
 *
 * **Code, not configuration**, for the same reason `slicers/registry.ts` is: every field is a
 * measured property of somebody else's website
 * (`.superpowers/spikes/2026-08-28-model-browser-facts.md` §9), and a user has no business editing
 * any of it. A wrong `hosts` entry here is a download attributed to the wrong site; a wrong
 * `identity` is a file offered to the wrong project.
 *
 * **It drives three things and deliberately not a fourth.** The start page, the URL matching of
 * spec 6.2, and the label a download is attributed to — and it does **not** restrict navigation.
 * Nothing stops a user typing another URL into the address control; they simply get no site
 * identity for it and `matchKey`'s fallback applies. Containment is the browse partition and the
 * absent preload (spec 3.4, 3.2), plus `browseNavigationPolicy` in `../urls.ts`; a table of four
 * hostnames is not a security boundary and must never be read as one.
 */

export type ModelSiteDef = {
  id: 'thingiverse' | 'printables' | 'makerworld' | 'cults3d'
  displayName: string
  /** Matched against a URL's host with a leading `www.` stripped, lowercased. */
  hosts: string[]
  /** Where "browse this site" starts. */
  homeUrl: string
  /** Returns the site-stable identity of a model URL, or null if this is not one. */
  identity(url: URL): string | null
}

/** The non-empty path segments, so every row below can stop thinking about slashes. */
function segments(url: URL): string[] {
  return url.pathname.split('/').filter((segment) => segment.length > 0)
}

/**
 * The numeric id in the segment that follows `marker`, or `null`.
 *
 * Searching for the marker anywhere in the path rather than pinning it to position 0 is what
 * makes MakerWorld's locale segment free — `/de/models/<id>-<slug>` and `/en/models/<id>-<slug>`
 * both land on `models` — and it costs nothing on Printables, whose locale is a query instead but
 * which redirects `/de/model/<id>-…` to the un-prefixed form anyway.
 *
 * The id is matched as leading digits terminated by `-` or by the end of the segment, so both
 * `2093108-dji-neo-2-the-box` and the slug-less `2093108` (which the site 307s to the canonical)
 * read as `2093108`, and a segment that merely *starts* with digits and continues into letters
 * does not.
 *
 * **What the unpinned marker costs**, since the terminator note above only covers the other half:
 * the marker is matched at *any* depth, so a path that merely contains the segment reads as a
 * model. `https://www.printables.com/social/1-user/model/999-x` keys as `printables:999` against
 * this registry, verified. No such URL is known on either site — every observed Printables and
 * MakerWorld path has the marker at depth 0 or 1 — so this is a shape the rule would mis-key if it
 * appeared, not one it mis-keys today. Pinning the marker to position 0 is not the fix: that is
 * exactly what makes MakerWorld's locale segment stop working, measured by doing it.
 */
function idAfter(url: URL, marker: string): string | null {
  const parts = segments(url)
  const index = parts.indexOf(marker)
  if (index < 0) return null
  const next = parts[index + 1]
  if (next === undefined) return null
  return /^(\d+)(?:-|$)/.exec(next)?.[1] ?? null
}

export const MODEL_SITES: readonly ModelSiteDef[] = [
  {
    id: 'thingiverse',
    displayName: 'Thingiverse',
    hosts: ['thingiverse.com'],
    homeUrl: 'https://www.thingiverse.com/',
    /**
     * `/thing:<id>`, and the numeric id is the whole identity: `/files`, `/comments`, `/apps` and
     * `/makes` all hang off the same base, and the page carries **no `<link rel=canonical>` and no
     * `og:url` at all** (both `null` on two different things), so there is nothing else to read.
     */
    identity: (url) => {
      for (const segment of segments(url)) {
        const id = /^thing:(\d+)$/.exec(segment)?.[1]
        if (id !== undefined) return id
      }
      return null
    },
  },
  {
    id: 'printables',
    displayName: 'Printables',
    hosts: ['printables.com'],
    homeUrl: 'https://www.printables.com/',
    /** `/model/<id>-<slug>`; the slug derives from the title, so only the id is stable. */
    identity: (url) => idAfter(url, 'model'),
  },
  {
    id: 'makerworld',
    displayName: 'MakerWorld',
    hosts: ['makerworld.com'],
    /**
     * No `www.` on the home URL: the site's own canonical is `https://makerworld.com/en/models/…`.
     * The locale segment is left off here so the site picks its own default.
     */
    homeUrl: 'https://makerworld.com/',
    /** `/<locale>/models/<id>-<slug>`, twelve `hreflang` alternates, all differing only in locale. */
    identity: (url) => idAfter(url, 'models'),
  },
  {
    id: 'cults3d',
    displayName: 'Cults3D',
    hosts: ['cults3d.com'],
    homeUrl: 'https://cults3d.com/',
    /**
     * **The final path segment, and nothing else** — there is no numeric id anywhere in a Cults3D
     * URL and the whole path is translated: `/en/3d-model/various/hyper-hopper` has alternates
     * `/de/modell-3d/verschiedene/…`, `/ja/3d-moderu/iroiro/…`,
     * `/zh/3d-m%C3%B3x%C3%ADng/du%C5%8Dxi%C3%A0ng/…`. Both the type segment *and* the category
     * segment change per locale, and the category also differs per model (`various`, `home`), so
     * neither is stable even within one locale.
     *
     * Percent-decoded because the alternates are, and lowercased because a slug is. The decode is
     * guarded: `decodeURIComponent` throws on a lone `%`, and a URL that cannot be decoded should
     * key on its raw segment rather than blow up a page that is only trying to suggest a project.
     *
     * **The known cost of this row, stated as the whole class rather than one example.** The row
     * reads the final segment of *any* Cults3D path, so **every non-model page on the site lands in
     * the model key namespace**, and any two Cults3D URLs whose final segments match share a key.
     * Run through `matchKey` against this registry:
     *
     * ```
     * https://cults3d.com/en/3d-model/various/hyper-hopper  =>  cults3d:hyper-hopper
     * https://cults3d.com/en/users/hyper-hopper             =>  cults3d:hyper-hopper
     * https://cults3d.com/en/tags/hyper-hopper              =>  cults3d:hyper-hopper
     * https://cults3d.com/en                                =>  cults3d:en
     * ```
     *
     * A designer profile whose handle equals one of their own model slugs is the realistic pairing
     * here — considerably more likely than a model slugged `various` colliding with the
     * `/en/3d-model/various` listing, which is the only case an earlier draft of this note
     * described. The locale home is the same class: `https://cults3d.com/` is not what a user
     * copies. Measured 2026-08-29 over the network, it answers **200 with no redirect**, but its
     * own `<link rel="canonical">` is `https://cults3d.com/en` — so the URL a browsing user sits on
     * and pastes is the locale-prefixed one, and that keys as `cults3d:en`.
     *
     * The alternative — requiring the four-segment shape the spike observed — invents a pattern
     * from four sampled URLs, and would break the moment Cults3D varied its depth. Spec 6.2's row
     * wins, and spec 6.3's rule that a match is a suggestion the user confirms is what makes the
     * cost survivable. This note is here so a future reader knows the choice was made rather than
     * missed, and `browse-registry.test.ts` pins every line of the block above by value.
     */
    identity: (url) => {
      const parts = segments(url)
      const last = parts[parts.length - 1]
      if (last === undefined) return null
      let decoded: string
      try {
        decoded = decodeURIComponent(last)
      } catch {
        decoded = last
      }
      return decoded.toLowerCase()
    },
  },
]
