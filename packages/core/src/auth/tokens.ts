/** base64url without padding, so a token is safe in a URL fragment and a cookie. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  // Cast only: a plain `Uint8Array` widens to `ArrayBufferLike`, which the DOM lib's
  // `BufferSource` (correctly) does not accept; the bytes underneath are unchanged.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))
}

/** Length-independent early exit, then constant time over the common length. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
