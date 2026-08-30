import { z } from 'zod'

export const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'letters, digits, dot, dash and underscore only')

export const passwordSchema = z.string().min(10).max(200)

export const displayNameSchema = z.string().min(1).max(100)

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export const activateSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    message: 'passwords do not match',
    path: ['confirm'],
  })

export const changePasswordSchema = z.object({
  current: z.string().min(1),
  next: passwordSchema,
})

export const profilePatchSchema = z.object({ displayName: displayNameSchema.optional() })

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  isAdmin: z.boolean().default(false),
  quotaBytes: z.number().int().positive().nullable().default(null),
})

export const updateUserSchema = z.object({
  isAdmin: z.boolean().optional(),
  isDisabled: z.boolean().optional(),
  quotaBytes: z.number().int().positive().nullable().optional(),
})

export const tagNameSchema = z.string().trim().min(1).max(60)

export const tagBodySchema = z.object({ name: tagNameSchema })

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  website: z.url().nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  tags: z.array(tagNameSchema).optional(),
})

export const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  website: z.url().nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  isArchived: z.boolean().optional(),
})

// Rejects path separators, the Windows-reserved character set, traversal, and Windows-reserved
// device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), case-insensitively and with any extension.
export const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  // Spaces are legal in a file name; path separators and the Windows-reserved set are not.
  .regex(/^[^"*/:<>?\\|]+$/, 'invalid characters in file name')
  .refine((v) => !v.includes(String.fromCharCode(0)), 'file name must not contain a null byte')
  .refine(
    (v) => v !== '.' && v !== '..' && !v.startsWith('.'),
    'file name must not start with a dot',
  )
  .refine(
    (v) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(v),
    'file name must not be a Windows-reserved device name',
  )

export const fileRenameSchema = z.object({ name: fileNameSchema })

/** The parsed URL, or null where `new URL` throws. Used by `serverUrlSchema` below. */
function parseUrlOrNull(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * The address of a Slicer Project Manager server, as typed by the user before a shell is asked
 * to point a window at it (spec G 6.1).
 *
 * The scheme check is the entire reason this exists. `z.url()` on its own is not it: it accepts
 * every absolute URL the WHATWG parser accepts, `javascript:alert(1)` included. Something that
 * is about to become the origin of a window must be `http:` or `https:` and nothing else, so the
 * scheme is checked here rather than assumed from the shape of the string.
 *
 * Embedded credentials are refused for a different reason, and it is a decision rather than a
 * side effect of the scheme check: `https://user:pass@example.invalid/` is a perfectly valid
 * URL. A library server is an origin this app stores and reconnects to, so a password in it
 * would be persisted as part of that origin; the userinfo field is also the oldest trick there
 * is for making one host look like another; and this app has a real sign-in for saying who you
 * are. There is nothing an address of this shape can do here that the account cannot.
 *
 * **An origin and nothing else, because that is what the shell accepts.** The main process's
 * `parseRemoteOrigin` (`packages/desktop/src/remote.ts`) also refuses a query string, a fragment
 * and any path beyond `/`, and it does so at its first statement — before the dedup check, before
 * the native confirmation dialog and before any `fetch`. A schema that checked only the scheme and
 * the credentials therefore let `https://print.example.com/spm` — a pasted deep link, the
 * realistic case — through the form, into `library.connect`, and back out as a failure the user
 * could only read as a network problem. The form has to refuse exactly what the shell refuses, or
 * it is not telling the user anything the shell will not have to tell them worse.
 *
 * The two now answer identically over every address `packages/desktop/test/remote.test.ts` puts
 * to both of them, surrounding whitespace included — which was the one place they were expected
 * to differ and do not, because the WHATWG parser strips leading and trailing spaces before it
 * parses and both sides go through it. Measured there rather than asserted here.
 *
 * `new URL` rather than a `startsWith` test on purpose: a prefix test answers a question about
 * the characters, and all of these need an answer about what the parser resolves. The `try` is
 * not dead — `z.url()` runs first and rejects most non-URLs, but a schema is a value other code
 * composes with, and a refinement that throws instead of returning false would turn a validation
 * failure into an exception at whatever call site did the composing.
 *
 * The checks are separate refinements so that each failure says which one it was. All the
 * messages are English, like every other message in this file; the one place a user reads a
 * refusal of this schema — the connect form in settings — renders its own translated string
 * rather than these (spec G C4).
 */
export const serverUrlSchema = z
  .url()
  .refine((value) => {
    const protocol = parseUrlOrNull(value)?.protocol
    return protocol === 'http:' || protocol === 'https:'
  }, 'the address must start with http:// or https://')
  .refine((value) => {
    const parsed = parseUrlOrNull(value)
    return parsed !== null && parsed.username === '' && parsed.password === ''
  }, 'the address must not carry a user name or a password')
  .refine((value) => {
    const parsed = parseUrlOrNull(value)
    return parsed !== null && parsed.search === '' && parsed.hash === ''
  }, 'the address must not carry a query string or a fragment')
  .refine((value) => {
    // `''` as well as `'/'`: the WHATWG parser leaves the pathname empty for a non-special
    // scheme, and this refinement runs whatever the scheme check above decided.
    const parsed = parseUrlOrNull(value)
    return parsed !== null && (parsed.pathname === '' || parsed.pathname === '/')
  }, 'the address must name a server, not a path on it')

export const settingsPatchSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  language: z.enum(['en', 'de']).optional(),
  viewMode: z.enum(['grid', 'list']).optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  navCollapsed: z.boolean().optional(),
})

export const projectQuerySchema = z.object({
  search: z.string().max(200).optional(),
  tags: z.array(tagNameSchema).optional(),
  includeArchived: z.boolean().optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
})

export type LoginInput = z.infer<typeof loginSchema>
export type CreateUserInput = z.infer<typeof createUserSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>
export type CreateProjectInput = z.infer<typeof createProjectSchema>
export type ProjectPatchInput = z.infer<typeof projectPatchSchema>
export type SettingsPatchInput = z.infer<typeof settingsPatchSchema>
