export const SESSION_COOKIE = 'spm_session'

export function readSessionToken(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return null
}

/** Secure is dropped only for a plain-http localhost origin, so dev over http still works. */
function isLocalHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

function attributes(url: URL, maxAge: number): string {
  const parts = [`Path=/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (!isLocalHttp(url)) parts.push('Secure')
  return parts.join('; ')
}

export function sessionSetCookie(token: string, expiresAt: number, url: URL): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${attributes(url, maxAge)}`
}

export function sessionClearCookie(url: URL): string {
  return `${SESSION_COOKIE}=; ${attributes(url, 0)}`
}
