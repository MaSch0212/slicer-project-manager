import { createReadStream, realpathSync, statSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import type { ApiClient } from '@spm/contract/api-client.ts'
import { createDecorators } from '@spm/contract/decorate.ts'
import type { Capabilities, LocalLibraryDto, RemoteLibraryDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import {
  changePasswordSchema,
  createProjectSchema,
  createUserSchema,
  fileNameSchema,
  loginSchema,
  passwordSchema,
  profilePatchSchema,
  projectPatchSchema,
  projectQuerySchema,
  settingsPatchSchema,
  tagNameSchema,
  updateUserSchema,
} from '@spm/contract/schemas.ts'
import {
  addTag,
  changePassword,
  checkActivationToken,
  createProject,
  createUser,
  deleteFile,
  deleteProject,
  deleteUser,
  getProject,
  getSettings,
  importCuraManagerZip,
  listProjects,
  listUsers,
  me,
  putSettings,
  reissueInvite,
  removeTag,
  renameFile,
  rescan,
  SPM_DIR,
  updateProfile,
  updateProject,
  updateUser,
  uploadFile,
  type Ctx,
  type Library,
} from '@spm/core'
import type { WireUploadBody } from './protocol.ts'
import { ACTIVATION_URL_BASE, FILE_URL_BASE } from './urls.ts'

/**
 * The whole of `ApiClient`, mapped onto `@spm/core`.
 *
 * This module imports nothing from `electron` — a requirement, not an accident. It is the thing
 * that has to be covered exhaustively, because a missing entry is a runtime failure in a shell
 * no other suite exercises, and `test/dispatch.test.ts` runs it under plain `node --test` against
 * a real temporary library. `ipc.ts` is the only file that knows the table is reached over IPC.
 *
 * The reference implementation is `packages/server/src/routes/*.ts`: every entry below calls the
 * same core function with the same arguments in the same order, and decorates the result the same
 * way. Where an entry does something the server does not, the comment says why.
 */

/** A library that is open, migrated, and has its single local user (spec 2.6). */
export type DispatchSession = { lib: Library; ctx: Ctx }

/**
 * The part of the shell a dispatch entry may reach that is not a library.
 *
 * One method so far, and it is the reason this type exists at all: `library.pick` has to open a
 * native dialog and swap the library the whole process is serving, neither of which belongs in a
 * module that must stay importable without `electron`. `app.ts` implements it over `LibraryHost`,
 * `test/dispatch.test.ts` implements it with a function that answers a fixed folder, and this
 * file goes on knowing nothing about either.
 */
export type ShellApi = {
  /** Asks the user for a library folder and opens it. Null when they cancelled. */
  pickLibraryFolder(): Promise<LocalLibraryDto | null>
  /** Points the shell at a remote server. The URL is untrusted; the shell validates it. */
  connectRemote(url: string): RemoteLibraryDto
  /**
   * Spec 2.4, for whatever the shell is talking to right now.
   *
   * A function on the shell rather than the constant this used to be, because the answer is no
   * longer a property of the *package*: in remote mode it is the union of the shell's column and
   * the server's own, which means a request. `ShellHost.capabilities` is the one implementation
   * and `capabilities.ts` is the one place the union is computed.
   */
  capabilities(): Promise<Capabilities>
}

/**
 * Everything an entry is handed: the library that is open *right now*, and the shell itself.
 *
 * The session is resolved per call rather than captured (ruling C-12), which is what lets task 4
 * swap the folder without re-registering the IPC handler. It is nullable because `capabilities`
 * and `library.pick` both have to work before any folder is open — with no library there is no
 * way for the user to choose one, and no way for the renderer to find out that it may.
 */
export type DispatchDeps = { session: DispatchSession | null; shell: ShellApi }

/**
 * The shell's local column, re-exported.
 *
 * It moved to `capabilities.ts` in task 5, with a second column beside it for remote mode and the
 * union that combines a column with a backend's. It is re-exported here because this is where
 * tasks 2-4 put it and where their tests import it from — and because this table's `capabilities`
 * entry no longer names it at all: the answer now depends on what the shell is talking to.
 */
export { LOCAL_SHELL_CAPABILITIES as DESKTOP_CAPABILITIES } from './capabilities.ts'

const { decorateFile, decorateProject, decorateProjectDetail } = createDecorators(FILE_URL_BASE)

/* -------------------------------------------------------------------------------------------
 * The path type — why the key set is a compile error and not only a test
 * ---------------------------------------------------------------------------------------- */

/**
 * Every dotted route of `ApiClient`: `'capabilities' | 'auth.login' | … | 'files.delete'`.
 *
 * `DispatchTable` below is a mapped type over this union, so a method added to `ApiClient` and
 * not implemented here fails `deno task typecheck`, and a key here that `ApiClient` does not have
 * fails it too. A wrong *result* type fails too, since each entry is `Dispatched<ResultAt<P>>`.
 *
 * What it does **not** cover, and must not be trusted with: the argument tuple. `Dispatched`
 * takes `args: unknown[]`, so swapping two elements of a `z.tuple` (and the callback parameters
 * with them) typechecks clean. That is `test/dispatch.test.ts`'s job — it calls every route
 * through a real `IpcApiClient`, and the path strings in that client are likewise invisible to
 * the compiler.
 */
type MethodPaths<T> = {
  [K in keyof T & string]: T[K] extends (...args: never[]) => unknown
    ? K
    : T[K] extends object
      ? `${K}.${MethodPaths<T[K]>}`
      : never
}[keyof T & string]

export type ApiPath = MethodPaths<ApiClient>

type ValueAt<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? ValueAt<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never

/** What `ApiClient` promises at `P`, unwrapped. Each entry is typed to produce exactly this. */
type ResultAt<P extends ApiPath> =
  ValueAt<ApiClient, P> extends (...args: never[]) => infer R ? Awaited<R> : never

/**
 * `deps.session` is nullable at this signature because `capabilities` must be answerable before
 * any folder is open — it has to be, or the renderer could never get far enough to ask for one —
 * and because `library.pick` is how it gets one. Both are built with `shellCall`; every other
 * entry is built with `libraryCall`, which refuses a null session rather than dereferencing it.
 */
type Dispatched<R> = (deps: DispatchDeps, args: unknown[]) => Promise<R>

export type DispatchTable = { readonly [P in ApiPath]: Dispatched<ResultAt<P>> }

/* -------------------------------------------------------------------------------------------
 * Argument validation
 * ---------------------------------------------------------------------------------------- */

/**
 * Constraint 4: the renderer is the untrusted side of this boundary. Every entry parses its
 * argument list before core sees it, with `@spm/contract`'s own schemas wherever one exists —
 * the same objects the server's `parseJson` uses, so a malformed input is rejected with the same
 * `code` and the same issues in both shells.
 *
 * A `z.tuple` with no rest element also rejects an argument list that is too long or too short,
 * which a per-argument check would not.
 *
 * Structural rather than `z.ZodType<A>`: zod v4's `ZodTuple` carries an `Input` type parameter
 * that does not unify with a bare `ZodType<A>` annotation, and this is the part of the signature
 * that actually matters.
 */
type ArgsSchema<A extends readonly unknown[]> = {
  safeParse(value: unknown): { success: true; data: A } | { success: false; error: z.ZodError }
}

/**
 * Ids are opaque strings from `newId()`; there is no contract schema for one, because there is
 * nothing to validate beyond "a plausible string". The real check is core's own lookup, which
 * joins against the owner and throws `NotFound`. This only keeps an object, or a megabyte of
 * text, from reaching a prepared statement.
 */
const idSchema = z.string().min(1).max(64)

/**
 * How an upload arrives. See `WireUploadBody` in protocol.ts for the two arms and for why a
 * `localPath` can only have been written by the preload.
 *
 * `z.instanceof(Uint8Array)` for the bytes arm is not decoration. Measured in Electron 44.0.0
 * through a sandboxed, context-isolated preload: a `Blob`, a `File` and a `ReadableStream` all
 * cross `ipcRenderer.invoke` as an **empty plain object** — no throw and no warning — so without
 * this check a client that forwarded a body untouched would write a zero-byte file and report
 * success. A `Uint8Array` arrives intact and `instanceof Uint8Array` still holds here.
 *
 * A union with no third arm, so the empty object the preload produces for an unrecognised token
 * is a `Validation` failure rather than anything at all.
 */
const uploadBodySchema = z.union([
  z.object({
    localPath: z.string().min(1),
    // Non-negative rather than positive: an empty file is a legitimate thing to upload.
    sizeBytes: z.number().int().min(0),
    lastModifiedMs: z.number().int().min(0),
  }),
  z.object({ bytes: z.instanceof(Uint8Array) }),
])

function libraryCall<P extends ApiPath, A extends readonly unknown[]>(
  path: P,
  schema: ArgsSchema<A>,
  run: (session: DispatchSession, ...args: A) => ResultAt<P> | Promise<ResultAt<P>>,
): Dispatched<ResultAt<P>> {
  return async ({ session }, args) => {
    if (!session) throw new AppError('Conflict', 'no library folder is open')
    const parsed = schema.safeParse(args)
    if (!parsed.success) {
      throw new AppError('Validation', `invalid arguments for ${path}`, {
        issues: parsed.error.issues,
      })
    }
    return await run(session, ...parsed.data)
  }
}

/**
 * For the two routes that answer out of the shell itself rather than out of a library:
 * `capabilities`, which the renderer asks for during bootstrap, and `library.pick`, which is how
 * a shell with no library open gets one. Both must work with `session` null.
 */
function shellCall<P extends ApiPath, A extends readonly unknown[]>(
  path: P,
  schema: ArgsSchema<A>,
  run: (shell: ShellApi, ...args: A) => ResultAt<P> | Promise<ResultAt<P>>,
): Dispatched<ResultAt<P>> {
  return async ({ shell }, args) => {
    const parsed = schema.safeParse(args)
    if (!parsed.success) {
      throw new AppError('Validation', `invalid arguments for ${path}`, {
        issues: parsed.error.issues,
      })
    }
    return await run(shell, ...parsed.data)
  }
}

/* -------------------------------------------------------------------------------------------
 * Uploads
 * ---------------------------------------------------------------------------------------- */

/** Core's upload takes the streaming arm of `UploadBody`; the bytes arrived whole, so wrap them. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** The filesystem's own name for a file, independent of how the path was spelled. */
type FileIdentity = { dev: bigint; ino: bigint }

function identityOf(path: string): FileIdentity | null {
  try {
    const info = statSync(path, { bigint: true })
    return { dev: info.dev, ino: info.ino }
  } catch {
    return null
  }
}

/** The path with links, short names and device prefixes resolved, or the plain resolution. */
function realPathOf(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Whether `candidate` is `directory` or sits underneath it — by **filesystem identity**, not by
 * string.
 *
 * String containment is what this replaced, and it was defeated five ways on Windows, all
 * measured against the library's own `app.db`: `.SPM` (NTFS is case-insensitive), `\\?\C:\…`
 * (the device-path prefix), `\\localhost\C$\…` and `\\?\UNC\localhost\C$\…` (UNC aliases for a
 * local disk). `resolve()` is a string operation: it case-folds nothing and normalises none of
 * those. Comparing `dev` and `ino` up the ancestor chain catches all five, because the question
 * being asked is "is this the same directory", which is a filesystem question.
 *
 * A string comparison is kept alongside it, case-insensitive on Windows, so that a `stat` failure
 * degrades to the weaker check rather than to no check at all.
 *
 * What identity comparison still cannot see is a **hard link** from outside `.spm` to a file
 * inside it: a hard link is a second, equally real name, and the walk up from it never passes
 * through `.spm`. Measured, and left: creating one needs write access to the filesystem, and the
 * threat model here is a compromised renderer, which has none. Catching it would mean comparing
 * the file's own identity against every file in `.spm` on every upload.
 */
function isInside(directory: string, candidate: string): boolean {
  const parent = realPathOf(directory)
  const child = realPathOf(candidate)
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  if (fold(child) === fold(parent) || fold(child).startsWith(fold(parent) + sep)) return true

  const parentId = identityOf(parent)
  if (!parentId) return false
  let current = child
  // Bounded: a path has finitely many ancestors, and `dirname` reaches a fixed point at the root.
  for (let depth = 0; depth < 64; depth += 1) {
    const id = identityOf(current)
    if (id && id.dev === parentId.dev && id.ino === parentId.ino) return true
    const next = dirname(current)
    if (next === current) return false
    current = next
  }
  return false
}

/**
 * Checks a picked path in the **main process**, and answers with the file's size.
 *
 * Constraint 4 says every IPC channel validates its input in the main process, and that the
 * renderer is the untrusted side of the boundary. The preload is what stops a `localPath` the
 * main world wrote from ever reaching here — but the preload runs in the renderer process, so on
 * the wrong side of that line. This is the main process's own check, and it exists so that a
 * `contextIsolation` bypass, a Chromium sandbox escape or one careless future edit to
 * `sanitiseArg` does not restore the full escalation.
 *
 * What it refuses:
 *
 * - a **relative** path, which `createReadStream` would otherwise resolve against the main
 *   process's working directory — nothing the picker produces is relative;
 * - anything that resolves inside the library's own `.spm`, where the database, the previews and
 *   the staging area live. That is the file the demonstrated exploit read. "Resolves" and not
 *   "is spelled like": see `isInside`, and the hard link it still cannot see;
 * - a file whose size or modification time no longer matches what it had when the user picked it
 *   (`Conflict`). That is Chromium's own rule for a stale `File`, adopted here so the desktop and
 *   browser arms answer the same way — see `WireUploadBody`.
 *
 * What it does **not** refuse: an absolute path to any other file the user can read. The main
 * process has no way to know what the user picked — Electron surfaces no event for an
 * `<input type="file">` choice — so the preload's isolation remains the primary guarantee and
 * this is defence in depth behind it, not a replacement for it.
 *
 * It also turns two ordinary accidents into codes the UI can switch on: a file deleted between
 * the picker and the upload would otherwise be an `ENOENT` wrapped into `Internal`, and a
 * directory an `EISDIR` from deep inside the read.
 */
async function sizeOfPickedFile(
  lib: Library,
  body: { localPath: string; sizeBytes: number; lastModifiedMs: number },
): Promise<number> {
  if (!isAbsolute(body.localPath)) {
    throw new AppError('Validation', 'a picked file must be named by an absolute path')
  }
  if (isInside(resolve(lib.dir, SPM_DIR), body.localPath)) {
    throw new AppError('Forbidden', `${SPM_DIR} is the library's own, and is not a source of files`)
  }
  let info
  try {
    info = await stat(realPathOf(body.localPath))
  } catch {
    throw new AppError('NotFound', 'that file is no longer where it was picked from')
  }
  if (!info.isFile()) throw new AppError('Validation', 'that is a folder, not a file')
  if (info.size !== body.sizeBytes || !sameModificationTime(info.mtimeMs, body.lastModifiedMs)) {
    throw new AppError('Conflict', 'that file changed after it was picked; choose it again')
  }
  return info.size
}

/**
 * Whether a `stat`'s modification time is the one Chromium recorded for the picked `File`.
 *
 * `File.lastModified` is whole milliseconds and `stat().mtimeMs` is fractional — measured on
 * NTFS, `1787783467178` against `1787783467178.9192` — so it is compared truncated. The extra
 * millisecond of slack is for a platform where Chromium rounds rather than floors, or where the
 * nanosecond-to-float conversion lands a hair below the whole millisecond; it is not load-bearing,
 * because the size comparison runs beside this one and a swap that also preserves the size is
 * exactly the case this cannot see anyway.
 */
function sameModificationTime(mtimeMs: number, lastModifiedMs: number): boolean {
  return Math.abs(Math.trunc(mtimeMs) - lastModifiedMs) <= 1
}

/**
 * Turns either wire arm into the streaming `UploadBody` core takes.
 *
 * The `localPath` arm is the one every upload the UI can start actually uses, and it is the whole
 * reason there is no size ceiling on this transport: the bytes are streamed off disk in the main
 * process and never enter a renderer buffer or an IPC message. `createReadStream` is chunked, so
 * a 10 GiB archive costs a 64 KiB buffer here.
 */
async function toUploadBody(
  lib: Library,
  body: WireUploadBody,
): Promise<{ stream: ReadableStream<Uint8Array>; sizeBytes: number }> {
  if ('bytes' in body) {
    return { stream: streamOf(body.bytes), sizeBytes: body.bytes.byteLength }
  }
  const sizeBytes = await sizeOfPickedFile(lib, body)
  // The real path, not the string that arrived: `sizeOfPickedFile` statted the real one, and
  // reading a different path than the one that was checked is how a check gets bypassed.
  return {
    stream: Readable.toWeb(
      createReadStream(realPathOf(body.localPath)),
    ) as ReadableStream<Uint8Array>,
    sizeBytes,
  }
}

/**
 * Stages the archive inside the library's own `.spm/uploads`, exactly as the server's import
 * route does and for the same reasons: `importCuraManagerZip` reads a path, the zip's central
 * directory sits at the end of the file so nothing can be validated before the last byte, and
 * `.spm` is excluded from every rescan so a staging file can never be adopted as a project.
 *
 * Only reached by the bytes arm. A picked archive is imported from where it already is — copying
 * a multi-gigabyte zip into the user's own library to read it back is what the server has to do
 * with an HTTP body and what a desktop shell does not.
 */
async function stageArchive(lib: Library, bytes: Uint8Array): Promise<string> {
  const dir = join(lib.dir, SPM_DIR, 'uploads')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${crypto.randomUUID()}.zip`)
  await writeFile(path, bytes)
  return path
}

/* -------------------------------------------------------------------------------------------
 * The table
 * ---------------------------------------------------------------------------------------- */

const NO_SESSIONS_HERE = 'this library is open locally; it has no accounts and no sessions'

export const dispatch: DispatchTable = {
  capabilities: shellCall('capabilities', z.tuple([]), (shell) => shell.capabilities()),

  /*
   * The one route that changes which library every other route answers out of.
   *
   * It takes no arguments on purpose: a *path* from the renderer would be a filesystem operation
   * on an attacker-chosen directory (constraint 4), and the renderer is the untrusted side of
   * this boundary. The folder can only come from the user, through a native dialog the main
   * process owns; all the renderer can do is ask for the dialog to be shown.
   */
  'library.pick': shellCall('library.pick', z.tuple([]), (shell) => shell.pickLibraryFolder()),

  /*
   * The other half of that route, for spec 2.6's other mode.
   *
   * It *does* take an argument, where `library.pick` deliberately does not, and the asymmetry is
   * the point: a folder path from the renderer would be a filesystem operation on an
   * attacker-chosen directory, while a server URL is a request to a machine the user names — the
   * one thing the renderer legitimately has to be able to say. `z.string()` only keeps a
   * non-string out of `parseRemoteOrigin`, which is where the real rules are (http or https, an
   * origin and nothing else, no credentials) and where a `Validation` failure comes from.
   */
  'library.connect': shellCall('library.connect', z.tuple([z.string()]), (shell, url) =>
    shell.connectRemote(url),
  ),

  /*
   * Local mode has no sessions at all (spec 2.6), and that is what these four say.
   *
   * `login` and `activate` both mint a session token in core, and in this shell there is nowhere
   * for one to live and nothing that would read it: `ctx` is fixed to `ensureLocalUser`'s row for
   * the lifetime of the process. Calling core and discarding the token would write session rows
   * that influence nothing — a worse answer than refusing, because it would look like it worked.
   *
   * `logout` resolves instead of refusing, because it is the one of the four the UI can actually
   * reach: the header's sign-out button is gated on `auth.isAuthenticated()`, which is true here
   * since `account.me()` succeeds. "End the session you do not have" is a no-op, not an error.
   * (That the button is shown at all in local mode is a UI question, and task 4's.)
   *
   * `checkToken` is a real read-only core query. A local library simply contains no activation
   * tokens, so it answers `{ valid: false }` truthfully rather than by being told to.
   */
  'auth.login': libraryCall(
    'auth.login',
    z.tuple([loginSchema.shape.username, loginSchema.shape.password]),
    // The parameters are named and unused on purpose: without them the argument tuple would be
    // inferred from this callback as `[]`, and the schema's two elements would be dropped.
    (_session, _username, _password) => {
      throw new AppError('Forbidden', NO_SESSIONS_HERE)
    },
  ),
  'auth.logout': libraryCall('auth.logout', z.tuple([]), () => undefined),
  'auth.checkToken': libraryCall(
    'auth.checkToken',
    z.tuple([z.string().min(1)]),
    async ({ lib }, token) => {
      const result = await checkActivationToken(lib.db, token)
      // The same narrowing the server route does: `userId` is internal and never leaves core.
      return result.valid ? { valid: true, username: result.username } : { valid: false }
    },
  ),
  'auth.activate': libraryCall(
    'auth.activate',
    z.tuple([z.string().min(1), passwordSchema]),
    (_session, _token, _newPassword) => {
      throw new AppError('Forbidden', NO_SESSIONS_HERE)
    },
  ),

  'account.me': libraryCall('account.me', z.tuple([]), ({ lib, ctx }) => me(lib, ctx)),
  'account.changePassword': libraryCall(
    'account.changePassword',
    z.tuple([changePasswordSchema.shape.current, changePasswordSchema.shape.next]),
    async ({ lib, ctx }, current, next) => {
      await changePassword(lib, ctx, current, next)
    },
  ),
  'account.updateProfile': libraryCall(
    'account.updateProfile',
    z.tuple([profilePatchSchema]),
    ({ lib, ctx }, patch) => updateProfile(lib, ctx, patch),
  ),

  'settings.get': libraryCall('settings.get', z.tuple([]), ({ lib, ctx }) => getSettings(lib, ctx)),
  'settings.put': libraryCall(
    'settings.put',
    z.tuple([settingsPatchSchema]),
    ({ lib, ctx }, patch) => putSettings(lib, ctx, patch),
  ),

  'users.list': libraryCall('users.list', z.tuple([]), ({ lib, ctx }) => listUsers(lib, ctx)),
  'users.create': libraryCall(
    'users.create',
    z.tuple([createUserSchema]),
    async ({ lib, ctx }, input) => {
      const { user, token } = await createUser(lib, ctx, input)
      return { user, activationUrl: `${ACTIVATION_URL_BASE}#${token}` }
    },
  ),
  'users.reissueInvite': libraryCall(
    'users.reissueInvite',
    z.tuple([idSchema]),
    async ({ lib, ctx }, id) => {
      const { token } = await reissueInvite(lib, ctx, id)
      return { activationUrl: `${ACTIVATION_URL_BASE}#${token}` }
    },
  ),
  'users.update': libraryCall(
    'users.update',
    z.tuple([idSchema, updateUserSchema]),
    ({ lib, ctx }, id, patch) => updateUser(lib, ctx, id, patch),
  ),
  'users.delete': libraryCall('users.delete', z.tuple([idSchema]), ({ lib, ctx }, id) => {
    deleteUser(lib, ctx, id)
  }),

  'projects.list': libraryCall(
    'projects.list',
    z.tuple([projectQuerySchema]),
    ({ lib, ctx }, query) => listProjects(lib, ctx, query).map(decorateProject),
  ),
  'projects.get': libraryCall('projects.get', z.tuple([idSchema]), ({ lib, ctx }, id) =>
    decorateProjectDetail(getProject(lib, ctx, id)),
  ),
  'projects.create': libraryCall(
    'projects.create',
    z.tuple([createProjectSchema]),
    ({ lib, ctx }, input) => decorateProject(createProject(lib, ctx, input)),
  ),
  'projects.update': libraryCall(
    'projects.update',
    z.tuple([idSchema, projectPatchSchema]),
    ({ lib, ctx }, id, patch) => decorateProject(updateProject(lib, ctx, id, patch)),
  ),
  'projects.delete': libraryCall(
    'projects.delete',
    z.tuple([idSchema, z.object({ deleteFiles: z.boolean() })]),
    ({ lib, ctx }, id, opts) => {
      deleteProject(lib, ctx, id, opts)
    },
  ),
  'projects.addTag': libraryCall(
    'projects.addTag',
    z.tuple([idSchema, tagNameSchema]),
    ({ lib, ctx }, id, name) => {
      addTag(lib, ctx, id, name)
    },
  ),
  'projects.removeTag': libraryCall(
    'projects.removeTag',
    z.tuple([idSchema, tagNameSchema]),
    ({ lib, ctx }, id, name) => {
      removeTag(lib, ctx, id, name)
    },
  ),
  'projects.rescan': libraryCall('projects.rescan', z.tuple([]), ({ lib, ctx }) =>
    rescan(lib, ctx),
  ),

  'importer.curaManagerZip': libraryCall(
    'importer.curaManagerZip',
    z.tuple([uploadBodySchema]),
    async ({ lib, ctx }, body) => {
      if ('localPath' in body) {
        // Read from where the user keeps it. Deliberately *not* removed afterwards: it is their
        // file, not a staging copy, and the importer only reads it.
        await sizeOfPickedFile(lib, body)
        return await importCuraManagerZip(lib, ctx, realPathOf(body.localPath))
      }
      const staged = await stageArchive(lib, body.bytes)
      try {
        return await importCuraManagerZip(lib, ctx, staged)
      } finally {
        // Always: the archive has either been extracted or rejected, and either way a
        // multi-gigabyte copy inside the user's own library is not theirs to keep.
        await rm(staged, { force: true }).catch(() => {})
      }
    },
  ),

  'files.upload': libraryCall(
    'files.upload',
    z.tuple([idSchema, fileNameSchema, uploadBodySchema]),
    async ({ lib, ctx }, projectId, name, body) =>
      decorateFile(await uploadFile(lib, ctx, projectId, name, await toUploadBody(lib, body))),
  ),
  'files.rename': libraryCall(
    'files.rename',
    z.tuple([idSchema, fileNameSchema]),
    ({ lib, ctx }, id, name) => decorateFile(renameFile(lib, ctx, id, name)),
  ),
  'files.delete': libraryCall('files.delete', z.tuple([idSchema]), ({ lib, ctx }, id) => {
    deleteFile(lib, ctx, id)
  }),
}

/** Narrows an arbitrary string from the renderer to a key of the table. */
export function isApiPath(value: unknown): value is ApiPath {
  return typeof value === 'string' && Object.hasOwn(dispatch, value)
}
