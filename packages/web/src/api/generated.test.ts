import { describe, expect, test } from 'vitest'
import {
  APP_ERROR_CODES,
  DEFAULT_SETTINGS,
  isAppErrorCode,
  type ProjectDetailDto,
  type SettingsDto,
} from './generated'

// The generated TypeScript is produced from the Rust contract and checked in; the Rust test
// `generated_typescript_is_up_to_date` guards that it is current. These pin that the web package
// can actually consume it: the constants carry the values, and the types compile against them.
describe('generated contract', () => {
  test('the shipped settings defaults are the legacy ones', () => {
    const settings: SettingsDto = DEFAULT_SETTINGS
    expect(settings).toEqual({
      theme: 'system',
      language: 'en',
      viewMode: 'grid',
      sort: 'updatedAt',
      dir: 'desc',
      navCollapsed: false,
      includeArchived: false,
      filterTags: [],
    })
  })

  test('error codes are the i18n keys and are recognised exactly', () => {
    expect(APP_ERROR_CODES).toHaveLength(12)
    expect(isAppErrorCode('LastActiveAdmin')).toBe(true)
    expect(isAppErrorCode('lastactiveadmin')).toBe(false)
    expect(isAppErrorCode(42)).toBe(false)
  })

  test('a project detail is a project with files', () => {
    const detail: ProjectDetailDto = {
      id: 'p',
      name: 'Benchy',
      isArchived: false,
      state: 'ok',
      tags: [],
      fileCounts: { model: 0, slicerProject: 0, other: 0 },
      createdAt: 1,
      updatedAt: 2,
      files: [],
    }
    expect(detail.files).toEqual([])
  })
})
