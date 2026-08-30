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

/**
 * The address of a Slicer Project Manager server, as typed by the user before a shell is asked
 * to point a window at it (spec G 6.1).
 *
 * The scheme check is the entire reason this exists. `z.url()` on its own is not it: it accepts
 * every absolute URL the WHATWG parser accepts, `javascript:alert(1)` included. Something that
 * is about to become the origin of a window must be `http:` or `https:` and nothing else, so the
 * scheme is checked here rather than assumed from the shape of the string.
 *
 * `new URL` rather than a `startsWith` test on purpose: a prefix test answers a question about
 * the characters, and this needs an answer about the scheme the same parser will resolve. The
 * `try` is not dead — `z.url()` runs first and rejects most non-URLs, but a schema is a value
 * other code composes with, and a refinement that throws instead of returning false would turn
 * a validation failure into an exception at whatever call site did the composing.
 */
export const serverUrlSchema = z.url().refine((value) => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}, 'the address must start with http:// or https://')

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
