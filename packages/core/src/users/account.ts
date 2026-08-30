import { DEFAULT_SETTINGS, type SettingsDto, type UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import type { Library } from '../db/open.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import { requireUserRow, toUserDto } from './repo.ts'
import { diskUsageBytes } from './usage.ts'

export function me(lib: Library, ctx: Ctx): UserDto {
  return toUserDto(requireUserRow(lib.db, ctx.userId), diskUsageBytes(lib.db, ctx.userId))
}

export async function changePassword(
  lib: Library,
  ctx: Ctx,
  current: string,
  next: string,
): Promise<void> {
  const row = requireUserRow(lib.db, ctx.userId)
  if (!row.pw_hash || !row.pw_salt || !row.pw_iterations) {
    throw new AppError('Forbidden', 'account has no password to change')
  }
  const ok = await verifyPassword(current, {
    hash: row.pw_hash,
    salt: row.pw_salt,
    iterations: row.pw_iterations,
    algo: row.pw_algo ?? '',
  })
  if (!ok) throw new AppError('Unauthorized', 'current password is not correct')

  const pw = await hashPassword(next)
  lib.db
    .prepare(
      'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ? WHERE id = ?',
    )
    .run(pw.hash, pw.salt, pw.iterations, pw.algo, ctx.userId)
}

export function updateProfile(lib: Library, ctx: Ctx, patch: { displayName?: string }): UserDto {
  if (patch.displayName !== undefined) {
    lib.db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run(patch.displayName, ctx.userId)
  }
  return me(lib, ctx)
}

/**
 * How one `SettingsDto` key's typed value is turned into (and recovered from) the single
 * string that `user_settings.value` stores. `decode` returns `undefined` for any raw value
 * this key does not currently accept — not only malformed input, but anything a codec has
 * stopped recognising (e.g. an enum member a since-removed option used to write) — so
 * `getSettings` lets the default stand rather than passing a stale or foreign value through
 * to the DTO.
 */
export type SettingCodec<T> = {
  encode(value: T): string
  decode(raw: string): T | undefined
}

/**
 * Accepts only a raw value that is one of `values`, verbatim. This is what every enum-shaped
 * key (theme, language, viewMode, sort, dir) uses. Before this codec existed, `getSettings`
 * copied a `user_settings` row into the DTO with no check at all, so a row of `theme = 'purple'`
 * (written by a build that once offered a "purple" theme, or by hand) was shipped to the
 * renderer verbatim; under this codec it decodes to `undefined` and `DEFAULT_SETTINGS.theme`
 * stands instead (spec 3.2).
 */
function enumCodec<T extends string>(values: readonly T[]): SettingCodec<T> {
  return {
    encode: (value) => value,
    decode: (raw) => (values.includes(raw as T) ? (raw as T) : undefined),
  }
}

/** Stores `true`/`false` as `'1'`/`'0'`; any other raw value decodes to `undefined`. */
const booleanCodec: SettingCodec<boolean> = {
  encode: (value) => (value ? '1' : '0'),
  decode: (raw) => (raw === '1' ? true : raw === '0' ? false : undefined),
}

/**
 * The minimal shape `jsonCodec` needs from a validator. Deliberately not the real `zod` type:
 * this file's own lint rule keeps `packages/core` free of npm imports other than
 * `occt-import-js`, so it runs unmodified on both Deno and Node without a bundler standing in
 * for either runtime's module resolution. A real `z.ZodType<T>` (from `@spm/contract/schemas.ts`
 * or built ad hoc by a caller) satisfies this structurally, `safeParse` and all, so nothing is
 * lost by naming only the part `jsonCodec` actually calls.
 */
type Validator<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

/**
 * Stores any value `schema` accepts as JSON text. Decode returns `undefined` for either
 * malformed JSON or JSON that parses but fails `schema`, the same "reject, don't corrupt"
 * guarantee `enumCodec` and `booleanCodec` give their keys. No key in this subsystem uses this
 * codec yet — segments H and I need list-valued settings (a remembered tag filter, browser
 * shortcuts) and will each wire it to a key of their own. It is specified and unit-tested here,
 * against nothing but its own encode/decode, so neither segment has to invent it.
 */
export function jsonCodec<T>(schema: Validator<T>): SettingCodec<T> {
  return {
    encode: (value) => JSON.stringify(value),
    decode: (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return undefined
      }
      const result = schema.safeParse(parsed)
      return result.success ? result.data : undefined
    },
  }
}

/**
 * One codec per `SettingsDto` key, typed so that handing a key the wrong codec (e.g.
 * `enumCodec` for `navCollapsed`) fails to compile. `getSettings`/`putSettings` iterate this
 * table instead of a bare key list, so adding a setting means adding one line here rather than
 * remembering to touch both functions and whatever was meant to validate it.
 */
const SETTING_CODECS: { [K in keyof SettingsDto]: SettingCodec<SettingsDto[K]> } = {
  theme: enumCodec(['light', 'dark', 'system']),
  language: enumCodec(['en', 'de']),
  viewMode: enumCodec(['grid', 'list']),
  sort: enumCodec(['name', 'createdAt', 'updatedAt']),
  dir: enumCodec(['asc', 'desc']),
  navCollapsed: booleanCodec,
}

const SETTING_KEYS = Object.keys(SETTING_CODECS) as (keyof SettingsDto)[]

export function getSettings(lib: Library, ctx: Ctx): SettingsDto {
  const rows = lib.db
    .prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
    .all(ctx.userId) as { key: string; value: string | null }[]

  const stored: Record<string, string> = {}
  for (const row of rows) if (row.value !== null) stored[row.key] = row.value
  // Unknown or stale keys, and rows whose codec no longer accepts them, fall back to the
  // default rather than corrupting the DTO.
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const key of SETTING_KEYS) {
    const raw = stored[key]
    if (raw === undefined) continue
    // TypeScript cannot track, across a loop over the union `keyof SettingsDto`, that this
    // particular codec is the one that was typed against this particular key's value type —
    // a known limitation of correlated unions (settings.page.ts's `onPatch` hits the same
    // wall on the web side). The pairing is correct by construction: both `raw` and `codec`
    // are read from the same `key`, and `SETTING_CODECS`'s own declared type is what actually
    // catches a codec assigned to the wrong key.
    const codec = SETTING_CODECS[key] as SettingCodec<unknown>
    const decoded = codec.decode(raw)
    if (decoded !== undefined) merged[key] = decoded
  }
  return merged as SettingsDto
}

export function putSettings(lib: Library, ctx: Ctx, patch: Partial<SettingsDto>): SettingsDto {
  const upsert = lib.db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  )
  for (const key of SETTING_KEYS) {
    const value = patch[key]
    if (value === undefined) continue
    // Same correlated-union limitation as the cast in getSettings above.
    const codec = SETTING_CODECS[key] as SettingCodec<unknown>
    upsert.run(ctx.userId, key, codec.encode(value))
  }
  return getSettings(lib, ctx)
}
