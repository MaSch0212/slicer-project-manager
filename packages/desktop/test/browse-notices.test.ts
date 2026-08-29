import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BrowseNotices,
  MAX_NOTICE_TEXT,
  MAX_NOTICES,
  type BrowseNotice,
} from '../src/browse/notices.ts'

/**
 * The out-of-band record of what happened while nobody was looking (E plan decision 7).
 *
 * The `notify` seam is **required**, not defaulted, and this file is where that shows: a default
 * no-op would make "the notification was raised" unobservable, and the whole reason this list
 * exists is that `preventDefault()` delivers nothing to the page. What `notify` receives is
 * asserted here; the Electron `Notification` it becomes is `app.ts`'s and is constructed nowhere
 * else.
 */

type Rig = { notices: BrowseNotices; notified: BrowseNotice[]; clock: { at: number } }

function rig(): Rig {
  const notified: BrowseNotice[] = []
  const clock = { at: 1_000 }
  let seq = 0
  const notices = new BrowseNotices({
    notify: (notice) => notified.push(notice),
    now: () => clock.at,
    mintId: () => `n${(seq += 1)}`,
  })
  return { notices, notified, clock }
}

test('a notice is appended and the notification is raised for it', () => {
  const { notices, notified, clock } = rig()
  clock.at = 4242

  const added = notices.add('refused', 'benchy.zip', 'over the 2 GiB limit for one download')

  assert.deepEqual(notices.list(), [
    {
      id: 'n1',
      kind: 'refused',
      fileName: 'benchy.zip',
      detail: 'over the 2 GiB limit for one download',
      at: 4242,
    },
  ])
  // The same object the list holds reached `notify` — not a second one built from it, and not
  // nothing. Without this the "and raises a native Notification" half of decision 7 is a sentence
  // in a docblock with no code behind it.
  assert.deepEqual(notified, [added])
})

test('dismiss removes exactly the one named, and an unknown id is not an error', () => {
  const { notices } = rig()
  notices.add('refused', 'a.zip', 'first')
  notices.add('completed', 'b.zip', 'second')
  notices.add('refused', 'c.zip', 'third')

  notices.dismiss('n2')

  assert.deepEqual(
    notices.list().map((notice) => notice.fileName),
    ['a.zip', 'c.zip'],
  )
  // A user dismissing the same card twice, and a list the renderer polled a moment before another
  // dismiss landed. Neither is a failure of anything.
  notices.dismiss('n2')
  notices.dismiss('no-such-notice')
  assert.equal(notices.list().length, 2)
})

test('the list is a copy: mutating what a caller was handed does not change the record', () => {
  const { notices } = rig()
  notices.add('refused', 'a.zip', 'first')

  const handed = notices.list()
  handed.length = 0

  assert.equal(notices.list().length, 1)
})

test('site-authored text is truncated on the way in, not left to whoever renders it', () => {
  const { notices, notified } = rig()
  // A remote server chooses `getFilename()`, so the length of both of these is a stranger's. The
  // DTO mandates truncation at render; this is the value carrying its own bound as well, in the
  // one place it is minted — the same rule `describeRefusal` follows in `browse/host.ts`.
  const added = notices.add('completed', 'z'.repeat(9_000), 'd'.repeat(9_000))

  assert.equal(added.fileName.length, MAX_NOTICE_TEXT)
  assert.equal(added.detail.length, MAX_NOTICE_TEXT)
  assert.equal(notified[0]?.fileName.length, MAX_NOTICE_TEXT)
})

test('the list is bounded, and it is the oldest that goes', () => {
  const { notices } = rig()
  for (let index = 0; index < MAX_NOTICES + 5; index += 1) {
    notices.add('completed', `f${index}.zip`, 'done')
  }

  const list = notices.list()
  assert.equal(list.length, MAX_NOTICES)
  // The five that went are the first five, so the newest — which is the one the user is being
  // told about right now — is always present.
  assert.equal(list[0]?.fileName, 'f5.zip')
  assert.equal(list[list.length - 1]?.fileName, `f${MAX_NOTICES + 4}.zip`)
})
