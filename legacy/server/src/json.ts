import { AppError } from '@spm/contract/errors.ts'
import type { StandardSchemaV1 } from './standard-schema.ts'

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  })
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

/** Validates with the same schema the Angular form uses (spec 2.3). */
export async function parseJson<T>(req: Request, schema: StandardSchemaV1<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new AppError('Validation', 'request body is not valid JSON')
  }
  const result = await schema['~standard'].validate(raw)
  if (result.issues) {
    throw new AppError('Validation', 'request body failed validation', { issues: result.issues })
  }
  return result.value
}
