/**
 * The migration entry point for spec 3.6: adopts an existing CuraManager library into a
 * Slicer Project Manager library owned by one user.
 *
 *     deno run -A packages/server/import-curamanager.ts <library-dir> <username> [--in-place]
 *
 * `core` has carried `importCuraManagerLibrary` (and its 8 tests) since task 12, but nothing
 * outside `core` called it — no route, no CLI, no UI — so the whole migration story shipped
 * unreachable. This is that caller. It is a script rather than an HTTP endpoint on purpose:
 * it renames directories on disk for a single named user, once, and wants no new
 * authenticated surface on the running server.
 *
 * A CuraManager library is flat: every project folder sits at the library root. By default
 * this moves them all under the target user's own folder, which is the layout the rest of
 * the app assumes. `--in-place` skips that move, for a library whose folders already sit
 * under the right user directory.
 *
 * The move is all-or-nothing: if any folder name already exists under the target user's
 * folder, `moveFlatLibraryIntoUserFolder` refuses the whole operation before renaming
 * anything, and this script reports the colliding names and exits non-zero. Nothing has
 * moved at that point, so the fix is to rename the collisions and run it again.
 */
import { AppError } from '@spm/contract/errors.ts'
import { closeLibrary, importCuraManagerLibrary, listUsers, openLibrary } from '@spm/core'

const USAGE =
  'usage: deno run -A packages/server/import-curamanager.ts <library-dir> <username> [--in-place]'

const inPlace = Deno.args.includes('--in-place')
const [libraryDir, username, ...extra] = Deno.args.filter((arg) => arg !== '--in-place')

async function run(dir: string, name: string): Promise<void> {
  const lib = openLibrary(dir)
  try {
    // A local operator running this script is above any in-app role, so the ctx used to
    // look the account up is a synthetic admin. The ctx handed to the import itself is the
    // target user's own — every project and tag it writes must be owned by them.
    const target = listUsers(lib, { userId: '', isAdmin: true }).find(
      (user) => user.username.toLowerCase() === name.toLowerCase(),
    )
    if (!target) {
      throw new AppError('NotFound', `no such user: ${name}. Create the account first.`)
    }

    const result = await importCuraManagerLibrary(
      lib,
      { userId: target.id, isAdmin: target.isAdmin },
      { moveIntoUserFolder: !inPlace },
    )

    console.log(`imported into "${target.username}":`)
    console.log(`  folders moved:    ${result.moved}`)
    console.log(`  projects adopted: ${result.rescan.adopted}`)
    console.log(`  files indexed:    ${result.rescan.filesAdded}`)
    console.log(`  sidecars applied: ${result.projectsUpdated}`)
    console.log(`  tags applied:     ${result.tagsApplied}`)
    console.log(`  marked missing:   ${result.rescan.markedMissing}`)
    console.log('Previews are queued; the server generates them on its next pass.')
  } finally {
    closeLibrary(lib)
  }
}

if (!libraryDir || !username || extra.length > 0) {
  console.error(USAGE)
  Deno.exit(1)
}

try {
  await run(libraryDir, username)
} catch (error) {
  // AppError is the expected refusal (an unknown user, a folder-name collision) and reads
  // as a message; anything else is a bug and keeps its stack.
  if (!(error instanceof AppError)) throw error
  console.error(`${error.code}: ${error.message}`)
  Deno.exit(1)
}
