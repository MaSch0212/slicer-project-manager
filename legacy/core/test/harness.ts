import assert from 'node:assert/strict'

export type TestBody = () => void | Promise<void>
export type TestFn = (name: string, body: TestBody) => void

type DenoTestOptions = {
  name: string
  fn: TestBody
  sanitizeResources: boolean
  sanitizeOps: boolean
}
type DenoGlobal = { test: (options: DenoTestOptions) => void }

const deno = (globalThis as { Deno?: DenoGlobal }).Deno

export const test: TestFn = deno
  ? (name, body) => deno.test({ name, fn: body, sanitizeResources: false, sanitizeOps: false })
  : ((await import('node:test')).test as unknown as TestFn)

export { assert }
