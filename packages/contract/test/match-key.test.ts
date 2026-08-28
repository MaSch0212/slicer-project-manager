import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchKey, type ModelSiteIdentity } from '../src/match-key.ts'

/**
 * `matchKey`'s own clauses — normalisation, the identity hand-off, and the fallback — against a
 * **probe** site rather than a copy of the real registry.
 *
 * The probe is deliberately not a re-implementation of anything: its `identity` recognises exactly
 * one pathname and records the URL object it was handed, so the tests below can assert what
 * `matchKey` promises implementations rather than what Thingiverse's URLs look like. The
 * exhaustive fixtures over the spike's real URLs run against the **real** four-row registry in
 * `packages/desktop/test/browse.test.ts`, where the registry lives; a second hand-written copy of
 * those rules here would be a test double standing in for the code it is meant to check.
 */

/** Every URL the probe's `identity` was handed, in order, so the hand-off itself is observable. */
const seen: URL[] = []

const probe: ModelSiteIdentity = {
  id: 'probe',
  hosts: ['probe.example'],
  identity(url) {
    seen.push(new URL(url.href))
    return url.pathname === '/model' ? 'the-one' : null
  },
}

test('matchKey strips a leading www. before matching a row', () => {
  assert.equal(matchKey('https://WWW.Probe.Example/model', [probe]), 'probe:the-one')
  assert.equal(matchKey('https://probe.example/model', [probe]), 'probe:the-one')
})

test('the host is lowercased even where WHATWG has not already done it', () => {
  /*
   * Written this way because the obvious version of it cannot fail. `new URL()` lowercases the
   * host itself for a **special** scheme — `new URL('https://WWW.Probe.EXAMPLE/x').host` is
   * already `www.probe.example` — so a mixed-case `https:` fixture asserts the URL parser's
   * behaviour and says nothing about this function: deleting `.toLowerCase()` here leaves every
   * `http(s)` fixture in this file and in `packages/desktop/test/browse.test.ts` green. That was
   * measured, by deleting it.
   *
   * A **non-special** scheme is the only shape that reaches the clause: `new URL('spm://APP/x').host`
   * is `APP`, case intact. `matchKey` is only ever called on `http(s)` in this app, so this is a
   * defensive clause with no live caller — kept because `projects.website` is `z.url()` and a
   * user can paste a custom-scheme URL into it, and covered here so that it is at least killable.
   */
  assert.equal(new URL('custom://MiXeD/Path').host, 'MiXeD')
  assert.equal(matchKey('custom://MiXeD/Path', []), 'mixed/path')
})

test('identity() never sees a query or a fragment, and sees the normalised host', () => {
  seen.length = 0
  assert.equal(
    matchKey('https://WWW.Probe.Example/model?lang=de&from=recommend#profileId-9', [probe]),
    'probe:the-one',
  )
  // The clause is enforced here, at the hand-off, rather than left to each row to remember:
  // Printables puts the locale in `?lang=de` and MakerWorld appends `?from=recommend` and a
  // `#profileId-<n>` fragment at runtime. Delete `parsed.search = ''` and this goes red.
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.search, '')
  assert.equal(seen[0]?.hash, '')
  assert.equal(seen[0]?.host, 'probe.example')
  assert.equal(seen[0]?.pathname, '/model')
})

test('a row is only offered URLs on one of its own hosts, exactly', () => {
  seen.length = 0
  // A subdomain is not the site: `cdn.thingiverse.com` must not key as Thingiverse.
  assert.equal(matchKey('https://cdn.probe.example/model', [probe]), 'cdn.probe.example/model')
  assert.equal(matchKey('https://other.example/model', [probe]), 'other.example/model')
  assert.equal(seen.length, 0)
})

test('a matched host whose identity is null falls back rather than keying to the site', () => {
  // A home page or a listing is not a model, and must not collapse to `probe:` or to the site id.
  assert.equal(matchKey('https://probe.example/', [probe]), 'probe.example')
  assert.equal(matchKey('https://probe.example/not-a-model', [probe]), 'probe.example/not-a-model')
})

test('the fallback is lowercased host + pathname with the trailing slash removed', () => {
  assert.equal(matchKey('https://example.com/some/path/', []), 'example.com/some/path')
  assert.equal(matchKey('https://example.com/some/path', []), 'example.com/some/path')
  assert.equal(matchKey('https://EXAMPLE.com/Some/Path/', []), 'example.com/some/path')
  assert.equal(matchKey('https://www.example.com/some/path', []), 'example.com/some/path')
  assert.equal(matchKey('https://example.com/', []), 'example.com')
  assert.equal(matchKey('https://example.com', []), 'example.com')
  // The query and fragment go for an unrecognised host too, which is where that clause does the
  // work the four measured rows do not need it for.
  assert.equal(matchKey('https://example.com/some/path/?lang=de#frag', []), 'example.com/some/path')
})

test('the fallback keeps the port, so two servers on one hostname stay two keys', () => {
  assert.equal(matchKey('http://localhost:8080/x', []), 'localhost:8080/x')
  assert.notEqual(matchKey('http://localhost:8080/x', []), matchKey('http://localhost:9000/x', []))
})

test('http and https on the same path are one key — the scheme is not part of the identity', () => {
  assert.equal(matchKey('http://example.com/a', []), matchKey('https://example.com/a', []))
})

test('an unparseable string is its own key, and two different ones are two keys', () => {
  // Never `null`: two unrelated failures sharing one key is the silent wrong match this function
  // exists to avoid, and `null === null` in a caller comparing two keys is exactly that.
  assert.equal(matchKey('not a url', [probe]), 'not a url')
  assert.equal(matchKey('  NOT A URL  ', [probe]), 'not a url')
  assert.notEqual(matchKey('not a url', []), matchKey('also not a url', []))
})
