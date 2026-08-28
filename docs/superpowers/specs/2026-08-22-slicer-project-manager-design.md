# Slicer Project Manager — Design

- **Date:** 2026-08-22
- **Status:** Approved (design); implementation plan pending
- **Successor to:** CuraManager (WPF, .NET 10, Windows-only, Cura-only)

## 1. Purpose and scope

A cross-platform manager for 3D-printing projects: a library of project folders holding
model files (STL/OBJ/3MF) and slicer project files, with metadata (tags, source URL,
archive state), model previews, multi-slicer launching, and an embedded browser for
downloading models from model sites directly into a project.

It ships in two forms from one codebase:

- **Web** — a Deno server, multi-user, accessed from a browser. Project browsing and
  model previews only.
- **Desktop** — an Electron app. Everything the web build has, plus the model-site
  browser and slicer integration, and the ability to work fully offline against a
  local folder.

### 1.1 Subsystems and what this spec covers

|       | Subsystem                                                                           | Depends on | This spec                                                                                                            |
| ----- | ----------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| **A** | Deno backend (SQLite, file store, auth/users) + Angular project browser + web build | —          | **Full, implementable detail**                                                                                       |
| **B** | 3D model previews (thumbnails + interactive viewer)                                 | A          | Skeleton + pipeline design                                                                                           |
| **C** | Electron shell (offline local folder, native dialogs)                               | A          | Skeleton + extension points                                                                                          |
| **D** | Slicer configuration and launching                                                  | C          | Extension points only — full detail in [subsystem D](2026-08-28-slicer-project-manager-subsystem-d-slicers.md)       |
| **E** | Model browser (embedded browsing, download interception, project matching)          | C          | Extension points only — full detail in [subsystem E](2026-08-28-slicer-project-manager-subsystem-e-model-browser.md) |

B–E each get their own spec and plan cycle. This document fixes the cross-cutting
architecture they must all fit into — package boundaries, data model, API contract, auth,
capability model, build targets — so those later specs are additive rather than
structural.

**Amended 2026-08-28:** that is not what happened for B or C. Both went straight to a plan, and
their rows above are unchanged because this document's coverage of them did not change. D is the
first subsystem to produce a second spec, which is why its row points at one. The sentence is left
standing as the intent rather than deleted — a subsystem large enough to need a spec should get
one — but it describes a rule two subsystems have already, deliberately, not followed. **E followed
it**, on 2026-08-28, and its row points at its own spec too.

### 1.2 Explicitly out of scope

- Sharing projects between users, or any permission model beyond per-user ownership.
- Self-registration. Accounts are created by an admin only.
- Email delivery (SMTP). Activation links are copied by the admin out of band.
- Printer control, G-code analysis, or print-job management.
- Migration tooling beyond reading CuraManager's `metadata.json` sidecars (see 3.6).

### 1.3 Prior art carried over

CuraManager's domain model (`PrintElement`, `PrintElementFile`, `PrintElementMetadata`)
maps directly onto the schema in 3.3: a project is a folder, files are classified into
model / slicer-project / other, and metadata is tags + website + archived flag.

Two CuraManager behaviours are deliberately **not** carried over:

- The **UI-Automation hack** that drove Cura's save dialog to set a project name. It was
  Windows-only, depended on control tree layout, and broke on most Cura releases.
- The **`metadata.json` sidecar as source of truth**. Superseded by SQLite (3.2),
  though the sidecar is still _read_ for migration.

## 2. Architecture

### 2.1 Package layout

A pnpm workspace. Deno is used only to run the server package; Angular CLI and
electron-builder stay on the Node toolchain they are designed for.

```
slicer-project-manager/
├── pnpm-workspace.yaml
├── packages/
│   ├── contract/     types, Standard Schema validators, ApiClient interface
│   ├── core/         runtime-agnostic logic (Web APIs + node: only)
│   │   ├── db/         node:sqlite, schema, migrations, queries
│   │   ├── auth/       pbkdf2, sessions, activation tokens
│   │   ├── projects/   CRUD, folder ops, rescan/reconcile
│   │   ├── files/      add/rename/delete, streaming reads
│   │   └── previews/   stl + 3mf parsers, rasterizer, job queue
│   ├── server/       Deno: Deno.serve to core, cookie sessions, serves web bundle
│   ├── desktop/      Electron: ipcMain to core, spm:// protocol, dialogs, slicers
│   └── web/          Angular 22: zoneless, signals, signal forms, jig
```

### 2.2 The runtime-agnostic core

`core` is the whole application's behaviour and knows nothing about HTTP, Electron, or
Angular. It is written against **Web-standard and `node:` APIs only** — notably
`crypto.subtle` (Web Crypto) and `node:sqlite`, both of which exist in Deno and in Node.
This is what lets the identical code run as a Deno HTTP server and inside Electron's
Node main process without a second runtime being shipped or a subprocess being spawned.

This is the design's central bet, so it is tested directly: `core`'s unit suite runs
under **both Deno and Node in CI** (8.1).

Every use case takes an explicit context:

```ts
type Ctx = { userId: string; isAdmin: boolean }
```

**Ownership and authorisation are enforced inside `core`, never in a transport.** Each
use case scopes its own query by `ctx.userId`; there is no unscoped query for a transport
to call by mistake. Admin-only operations check `ctx.isAdmin` in `core` as well.

### 2.3 The contract package

`contract` holds the shared types, the `ApiClient` interface, and the validation schemas.
It exists as its own package because of one specific payoff: Angular 22's signal forms
support `validateStandardSchema`, and Zod 4 implements Standard Schema. So a single
schema object validates in the Angular form _and_ on the backend. One definition, no
client/server drift.

### 2.4 Capability model

Capabilities are resolved **at runtime**, not compiled in, because the effective set is
the product of two independent axes — the shell the UI runs in, and the backend it is
talking to.

| Capability                    | Browser + server | Electron + local folder | Electron + remote server |
| ----------------------------- | ---------------- | ----------------------- | ------------------------ |
| `requiresAuth`                | yes              | no                      | yes                      |
| `canManageUsers` (admin only) | yes              | no                      | yes                      |
| `canPickLocalFolder`          | no               | yes                     | no                       |
| `canLaunchSlicer`             | no               | yes                     | yes                      |
| `canConfigureSlicers`         | no               | yes                     | yes                      |
| `canBrowseModelSites`         | no               | yes                     | yes                      |

The third column is why a build-time flag is insufficient: the Electron app pointed at a
remote server needs remote auth _and_ local slicer launching at the same time. The shell
contributes its capabilities, the backend contributes its own, and the client uses the
union, fetched at bootstrap via `capabilities()`.

### 2.5 Build targets

Two `ng build` configurations. The web build **physically excludes** desktop-only code
rather than merely hiding it: desktop-only features live under
`packages/web/src/app/features/desktop/*` and are referenced only from
`routes.electron.ts`, which is swapped in by `fileReplacements` in `angular.json`.

Compile-time exclusion of the code; runtime capability flags for the affordances.

### 2.6 Desktop library modes

On launch the Electron app opens either:

- a **local folder** — `IpcApiClient` to local `core` to local SQLite. No login. Fully offline.
- a **remote server** — `HttpApiClient` to the Deno server. Log in with an account.

Same UI in both. This is what the two transports buy: the desktop app can add browsing
and slicer integration on top of a server-hosted library, while still working standalone.

**In local mode there is still exactly one `users` row**, created on first open of a
folder, because `Ctx` needs a `userId` and the schema is shared. It has
`library_dir = '.'`, which makes a local library **flat** — project folders sit directly
under `SPM_LIBRARY_DIR`, with no user-name level. That is both nicer for a hand-managed
local folder and the same shape a CuraManager library already has (3.6). There is no
login, no session, and `canManageUsers` is false.

### 2.7 Known constraint: slicer launch against a remote library

In _Electron + remote server_ mode, "open in slicer" cannot hand the slicer a URL. It
must download the project's files into a local cache directory, launch the slicer against
those, and then reconcile whatever the slicer writes back on save.

This is the most awkward corner of the design. It belongs to spec D and is recorded here
as a known constraint, not solved.

## 3. Data model

### 3.1 Configuration and folder layout

One environment variable:

```
SPM_LIBRARY_DIR    e.g. D:\SynologyDrive\3D Druck\Print files
```

```
$SPM_LIBRARY_DIR/
├── .spm/
│   ├── app.db
│   └── previews/<file-id>.png
├── marc/
│   ├── Benchy/
│   │   ├── benchy.stl
│   │   └── benchy.3mf
│   └── Bracket/
└── anna/
    └── Gridfinity Bin/
```

SQLite uses default settings. Because `app.db` lives inside the library directory, the
library folder is **wholly self-describing**: moving, copying, or backing up that one
folder carries the files and all metadata together.

The scan **must skip dot-folders** so `.spm/` is never adopted as a project (3.5).

### 3.2 Where truth lives

- **SQLite is the sole source of truth for metadata** — tags, source URL, archive state,
  project names, users, sessions.
- **Disk is the source of truth for which files exist.** People drop files into project
  folders by hand, and slicers write new project files there. The `files` table is an
  index of disk, refreshed by scanning.

Losing `app.db` therefore loses metadata but not files, and a rescan can rebuild a
skeleton library from the folders alone (3.5, 3.6).

### 3.3 Schema

Migrations are numbered SQL files in `core/db/migrations/`.

```sql
users              id TEXT PK, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT,
                   library_dir TEXT UNIQUE,
                   pw_hash BLOB, pw_salt BLOB, pw_iterations INTEGER, pw_algo TEXT,
                       -- all four NULL while status='pending'
                   is_admin INTEGER NOT NULL DEFAULT 0,
                   status TEXT NOT NULL,        -- 'pending' | 'active' | 'disabled'
                   quota_bytes INTEGER,         -- NULL = unlimited (5.6)
                   created_at INTEGER NOT NULL, activated_at INTEGER

activation_tokens  id TEXT PK, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                   token_hash BLOB NOT NULL,    -- sha256(raw); raw is never stored
                   expires_at INTEGER NOT NULL, consumed_at INTEGER,
                   created_at INTEGER NOT NULL

sessions           token_hash BLOB PK,          -- sha256(raw session token)
                   user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                   created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
                   expires_at INTEGER NOT NULL, user_agent TEXT

projects           id TEXT PK,
                   owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                   name TEXT NOT NULL, dir_name TEXT NOT NULL,
                   website TEXT, notes TEXT,
                   is_archived INTEGER NOT NULL DEFAULT 0,
                   state TEXT NOT NULL DEFAULT 'ok',   -- 'ok' | 'missing'
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                   UNIQUE(owner_id, dir_name)

tags               id INTEGER PK,
                   owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                   name TEXT NOT NULL,
                   UNIQUE(owner_id, name COLLATE NOCASE)

project_tags       project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                   PRIMARY KEY(project_id, tag_id)

files              id TEXT PK,
                   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   rel_path TEXT NOT NULL,
                   kind TEXT NOT NULL,          -- 'model' | 'slicer_project' | 'other'
                   slicer TEXT,                 -- set when kind='slicer_project'
                   size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
                   content_hash BLOB,           -- computed lazily, for preview invalidation
                   UNIQUE(project_id, rel_path)

previews           file_id TEXT PK REFERENCES files(id) ON DELETE CASCADE,
                   state TEXT NOT NULL,         -- 'pending'|'ready'|'failed'|'unsupported'
                   source TEXT,                 -- 'rasterized' | 'embedded'
                   png_path TEXT, width INTEGER, height INTEGER,
                   source_hash BLOB, error TEXT,
                   attempts INTEGER NOT NULL DEFAULT 0,
                   updated_at INTEGER NOT NULL

user_settings      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                   key TEXT NOT NULL, value TEXT,
                   PRIMARY KEY(user_id, key)    -- theme, language, view mode, sort
```

Raw tokens are never persisted, only their SHA-256. A stolen database yields no usable
session cookie and no usable activation link.

`users.library_dir` is **stored, not derived** from the username. Folders stay
human-readable (`library/marc/`), while a username change becomes an explicit, handled
rename rather than something that silently orphans every folder.

### 3.4 Slicer file classification

All five target slicers write `.3mf` project files, so a `.3mf` is ambiguous and must be
disambiguated by inspecting its zip entries. This replaces CuraManager's single
Cura-only check.

**Verified 2026-08-22 against real project files** produced by all five slicers. Zip
entry lists:

| Slicer                  | Distinguishing entries                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Cura                    | `Cura/*` (16 entries), `Metadata/thumbnail.png`                                                                        |
| PrusaSlicer             | `Metadata/Slic3r_PE.config`, `Metadata/Slic3r_PE_model.config`                                                         |
| Anycubic / Bambu / Orca | **identical layout** — `Metadata/project_settings.config`, `model_settings.config`, `slice_info.config`, `plate_*.png` |

Cura and PrusaSlicer are identifiable by path. The three Bambu-lineage slicers are not:
their entry lists are effectively the same. They identify themselves only in the
`slice_info.config` header.

**Measured headers:**

| Slicer                       | `slice_info.config` header items                                      |
| ---------------------------- | --------------------------------------------------------------------- |
| Anycubic Slicer Next 1.4.1.2 | `X-ACNext-Client-Type`, `X-ACNext-Client-Version`                     |
| Bambu Studio 02.08.02.61     | `X-BBL-Client-Type`, `X-BBL-Client-Version`                           |
| OrcaSlicer 2.4.2             | `X-BBL-Client-Type`, `X-BBL-Client-Version`, **`OrcaSlicer-Version`** |

**OrcaSlicer's header is a superset of Bambu Studio's** — it keeps the `X-BBL-*` keys
inherited from the fork and adds its own. So the registry order is load-bearing:
`OrcaSlicer-Version` **must** be tested before `X-BBL-Client-Type`, or every Orca project
is labelled `bambu`.

**Detection algorithm** — first match wins:

```
1. any entry prefixed "Cura/"                 → cura
2. Metadata/Slic3r_PE.config exists           → prusaslicer
3. Metadata/slice_info.config exists
     parse <header_item key="..."/>, first match in registry order:
       a. X-ACNext-Client-Type   → anycubic
       b. OrcaSlicer-Version     → orca      ← must precede (c)
       c. X-BBL-Client-Type      → bambu
       d. no match               → slicer_project, slicer = null
4. Metadata/project_settings.config exists    → slicer_project, slicer = null
5. otherwise                                  → kind='model'
```

Matching is on the header-item **key**, never the version value, so future releases keep
matching. Adding another Orca derivative is one registry row ahead of `X-BBL-Client-Type`.

**Rule 4 exists because `slice_info.config` appears to be written on slice, not on
save.** An unsliced-but-saved project may therefore lack it. Such a file is still
correctly classified as a slicer project; only the specific slicer is unknown. This is
deliberately reported as `slicer = null` rather than guessed, so the UI can fall back to
the user's default slicer instead of launching the wrong one. (My earlier draft defaulted
this case to `orca`, which would have mislabelled Bambu projects.)

**Two traps confirmed and rejected as discriminators:**

- **`printer_model` is worthless.** The OrcaSlicer test project reports
  `"printer_model": "Anycubic Kobra X"`. Printer identity says nothing about which slicer
  wrote the file.
- **`project_settings.config` has no usable marker.** Its `version` field mirrors the
  client version, and Orca inherits Bambu's zero-padded format (`02.06.00.51` vs
  `02.08.02.61`), so it separates Anycubic from the lineage but never Bambu from Orca.
  Indentation differs (Orca uses tabs, the others spaces) but that is incidental
  formatting and must not be relied on.

`.stl` and `.obj` are always `kind='model'`; anything that is neither a model nor a
recognised slicer project is `kind='other'`.

Note that `slice_info.config` carries the producing application's version. Not stored in
the schema today, but it is the natural source if a "made with an older slicer" warning
is ever wanted.

### 3.5 Reconciliation (rescan)

A rescan walks each user's library root and reconciles disk against the database.

- **Folder on disk with no `projects` row → adopt.** Create the project, taking `name`
  and `dir_name` from the folder.
- **`projects` row whose folder is gone → set `state='missing'`.** Never delete metadata
  implicitly; an unmounted network drive must not destroy a thousand tags.
- **File on disk with no `files` row → insert**, classified per 3.4, with a `previews`
  row seeded `state='pending'`.
- **`files` row whose file is gone → delete** the row (and its preview) — but only within
  a project whose folder is _present_. The files of a `state='missing'` project are left
  intact, because the whole folder may simply be on an unmounted drive.
- **`mtime_ms` or `size_bytes` changed → recompute `content_hash`**; if it differs from
  `previews.source_hash`, reset that preview to `'pending'`.
- **Dot-folders are skipped** at every level.

### 3.6 Migrating an existing CuraManager library

Migration is the adopt path plus a sidecar reader — no bespoke tool:

1. Point `SPM_LIBRARY_DIR` at the existing library.
2. Rescan. Every project folder is adopted and its files indexed.
3. The importer reads each folder's `metadata.json` (`Tags`, `Website`, `IsArchived`)
   and applies it to the adopted project.

Because CuraManager libraries are flat (project folders at the root, not under a user
folder), they line up exactly with a **local-mode** library, whose single user has
`library_dir = '.'` (2.6). So opening an old CuraManager library in the desktop app's
local mode needs no restructuring at all.

Importing into a **server** library does, because there the projects must land under a
user folder. In that case the importer takes the target user as an explicit argument and
moves each project folder into that user's `library_dir`.

### 3.7 Slicer configuration is not in `app.db`

Slicer executable paths are machine-specific. If the desktop app is pointed at a remote
server, they must not travel with the shared library. Slicer configuration lives in
Electron's own `userData` store.

### 3.8 Search

Indexed `LIKE` with `COLLATE NOCASE` over project name, tags, and notes. Not FTS5: it is
not yet confirmed that `node:sqlite` exposes FTS5 on both Deno and Node, and a few
thousand projects do not need it. Recorded as an optional later optimisation.

## 4. API contract

### 4.1 The interface

`contract` defines one interface; both transports implement it, so the Angular app never
knows which it is talking to.

```ts
interface ApiClient {
  capabilities(): Promise<Capabilities>

  auth: {
    login(username, password): Promise<UserDto>
    logout(): Promise<void>
    checkToken(token): Promise<{ valid: boolean; username?: string }>
    activate(token, newPassword): Promise<UserDto>
  }

  account: {
    // any active user, on themselves
    me(): Promise<UserDto>
    changePassword(current, next): Promise<void>
    updateProfile(patch): Promise<UserDto>
  }

  users: {
    // isAdmin required, enforced in core
    list(): Promise<UserDto[]>
    create(dto): Promise<{ user: UserDto; activationUrl: string }>
    reissueInvite(id): Promise<{ activationUrl: string }>
    update(
      id,
      patch: { isAdmin?: boolean; isDisabled?: boolean; quotaBytes?: number | null },
    ): Promise<UserDto>
    delete(id): Promise<void>
  }

  projects: {
    list(query: ProjectQuery): Promise<ProjectDto[]>
    get(id): Promise<ProjectDetailDto>
    create(dto): Promise<ProjectDto>
    update(id, patch): Promise<ProjectDto>
    delete(id, opts: { deleteFiles: boolean }): Promise<void>
    addTag(id, name): Promise<void>
    removeTag(id, name): Promise<void>
    rescan(): Promise<RescanResultDto>
  }

  files: {
    upload(projectId, name, stream): Promise<FileDto>
    rename(id, name): Promise<FileDto>
    delete(id): Promise<void>
  }
}
```

### 4.2 DTOs

```ts
Capabilities {
  requiresAuth, canManageUsers, canPickLocalFolder,
  canLaunchSlicer, canConfigureSlicers, canBrowseModelSites: boolean
}

UserDto {
  id, username, displayName,
  isAdmin: boolean,
  status: 'pending' | 'active' | 'disabled',
  diskUsageBytes: number,             // derived, see 5.6
  quotaBytes: number | null,          // null = unlimited
  createdAt, activatedAt?: number
}

ProjectDto {                        // list view
  id, name, website?, notes?,
  isArchived: boolean,
  state: 'ok' | 'missing',
  tags: string[],
  fileCounts: { model: number; slicerProject: number; other: number },
  coverThumbUrl?: string,           // first ready model preview, for the grid tile
  createdAt, updatedAt: number
}

ProjectDetailDto extends ProjectDto {
  files: FileDto[]
}

FileDto {
  id, name, kind: 'model' | 'slicer_project' | 'other',
  slicer?: string, sizeBytes: number,
  previewState: 'pending' | 'ready' | 'failed' | 'unsupported',
  thumbUrl?: string,                // present when previewState === 'ready'
  rawUrl: string
}

ProjectQuery {
  search?: string, tags?: string[],
  includeArchived?: boolean,
  sort?: 'name' | 'createdAt' | 'updatedAt', dir?: 'asc' | 'desc'
}

RescanResultDto {
  adopted, markedMissing, filesAdded, filesRemoved, previewsQueued: number
}
```

`ProjectDto.coverThumbUrl` exists so the project grid renders from a single `list` call.
It resolves to the first model file whose preview is `ready`, and is absent until one is.

URLs are returned in the DTOs rather than fetched per file, so rendering a grid is one
call rather than N+1.

**`core` returns IDs and never knows about URLs.** The transport adapter decorates DTOs,
because only it knows its own scheme:

|          | Thumbnail              | Raw file             |
| -------- | ---------------------- | -------------------- |
| HTTP     | `/api/files/:id/thumb` | `/api/files/:id/raw` |
| Electron | `spm://file/:id/thumb` | `spm://file/:id/raw` |

Bulk bytes never cross a JSON boundary. In Electron these are served by
`protocol.handle('spm://')`. Either way the result is a plain URL that an `<img>` tag or
a three.js loader consumes directly, so streaming stays a browser concern and is never
buffered into memory.

### 4.3 REST mapping (server transport)

| Method                   | Path                                         | Notes                               |
| ------------------------ | -------------------------------------------- | ----------------------------------- |
| `GET`                    | `/api/capabilities`                          | unauthenticated                     |
| `POST`                   | `/api/auth/login`                            | sets session cookie                 |
| `POST`                   | `/api/auth/logout`                           |                                     |
| `GET`                    | `/api/auth/activation/:token`                | read-only token check               |
| `POST`                   | `/api/auth/activation/:token`                | set password, issues session        |
| `GET`, `PATCH`           | `/api/account`                               | self-service                        |
| `POST`                   | `/api/account/password`                      |                                     |
| `GET`, `POST`            | `/api/users`                                 | admin                               |
| `PATCH`, `DELETE`        | `/api/users/:id`                             | admin                               |
| `POST`                   | `/api/users/:id/invite`                      | admin, re-issue                     |
| `GET`, `POST`            | `/api/projects`                              |                                     |
| `GET`, `PATCH`, `DELETE` | `/api/projects/:id`                          |                                     |
| `POST`                   | `/api/projects/rescan`                       |                                     |
| `POST`                   | `/api/projects/:id/tags`                     | body carries the tag name           |
| `DELETE`                 | `/api/projects/:id/tags/:name`               | name in the path, so no DELETE body |
| `POST`                   | `/api/projects/:id/files`                    | upload                              |
| `PATCH`, `DELETE`        | `/api/files/:id`                             |                                     |
| `GET`                    | `/api/files/:id/raw`, `/api/files/:id/thumb` | streamed                            |

## 5. Authentication and users

### 5.1 Password hashing

Web Crypto `PBKDF2-HMAC-SHA256`, 600,000 iterations, 16-byte random salt, 32-byte derived
key. Built into both runtimes, zero dependencies. Parameters are stored per user
(`pw_iterations`, `pw_algo`) so they can be raised later and old hashes upgraded on next
successful login.

`node:crypto`'s `scrypt` is also builtin to both runtimes and is memory-hard, so it is a
strictly stronger option if the requirement is ever revisited.

### 5.2 Sessions

Opaque 256-bit random tokens, stored as SHA-256 in `sessions`, delivered as an
`httpOnly; Secure; SameSite=Lax` cookie. Not JWTs: revocation is a row delete rather than
a denylist, and `httpOnly` keeps the token unreadable by injected script.

In Electron local mode there is no session; `Ctx` is the single local user.

### 5.3 Account creation and activation

There is **no self-registration**.

```
admin: users.create({ username: "anna", displayName: "Anna" })
  -> users row: status='pending', pw_hash=NULL
  -> raw token = 32 random bytes, base64url        (returned ONCE, never stored)
  -> activation_tokens: token_hash=sha256(raw), expires_at=now+7d
  -> returns https://spm.home.lan/activate#<raw>

admin copies that link to the user out of band.

anna: opens link
  -> checkToken (read-only) confirms it is valid and unexpired
  -> she sets a password
  -> pbkdf2(600k) -> pw_hash; status='active'; activated_at=now; consumed_at=now
  -> session issued immediately: she is logged in, with no second login step
```

Three deliberate details:

- The token rides in the URL **fragment** (`#`), so it never reaches server access logs
  or a `Referer` header the way a query string would.
- `checkToken` is a **separate read-only call**, so an expired link shows a real error
  before the user types a password rather than after.
- The token is **single-use with a 7-day expiry**; an admin can re-issue when it lapses.

### 5.4 First-run bootstrap

On first run against an empty database, the app creates the admin row in `pending` state
and writes its activation URL to the server log. No default password exists anywhere in
the codebase, the container image, or the documentation.

An empty `users` table re-triggers this on next start, which is the recovery path if
every account is somehow deleted.

### 5.5 Admin rules

- All of `users.*` requires `ctx.isAdmin`, enforced in `core`.
- Self-service operations live under `account.*` and require only an active session.
- Any user can be promoted or demoted via `users.update(id, { isAdmin })`.
- The bootstrap admin is an ordinary row with no special flag: it can be disabled,
  demoted, or deleted like any other.
- **Guard:** the last remaining _active admin_ cannot be deleted, disabled, or demoted.
  `users.update` and `users.delete` reject the operation. Without this, one click
  permanently removes all user management with no in-app recovery. This does not make the
  first admin special — any admin including that one can be removed, just never the final
  one.
- Admins manage users but **cannot see other users' projects**. Ownership scoping in
  `core` applies to admins too.

### 5.6 Disk usage and quotas

Admins cannot see other users' _projects_ (5.5), but they can see how much space each
user consumes and cap it.

**Usage is derived, never stored.** It is an aggregate over data the `files` index
already holds, so there is nothing to backfill and nothing that can drift out of sync
with reality:

```sql
SELECT p.owner_id, SUM(f.size_bytes)
FROM files f JOIN projects p ON p.id = f.project_id
WHERE p.state = 'ok'
GROUP BY p.owner_id
```

`state = 'ok'` matters: a `missing` project keeps its file rows (3.5) because the folder
may be on an unmounted drive, and those bytes are not currently occupying disk.

Preview PNGs under `.spm/previews/` are application overhead rather than user data and
are excluded from the quota.

**Enforcement:**

- `files.upload` checks projected usage against `quota_bytes` **before** writing and
  fails with a typed `QuotaExceeded` error carrying usage, quota, and the incoming size,
  so the UI can render a real message rather than a generic failure.
- Downloads from the model browser (spec E) land through `files.upload`, so they inherit
  the check with no extra code.
- **Rescan never fails on quota.** Files already on disk are indexed regardless and the
  user is simply reported over quota. Refusing to index existing files would hide a
  user's own files from them without deleting anything — the worst available outcome.
- `quota_bytes` is `NULL` by default, meaning unlimited. Lowering a quota below current
  usage is allowed: it blocks further uploads without touching existing files.

`/admin/users` shows usage, quota, and percentage per user.

**Scope note:** this is an addition to subsystem A beyond the original brief, requested
2026-08-22. It is small precisely because `files.size_bytes` was already indexed.

### 5.7 Assumption

No SMTP. `users.create` returns the activation link for the admin to copy, and the admin
UI presents it with a copy button.

## 6. Frontend

### 6.1 Angular setup

Angular 22 with `provideZonelessChangeDetection()`, standalone components throughout, no
NgModules. State lives in signal-based store services; async reads use `resource()` with
a loader that calls `ApiClient` — which works because `resource()` accepts any promise,
so the transport abstraction survives.

UI is `@awdlab/jig` plus `@awdlab/jig-themes`. jig is signals-native, targets Angular
22+, and its controls implement Angular's `FormValueControl` contract.

### 6.2 Forms

`form()` plus `validateStandardSchema(schema)`, pulling the same Zod schema from
`contract` that the backend validates with. Bound through jig's `[formField]`, errors
rendered by `jigErrors` into `jig-hint`, labels via `jig-input-field`.

### 6.3 Routes

```
/login              /activate                 public
/projects           /projects/:id             core
/settings                                     theme, language
/admin/users                                  isAdmin guard
/browse             <- electron only          model sites (spec E)
/settings/slicers   <- electron only          slicer config (spec D)
```

Desktop-only routes are referenced only from `routes.electron.ts` (2.5).

### 6.4 Internationalisation

**`@ngneers/signal-translate`.** `@angular/localize` was rejected because it is
build-time, producing one bundle per locale, which cannot satisfy the runtime language
switch implied by `user_settings.language`.

signal-translate fits the rest of the stack directly: translations are signals rather
than observables, so they compose with zoneless change detection with no bridging;
`setLanguage(lang)` switches reactively at runtime; the `translations` signal is
strongly typed with autocompletion, so a missing key is a compile error; and
`loadTranslations(lang)` is implemented with a dynamic import, so locale JSON is
lazy-loaded rather than bundled up front.

Integration: a `TranslateService` extending `BaseTranslateService`, seeded from
`user_settings.language` at bootstrap and writing back on change. `interpolate()` and
`InterpolatePipe` cover parameterised strings.

## 7. Preview pipeline

Implemented in `core/previews`, dependency-free and portable across both runtimes.

### 7.1 Parsing

- **Binary STL** — 84-byte header then 50 bytes per triangle. Trivial.
- **ASCII STL** — line-oriented parser.
- **3MF** — a zip. Streaming `inflateRaw` via `node:zlib`, then a pull-style XML parse of
  `3D/3dmodel.model`. This **must** stream: one file measured in the reference library
  was 54 MB uncompressed, so a DOM parse is not viable.
- **Embedded-thumbnail fast path** — verified 2026-08-22: **all five slicers embed a
  usable thumbnail in their project files**, so a slicer project almost never needs
  rendering at all. Extract, downscale, record `source='embedded'`:

  | Slicer                  | Entry                    | Dimensions | Size       |
  | ----------------------- | ------------------------ | ---------- | ---------- |
  | Cura                    | `Metadata/thumbnail.png` | 300×300    | 18.8 KB    |
  | PrusaSlicer             | `Metadata/thumbnail.png` | 256×256    | 6.3 KB     |
  | Bambu / Orca / Anycubic | `Metadata/plate_1.png`   | 512×512    | 3.6–6.1 KB |

  For the Bambu lineage use `plate_1.png`, not its siblings: `plate_1_small.png` is
  128×128 (below the 256 target), `plate_no_light_1.png` is unlit, `top_1.png` is a
  top-down orthographic view, and `pick_1.png` is an object-picking mask rather than a
  visual.

  This reframes the pipeline. The earlier measurement — 63 of 401 Cura 3MFs carrying a
  thumbnail — was a statement about **old Cura versions**, not about slicer projects
  generally. In practice the extraction path covers essentially every project file from
  the four non-Cura slicers plus recent Cura. **The rasterizer is therefore needed for
  _model_ files, not _project_ files** — which is where the volume is anyway: 1,311 STLs
  against 401 3MFs in the reference library.

  Implementation order follows from that: extraction is cheap and covers all project
  files, so it lands first; the rasterizer is the expensive component and is only ever
  reached for `.stl`, `.obj`, and plain 3MF meshes.

- **OBJ** — 12 files in the reference library; low priority, `kind='model'` regardless.

### 7.2 Rendering

Triangle soup, then an isometric software rasterizer (z-buffer, flat shading, single
light), producing a 256x256 PNG. No GPU, no native dependency, identical output on both
runtimes.

PNG encoding is `node:zlib` deflate plus a hand-written chunk writer — roughly 60 lines,
no dependency.

Output goes to `.spm/previews/<file-id>.png`.

### 7.3 Queue

Bounded concurrency. The `attempts` counter ensures a malformed mesh fails a bounded
number of times instead of looping forever. `previews.source_hash` records the content
hash the preview was generated from, so an edited file regenerates and an untouched one
never does.

State machine: `pending -> ready | failed | unsupported`.

### 7.4 Interactive viewer

A lazy-loaded route chunk, because three.js is heavy. Uses `STLLoader` and
`ThreeMFLoader` against `FileDto.rawUrl`. Notably three.js ships both loaders, which the
.NET library survey could not offer together.

## 8. Testing and tooling

### 8.1 The test that matters most

`core`'s unit suite runs under **both Deno and Node in CI**. This is the direct test of
the design's central bet (2.2). If the core stops being runtime-agnostic, a red build
says so immediately rather than Electron breaking months later.

### 8.2 The rest

| Package    | Approach                                                       |
| ---------- | -------------------------------------------------------------- |
| `contract` | validator unit tests                                           |
| `core`     | unit tests, run on Deno and Node                               |
| `server`   | integration tests over HTTP against a temp library dir         |
| `web`      | Angular unit tests on Vitest; e2e via `@awdlab/jig-playwright` |
| `desktop`  | smoke test for IPC wiring and the `spm://` protocol            |

Reconciliation (3.5) deserves particular test attention: adopt, missing-folder,
changed-file, and dot-folder-skipping each get explicit cases against a temp directory.

### 8.3 Tooling

TypeScript strict, ESLint, Prettier, GitHub Actions — matching the CI setup recently
adopted for CuraManager.

Install **`@awdlab/jig-mcp`** for implementation sessions. jig ships an MCP documentation
server specifically so an agent can look up its 65+ controls rather than guess at APIs.

## 9. Extension points for specs B-E

| Subsystem           | Seam already in place                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **B** previews      | `previews` table, state machine, `thumbUrl` in DTOs, `core/previews` queue                                                                  |
| **C** Electron      | `IpcApiClient`, `protocol.handle('spm://')`, capability model, local/remote mode picker                                                     |
| **D** slicers       | `files.slicer` plus the 3MF flavour detector, machine-local slicer config (3.7), `canLaunchSlicer`, `/settings/slicers` route               |
| **E** model browser | `projects.website` for URL matching, `canBrowseModelSites`, `/browse` route, `files.upload` as the landing path for an intercepted download |

For **E** specifically, prior investigation established that Electron's
`session.on('will-download')` with `item.setSavePath()` does successfully intercept and
redirect downloads, and that the four major model sites (Thingiverse, Printables,
MakerWorld, Cults3D) all refuse third-party framing — so an embedded browser in the
desktop app is the only viable route, and the web build cannot offer this feature at all.
That is consistent with `canBrowseModelSites` being false in the browser column of 2.4.

**Amended 2026-08-28, against a measurement.** The conclusion stands and the reason given
for it was wrong. Both halves were re-tested on Electron 44.0.0 in one session, minutes
apart, against the same four URLs: as an `<iframe>` inside a page carrying no CSP of its
own **all four were refused**, and **all four of those same URLs loaded as top-level
`WebContentsView`s**. `X-Frame-Options` and `frame-ancestors` govern embedding _as a
frame_, and a `WebContentsView` is a separate top-level frame tree rather than a subframe,
so they do not apply to it. The sentence is therefore "**a `WebContentsView` is not a
frame**", not "the sites allow it" — which is what the paragraph above implies and what
would mislead the next reader. The practical conclusion is unchanged: a browser has
nothing but a frame to offer these sites, so the web build cannot do this and
`canBrowseModelSites` stays false in the browser column.

**What refused each one, since the obvious one-line summary misattributes half of them.**
Thingiverse's and Printables' framed requests were answered **403 by Cloudflare**, and the
`x-frame-options: SAMEORIGIN` on them is the **block page's** header — Thingiverse's real
top-level response for the same URL carried neither XFO nor CSP. Cults3D answered 200 with
`x-frame-options: SAMEORIGIN` and no CSP at all. MakerWorld answered 200 with **both**
`x-frame-options: SAMEORIGIN` **and** CSP `frame-ancestors 'none'`; naming only the CSP
for it is a second, smaller misattribution. So "these sites set XFO" is a true statement
about two of the four and a statement about Cloudflare's block page for the other two.
See subsystem E §1.3 and
`.superpowers/spikes/2026-08-28-model-browser-facts.md` §7.

## 10. Open questions

All four questions raised at design time were resolved on 2026-08-22. Recorded here with
their answers, since the reasoning matters for implementation.

1. ~~**i18n mechanism**~~ — **resolved**: `@ngneers/signal-translate` (6.4).
   `@angular/localize` rejected as build-time-only.
2. ~~**Anycubic Slicer Next 3MF marker**~~ — **resolved**: an `X-ACNext-Client-Type`
   header item inside `Metadata/slice_info.config` (3.4).
3. ~~**Bambu Studio versus OrcaSlicer discriminator**~~ — **resolved definitively** against
   real project files from all five slicers (3.4). Orca's `slice_info.config` header is a
   superset of Bambu's: both carry `X-BBL-Client-Type`, and Orca adds `OrcaSlicer-Version`,
   so the registry must test the Orca key first. Unidentifiable files report
   `slicer = null` rather than guessing.
4. ~~**Admin visibility**~~ — **resolved**: admins administer users only and never see
   other users' projects. Per-user disk usage and quotas were added instead (5.6), which
   gives admins the operational visibility they need without exposing project contents.

**No open questions remain.** Every design-time unknown has been settled against measured
evidence. The one residual assumption, flagged inline at 3.4 rather than here, is that
`slice_info.config` is written on slice rather than on save — which only affects whether
an unsliced project can name its slicer, and degrades to `slicer = null` rather than to a
wrong answer.
