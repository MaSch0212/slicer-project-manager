import { beforeEach, describe, expect, it } from 'vitest'
import type { SlicerSessionDto } from '../api/generated'
import { ApiError } from './api/error'
import { setLanguage } from './i18n'
import {
  describeSession,
  sessionFailureMessage,
  sessionRows,
  STALE_SESSION_MS,
  stateKey,
} from './slicer-sessions'

const NOW = 1_756_000_000_000

function session(overrides: Partial<SlicerSessionDto> = {}): SlicerSessionDto {
  return {
    launchId: 'l1',
    projectId: 'p1',
    fileId: 'f1',
    fileName: 'bracket.3mf',
    slicerId: 'orca',
    startedAt: NOW,
    processAlive: false,
    fileState: 'changed',
    isOrphan: false,
    ...overrides,
  }
}

beforeEach(async () => {
  await setLanguage('en')
})

describe('sessionRows', () => {
  it('is stale after thirty days exactly, by the launch and never by the file', () => {
    const [fresh, old] = sessionRows(
      [
        session({ startedAt: NOW - STALE_SESSION_MS }),
        session({ startedAt: NOW - STALE_SESSION_MS - 1 }),
      ],
      null,
      NOW,
    )
    expect(fresh!.stale).toBe(false)
    expect(old!.stale).toBe(true)
  })

  it('narrows to a project plus any orphan, and asks an orphan for a project only off a project', () => {
    const sessions = [
      session({ launchId: 'mine', projectId: 'p1' }),
      session({ launchId: 'theirs', projectId: 'p2' }),
      session({ launchId: 'stray', projectId: '', isOrphan: true }),
    ]
    expect(sessionRows(sessions, 'p1', NOW).map((row) => row.session.launchId)).toEqual([
      'mine',
      'stray',
    ])
    expect(sessionRows(sessions, 'p1', NOW).map((row) => row.needsProject)).toEqual([false, false])
    expect(sessionRows(sessions, null, NOW).map((row) => row.needsProject)).toEqual([
      false,
      false,
      true,
    ])
  })

  it('offers an import only for a file that has settled', () => {
    const rows = sessionRows(
      [
        session({ fileState: 'unchanged' }),
        session({ fileState: 'changed' }),
        session({ fileState: 'settling' }),
        session({ fileState: 'unreadable' }),
      ],
      null,
      NOW,
    )
    expect(rows.map((row) => row.canImport)).toEqual([true, true, false, false])
  })

  it('restates the Cura limit only for a Cura file that has not come back', () => {
    const rows = sessionRows(
      [
        session({ slicerId: 'cura', fileState: 'unchanged' }),
        session({ slicerId: 'cura', fileState: 'changed' }),
        session({ slicerId: 'orca', fileState: 'unchanged' }),
      ],
      null,
      NOW,
    )
    expect(rows.map((row) => row.curaLimit)).toEqual([true, false, false])
  })
})

describe('what the card says', () => {
  it('has a word for every file state', () => {
    expect(
      (['unchanged', 'changed', 'settling', 'unreadable'] as const).map((state) => stateKey(state)),
    ).toEqual([
      'slicerSessions.stateUnchanged',
      'slicerSessions.stateChanged',
      'slicerSessions.stateSettling',
      'slicerSessions.stateUnreadable',
    ])
  })

  it('describes an orphan, a changed lineage and the two sizes, in product names', () => {
    expect(
      describeSession(
        session({
          isOrphan: true,
          sourceSlicer: null,
          returnedAs: 'cura',
          sourceSizeBytes: 1024,
          returnedSizeBytes: 2048,
        }),
      ),
    ).toBe(
      'This came back from a slicer, and nothing beside it says which project it belongs to. ' +
        'It went out as a unknown project and came back as a UltiMaker Cura one. ' +
        '1.0 kB when it went out, 2.0 kB now.',
    )
    expect(describeSession(session({ returnedSizeBytes: 512 }))).toBe('512 B')
    expect(describeSession(session())).toBe('')
  })

  it('tells the two Conflicts apart by what the shell attached, and a quota by its numbers', () => {
    expect(
      sessionFailureMessage(new ApiError('Conflict', 'x', { details: { fileState: 'settling' } })),
    ).toContain('still being written')
    expect(sessionFailureMessage(new ApiError('Conflict', 'x'))).toContain('different library')
    expect(
      sessionFailureMessage(
        new ApiError('QuotaExceeded', 'x', {
          details: { usageBytes: 1024, quotaBytes: 2048, incomingBytes: 1 },
        }),
      ),
    ).toContain('2.0 kB')
    expect(sessionFailureMessage(new ApiError('QuotaExceeded', 'x'))).toBe(
      'That did not work. Nothing was added or removed.',
    )
    expect(sessionFailureMessage(new Error('boom'))).toBe(
      'That did not work. Nothing was added or removed.',
    )
  })
})
