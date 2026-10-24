import { activateAccount, ensureBootstrapAdmin, openLibrary } from '@spm/core'

const dir = Deno.args[0]
if (!dir) {
  console.error('usage: deno run -A e2e/seed.ts <libraryDir>')
  Deno.exit(1)
}

const lib = openLibrary(dir)
const boot = await ensureBootstrapAdmin(lib)
if (boot) await activateAccount(lib, boot.token, 'e2e test password', 'seed')
console.log('seeded')
