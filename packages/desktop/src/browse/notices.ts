import type { BrowseNoticeDto } from '@spm/contract/dtos.ts'

/**
 * What the app has to say about downloads that happened while nobody was watching (E plan
 * decision 7, spec 5.2 and 4.3).
 *
 * **Two events need it, and both are silent without it.**
 *
 * 1. **A refusal.** `preventDefault()` destroys the `DownloadItem` by the next tick, and nothing
 *    at all is delivered to the page — no error event, no failed download entry, no DOM change.
 *    From the site's point of view the click did nothing, which is indistinguishable from a
 *    consent overlay eating it. Silence here trains a user to believe the feature is broken, so
 *    the shell says which download was refused and which cap it hit.
 * 2. **A download that finished while no view was attached.** Nothing polls `browse.downloads()`
 *    once `/browse` is torn down, so a completed download would simply be sitting there the next
 *    time the user happened to look.
 *
 * **The notification is the promptness and the list is the record.** An operating system that
 * suppresses notifications — Focus Assist, a denied permission, a headless CI box — costs the user
 * nothing they cannot get back, because `browse.notices()` and `browse.downloads()` both still
 * answer. That is the same shape D gave its watch-versus-poll rule: the prompt thing is an
 * optimisation over the thing of record, never the mechanism.
 *
 * **In memory, for the life of the process, and deliberately not on disk.** A notice is an
 * interruption about something that just happened; the durable half of the same event is
 * `download.json`, which the sweep reads at the next start and which is what makes a staged
 * download outlive this list. A second file would be a second thing to keep consistent with the
 * first for no answer it could give that `downloads()` cannot.
 *
 * **`notify` is required, not defaulted.** A no-op default would make the notification
 * unobservable in a test and would let a future wiring mistake put the app back in exactly the
 * silence this module exists to end. `app.ts` is the only place that constructs an Electron
 * `Notification`; nothing here imports `electron`, so `test/browse-notices.test.ts` drives every
 * branch under plain `node --test`.
 *
 * **The text is English, and that is a choice rather than an oversight.** The shell's native
 * *dialogs* speak the two languages `PickerLanguage` names, because a dialog is a question. These
 * strings are of the same family as `BrowseStateDto.lastError` — a sentence this process writes
 * about a stranger's file, rendered in the app's own chrome — and that one is English too. Spec
 * 9.15 stays open on the app's general notification surface; this is E's local answer, scoped to
 * browsing, and localising it is a change to make with that question rather than ahead of it.
 */

/** `refused` is a cap the download hit; `completed` is a finished download nobody was watching. */
export type BrowseNoticeKind = 'refused' | 'completed'

export type BrowseNotice = {
  id: string
  kind: BrowseNoticeKind
  /** The staged basename. **A remote server chose it** — see {@link MAX_NOTICE_TEXT}. */
  fileName: string
  /** One sentence naming what happened. For a refusal, which cap and what it was measured against. */
  detail: string
  at: number
}

/**
 * The longest `fileName` or `detail` a notice will carry.
 *
 * **A judgement, and here because the length is a stranger's to choose.** `fileName` comes from a
 * remote server's `getFilename()`, and the string ends up in the app's own chrome and in an OS
 * notification. `BrowseNoticeDto` mandates truncation at render, exactly as `BrowseStateDto` does;
 * this is the value carrying its own bound as well, in the one place it is minted — the same rule
 * `describeRefusal` follows in `host.ts` and for the same reason. 200 is far above any filename
 * worth reading (`fileNameSchema` itself stops at 255) and far below anything that would re-lay-out
 * a notification or a card.
 */
export const MAX_NOTICE_TEXT = 200

/**
 * How many notices are kept.
 *
 * **A judgement.** Nothing measured bears on it. What it bounds is a page that starts downloads in
 * a loop: every refusal appends, so an unbounded list is a slow memory leak with a hostile site
 * holding the other end. The oldest go first, so the notice the user is being interrupted about
 * right now is always in the list they open.
 */
export const MAX_NOTICES = 50

export type BrowseNoticesOptions = {
  /**
   * Raises the notification. **Required** — see the module docblock.
   *
   * `app.ts` implements it with Electron's `Notification`, which is the only place one is
   * constructed. It is handed the notice that was just appended, so the two cannot disagree about
   * what happened.
   */
  notify(notice: BrowseNotice): void
  now?(): number
  mintId?(): string
}

export class BrowseNotices {
  readonly #notify: (notice: BrowseNotice) => void
  readonly #now: () => number
  readonly #mintId: () => string
  readonly #notices: BrowseNotice[] = []

  constructor(options: BrowseNoticesOptions) {
    this.#notify = options.notify
    this.#now = options.now ?? Date.now
    this.#mintId = options.mintId ?? (() => crypto.randomUUID())
  }

  /**
   * Appends one and raises the notification for it, in that order.
   *
   * The order is not decorative: `notify` reaches an operating system, and an exception from it
   * must not be able to cost the app the record of what happened. The record is complete before
   * anything outside this process is asked to do anything.
   */
  add(kind: BrowseNoticeKind, fileName: string, detail: string): BrowseNotice {
    const notice: BrowseNotice = {
      id: this.#mintId(),
      kind,
      fileName: fileName.slice(0, MAX_NOTICE_TEXT),
      detail: detail.slice(0, MAX_NOTICE_TEXT),
      at: this.#now(),
    }
    this.#notices.push(notice)
    if (this.#notices.length > MAX_NOTICES)
      this.#notices.splice(0, this.#notices.length - MAX_NOTICES)
    this.#notify(notice)
    return notice
  }

  /** Oldest first. A copy, so a caller cannot edit the record by editing what it was handed. */
  list(): BrowseNoticeDto[] {
    return this.#notices.map((notice) => ({ ...notice }))
  }

  /**
   * Forgets one. An id that is not there is a success.
   *
   * The renderer polls this list, so "dismiss the card I am looking at" races every other reason a
   * notice could already be gone — a second window, a double click, the bound above. None of those
   * is something to put an error in front of a user for.
   */
  dismiss(id: string): void {
    const index = this.#notices.findIndex((notice) => notice.id === id)
    if (index >= 0) this.#notices.splice(index, 1)
  }
}
