import { DatabaseSync } from 'node:sqlite'
import { assert, test } from './harness.ts'

test('node:sqlite is present and round-trips a BLOB', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, payload BLOB NOT NULL)')
  db.prepare('INSERT INTO t (id, payload) VALUES (?, ?)').run('a', new Uint8Array([1, 2, 3]))
  const row = db.prepare('SELECT payload FROM t WHERE id = ?').get('a') as { payload: Uint8Array }
  assert.deepEqual([...row.payload], [1, 2, 3])
  db.close()
})

test('node:sqlite enforces foreign keys once the pragma is on', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)')
  db.exec(
    'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE)',
  )
  assert.throws(() => db.prepare('INSERT INTO child VALUES (?, ?)').run('c', 'nope'))
  db.close()
})

test('crypto.subtle derives a 32-byte PBKDF2-SHA256 key', async () => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('correct horse'),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(16), iterations: 1000, hash: 'SHA-256' },
    key,
    256,
  )
  assert.equal(new Uint8Array(bits).byteLength, 32)
})
