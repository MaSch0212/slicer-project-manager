import { timingSafeEqual } from './tokens.ts'

export const PW_ALGO = 'pbkdf2-sha256'
export const PW_ITERATIONS = 600_000
export const PW_SALT_BYTES = 16
export const PW_KEY_BITS = 256

export type PasswordHash = {
  hash: Uint8Array
  salt: Uint8Array
  iterations: number
  algo: string
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    // NFKC first: the same typed password must hash the same on every platform.
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    // Cast only: a plain `Uint8Array` widens to `ArrayBufferLike`, which the DOM lib's
    // `BufferSource` (correctly) does not accept; the bytes underneath are unchanged.
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    PW_KEY_BITS,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(
  password: string,
  iterations: number = PW_ITERATIONS,
): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(PW_SALT_BYTES))
  return { hash: await derive(password, salt, iterations), salt, iterations, algo: PW_ALGO }
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (stored.algo !== PW_ALGO) return false
  const candidate = await derive(password, stored.salt, stored.iterations)
  return timingSafeEqual(candidate, stored.hash)
}

/** True when the stored parameters are weaker than today's policy (spec 5.1). */
export function needsRehash(stored: { iterations: number; algo: string }): boolean {
  return stored.algo !== PW_ALGO || stored.iterations < PW_ITERATIONS
}
