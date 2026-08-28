import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchKey } from '@spm/contract/match-key.ts'
import { MODEL_SITES, siteForUrl } from '../src/browse/registry.ts'

/**
 * The four measured model sites, and the key that decides whether a browsed URL is a project the
 * library already has.
 *
 * `matchKey` is exercised here, against the **real** registry rows, rather than in
 * `packages/contract/test/match-key.test.ts` — which covers its own clauses against a probe site.
 * A second hand-written copy of these four rules over there would be a test double standing in for
 * the code it is meant to check.
 */

/* -------------------------------------------------------------------------------------------
 * The registry
 * ---------------------------------------------------------------------------------------- */

test('the registry has the four measured sites, with distinct ids', () => {
  assert.deepEqual(
    MODEL_SITES.map((site) => site.id),
    ['thingiverse', 'printables', 'makerworld', 'cults3d'],
  )
  assert.equal(new Set(MODEL_SITES.map((site) => site.id)).size, MODEL_SITES.length)
})

test('every hosts entry is lowercase and carries no www.', () => {
  // `matchKey` lowercases and strips `www.` from the URL before comparing, so a row spelled
  // `www.Thingiverse.com` would never match anything and would fail silently.
  for (const site of MODEL_SITES) {
    assert.ok(site.hosts.length > 0, site.id)
    for (const host of site.hosts) {
      assert.equal(host, host.toLowerCase(), `${site.id}: ${host} is not lowercase`)
      assert.ok(!host.startsWith('www.'), `${site.id}: ${host} carries a www.`)
    }
  }
})

test('every homeUrl parses, is https, and is on one of the row own hosts', () => {
  for (const site of MODEL_SITES) {
    const parsed = new URL(site.homeUrl)
    assert.equal(parsed.protocol, 'https:', site.id)
    assert.ok(
      site.hosts.includes(parsed.host.replace(/^www\./, '')),
      `${site.id}: ${site.homeUrl} is not on ${site.hosts.join(', ')}`,
    )
    assert.ok(site.displayName.length > 0, site.id)
  }
})

test('identity() returns null for the registry homeUrl — but only for that exact spelling', () => {
  /*
   * The narrow claim, and it is worth naming what it does not cover. `homeUrl` is the bare origin
   * for all four rows, and none of them reads it as a model. That is **not** the same as "a home
   * page is not a model", which is what an earlier version of this test name said.
   *
   * Cults3D is where the two come apart. `https://cults3d.com/` answers 200 with no redirect
   * (measured 2026-08-29 over the network), but its own `<link rel="canonical">` is
   * `https://cults3d.com/en` — so the URL a browsing user's address bar carries, and the one they
   * would paste into `projects.website`, is the locale-prefixed form, and that form has a final
   * path segment like any other. It keys as `cults3d:en`. The next test pins that by value rather
   * than leaving the gap between "the registry's home URL" and "the home page" unstated.
   */
  for (const site of MODEL_SITES) {
    assert.equal(site.identity(new URL(site.homeUrl)), null, site.id)
  }
})

test('a registry home URL keys to its host, not to the site — an unmatched page must not collapse', () => {
  assert.deepEqual(
    MODEL_SITES.map((site) => matchKey(site.homeUrl, MODEL_SITES)),
    ['thingiverse.com', 'printables.com', 'makerworld.com', 'cults3d.com'],
  )
})

test("Cults3D's row puts every non-model page in the model key namespace — the cost, pinned", () => {
  /*
   * Not a bug report: this is the measured consequence of spec 6.2's row, which keys a Cults3D URL
   * on its final path segment because nothing else in the path survives a locale change. Reading
   * *any* final segment means every non-model page lands in the same namespace, and two Cults3D
   * URLs whose final segments match share a key.
   *
   * The realistic pairing is a designer profile whose handle equals one of their own model slugs —
   * considerably more likely than the listing-vs-model case an earlier note described. It is
   * asserted here so that task 5 reads the whole class rather than one example, and so a future
   * narrowing of the row has a red test telling it what it changed.
   *
   * spec 6.3 is what makes this survivable: a match is a suggestion the user confirms, never
   * something applied silently.
   */
  const model = matchKey('https://cults3d.com/en/3d-model/various/hyper-hopper', MODEL_SITES)
  assert.equal(model, 'cults3d:hyper-hopper')
  for (const url of [
    'https://cults3d.com/en/users/hyper-hopper',
    'https://cults3d.com/en/tags/hyper-hopper',
  ]) {
    assert.equal(matchKey(url, MODEL_SITES), model, url)
  }

  // The localized home is the same class. `https://cults3d.com/` is not what a user copies.
  assert.equal(matchKey('https://cults3d.com/en', MODEL_SITES), 'cults3d:en')
  assert.equal(matchKey('https://cults3d.com/de', MODEL_SITES), 'cults3d:de')
})

test('the id-bearing rows read their marker at any depth, and that is aggressive in one direction', () => {
  /*
   * The other half of the terminator note in `idAfter`. Searching for `model`/`models` anywhere in
   * the path is what makes MakerWorld's locale segment free — pinning it to position 0 was
   * mutated and reddens the MakerWorld rows — but it also means a deeper path containing the
   * marker reads as a model. No such URL is known on either site; this pins the shape so a future
   * reader knows it was measured rather than missed.
   */
  assert.equal(
    matchKey('https://www.printables.com/social/1-user/model/999-x', MODEL_SITES),
    'printables:999',
  )
})

/* -------------------------------------------------------------------------------------------
 * matchKey over the real registry, against the spike's own URLs
 * ---------------------------------------------------------------------------------------- */

/**
 * Every URL below was observed on a live site during the spike
 * (`.superpowers/spikes/2026-08-28-model-browser-facts.md` §9) — a canonical form, an `hreflang`
 * alternate, a sub-path, or a query/fragment the site's own app appends at runtime.
 *
 * **This is the only coverage the rule will ever get** short of running it over a library of real
 * `projects.website` values, which nobody has done (spec 9.8). The key is a consequence of these
 * rows, not a tested rule.
 */
const MATCH_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  // Thingiverse — the canonical form and the four sub-paths that hang off the same base.
  ['https://www.thingiverse.com/thing:7401409', 'thingiverse:7401409'],
  ['https://www.thingiverse.com/thing:7401409/files', 'thingiverse:7401409'],
  ['https://www.thingiverse.com/thing:7401409/comments', 'thingiverse:7401409'],
  ['https://www.thingiverse.com/thing:7401409/apps', 'thingiverse:7401409'],
  ['https://www.thingiverse.com/thing:7401409/makes', 'thingiverse:7401409'],
  // The `www.` strip and the scheme both have to be immaterial: what a user pasted is whatever
  // their address bar showed them.
  ['https://thingiverse.com/thing:7401409', 'thingiverse:7401409'],
  ['http://www.thingiverse.com/thing:7401409', 'thingiverse:7401409'],

  // Printables — the locale is a *query*: `/de/model/1807378-…` landed on `?lang=de` with the
  // canonical unchanged. The slug derives from the title, so only the id counts.
  ['https://www.printables.com/model/1807378-universal-clip-self-tightening', 'printables:1807378'],
  [
    'https://www.printables.com/model/1807378-universal-clip-self-tightening?lang=de',
    'printables:1807378',
  ],
  [
    'https://www.printables.com/de/model/1807378-universal-clip-self-tightening',
    'printables:1807378',
  ],

  // MakerWorld — the locale is a path *segment* (twelve hreflang alternates), the app appends
  // `?from=recommend` on referral links and a `#profileId-<n>` fragment at runtime, and
  // `/de/models/<id>` with no slug 307s to the canonical.
  ['https://makerworld.com/en/models/2093108-dji-neo-2-the-box', 'makerworld:2093108'],
  ['https://makerworld.com/de/models/2093108-dji-neo-2-the-box', 'makerworld:2093108'],
  [
    'https://makerworld.com/en/models/2093108-dji-neo-2-the-box?from=recommend',
    'makerworld:2093108',
  ],
  ['https://makerworld.com/en/models/2093108-dji-neo-2-the-box#profileId-9', 'makerworld:2093108'],
  ['https://makerworld.com/de/models/2093108', 'makerworld:2093108'],

  // Cults3D — no numeric id anywhere, and both the type segment and the category segment are
  // translated. Only the final segment survives a locale change.
  ['https://cults3d.com/en/3d-model/various/hyper-hopper', 'cults3d:hyper-hopper'],
  ['https://cults3d.com/de/modell-3d/verschiedene/hyper-hopper', 'cults3d:hyper-hopper'],
  ['https://cults3d.com/ja/3d-moderu/iroiro/hyper-hopper', 'cults3d:hyper-hopper'],
  [
    'https://cults3d.com/zh/3d-m%C3%B3x%C3%ADng/du%C5%8Dxi%C3%A0ng/hyper-hopper',
    'cults3d:hyper-hopper',
  ],

  // Anything the registry does not recognise.
  ['https://example.com/some/path/', 'example.com/some/path'],
]

test('matchKey maps every URL the spike observed to its site-stable key', () => {
  for (const [url, expected] of MATCH_FIXTURES) {
    assert.equal(matchKey(url, MODEL_SITES), expected, url)
  }
})

test('the four canonical forms are four distinct keys', () => {
  const canonical = [
    'https://www.thingiverse.com/thing:7401409',
    'https://www.printables.com/model/1807378-universal-clip-self-tightening',
    'https://makerworld.com/en/models/2093108-dji-neo-2-the-box',
    'https://cults3d.com/en/3d-model/various/hyper-hopper',
  ].map((url) => matchKey(url, MODEL_SITES))
  assert.deepEqual(canonical, [
    'thingiverse:7401409',
    'printables:1807378',
    'makerworld:2093108',
    'cults3d:hyper-hopper',
  ])
  assert.equal(new Set(canonical).size, 4)
})

test('a different model on the same site is a different key', () => {
  /*
   * The direction this rule errs is *narrow*: it would rather not match than match the wrong
   * project, because a wrong match puts someone's file in someone else's project. These are the
   * pairs a too-eager key would collapse.
   */
  const distinct = [
    'https://www.thingiverse.com/thing:7401409',
    'https://www.thingiverse.com/thing:7401410',
    'https://www.printables.com/model/1807378-universal-clip-self-tightening',
    'https://www.printables.com/model/1807379-universal-clip-self-tightening',
    'https://makerworld.com/en/models/2093108-dji-neo-2-the-box',
    'https://makerworld.com/en/models/2093109-dji-neo-2-the-box',
    'https://cults3d.com/en/3d-model/various/hyper-hopper',
    'https://cults3d.com/en/3d-model/various/hyper-hopper-2',
    // Two sites cannot collide on a bare id, because the id prefixes the key.
    'https://www.printables.com/model/7401409-something',
  ].map((url) => matchKey(url, MODEL_SITES))
  assert.equal(new Set(distinct).size, distinct.length)
})

test('a non-model page on a known site keys to its path, not to the site', () => {
  for (const [url, expected] of [
    ['https://www.thingiverse.com/marcs/designs', 'thingiverse.com/marcs/designs'],
    ['https://www.printables.com/model', 'printables.com/model'],
    ['https://makerworld.com/en/models', 'makerworld.com/en/models'],
  ] as const) {
    assert.equal(matchKey(url, MODEL_SITES), expected, url)
  }
})

test('URL shapes no measured URL exercises — SYNTHETIC, constructed rather than observed', () => {
  /*
   * Three clauses of the registry rows that the spike's own URLs cannot reach, kept honest by
   * saying so rather than by leaving them untested and unkillable:
   *
   * - **Percent-decoding and lowercasing the Cults3D segment.** The four measured alternates all
   *   end in the ASCII lowercase slug `hyper-hopper`; the percent-encoding the spike observed
   *   (`/fr/mod%C3%A8le-3d/…`, `/zh/3d-m%C3%B3x%C3%ADng/…`) is in the *type* segment, which this
   *   row never reads. So no observed URL distinguishes a decoding row from a non-decoding one.
   *   The URLs below are **constructed** in the shape the observed ones imply — a French model
   *   title with an accent in it — and are not a measurement of anything.
   * - **The digit terminator in `<id>-<slug>`.** Every measured id is followed by `-` or by the
   *   end of the segment. The guard exists so a segment that merely *starts* with digits does not
   *   silently key as a model, which is the aggressive direction this whole rule avoids.
   * - **A trailing slash on a model URL.** Nobody observed one; people paste them.
   */
  const cults3d = MODEL_SITES.find((site) => site.id === 'cults3d')
  const printables = MODEL_SITES.find((site) => site.id === 'printables')
  assert.ok(cults3d && printables)

  assert.equal(
    cults3d.identity(new URL('https://cults3d.com/fr/modele-3d/divers/Porte-Cl%C3%A9')),
    'porte-clé',
  )
  assert.equal(printables.identity(new URL('https://www.printables.com/model/1807378abc')), null)
  assert.equal(
    matchKey('https://cults3d.com/en/3d-model/various/hyper-hopper/', MODEL_SITES),
    'cults3d:hyper-hopper',
  )
})

/* -------------------------------------------------------------------------------------------
 * siteForUrl — attribution, and never permission
 * ---------------------------------------------------------------------------------------- */

/**
 * What `BrowseStateDto.siteId` is built from, and what task 3 attributes a download with.
 *
 * One table, both answers, for the reason the policy suite gives about its own: a lookup that
 * answered `null` for everything would satisfy a suite made only of misses — and `null` is the
 * *common* case here, because nothing stops a user browsing anywhere they like.
 */
test('a URL is attributed to the site that serves it, and to nothing else', () => {
  for (const [url, expected] of [
    ['https://www.thingiverse.com/thing:7401409', 'thingiverse'],
    // Not a model page, and still Thingiverse: this answers who wrote the page, not what it is.
    ['https://www.thingiverse.com/', 'thingiverse'],
    ['https://thingiverse.com/thing:1', 'thingiverse'],
    // The host is lowercased and `www.`-stripped exactly as `matchKey` does it, because a page
    // attributed to Thingiverse and keyed as something else is worse than either alone.
    ['https://WWW.Thingiverse.COM/thing:1', 'thingiverse'],
    ['https://www.printables.com/model/1807378-universal-clip?lang=de', 'printables'],
    ['https://makerworld.com/en/models/2093108-dji-neo-2-the-box', 'makerworld'],
    ['https://cults3d.com/en/3d-model/various/hyper-hopper', 'cults3d'],

    // A subdomain is not the site. `hosts` is an equality list, so a CDN that serves a site's
    // bytes is not the site that published the model.
    ['https://cdn.thingiverse.com/assets/1.stl', null],
    // A port makes a different host, which is the same rule `matchKey` applies when it picks a row.
    ['https://thingiverse.com:8443/thing:1', null],

    ['https://example.com/anything', null],
    ['https://not-thingiverse.com/thing:1', null],
    ['blob:https://www.thingiverse.com/ae5e9664', null],
    ['not a url', null],
    ['', null],
  ] as const) {
    assert.equal(siteForUrl(url)?.id ?? null, expected, url)
  }
})
