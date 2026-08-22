/** Opaque primary key. randomUUID exists on both runtimes' global crypto. */
export function newId(): string {
  return crypto.randomUUID()
}
