import type { Db } from '../db/open.ts'

const USAGE_SQL = `SELECT p.owner_id AS ownerId, COALESCE(SUM(f.size_bytes), 0) AS bytes
                   FROM files f JOIN projects p ON p.id = f.project_id
                   WHERE p.state = 'ok'
                   GROUP BY p.owner_id`

export function diskUsageBytes(db: Db, userId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(f.size_bytes), 0) AS bytes
       FROM files f JOIN projects p ON p.id = f.project_id
       WHERE p.state = 'ok' AND p.owner_id = ?`,
    )
    .get(userId) as { bytes: number }
  return Number(row.bytes)
}

export function diskUsageByUser(db: Db): Map<string, number> {
  const rows = db.prepare(USAGE_SQL).all() as { ownerId: string; bytes: number }[]
  return new Map(rows.map((r) => [r.ownerId, Number(r.bytes)]))
}
