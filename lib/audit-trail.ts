import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'

/**
 * Audit trail (M9, FR-10.x). Every event-related write appended an immutable row (the audit
 * helper); here we read them back per event as a chronological, filterable timeline and
 * export to CSV. The log is append-only at the DB level (no update/delete, ever — FR-10.3).
 */

export type TrailRow = {
  seq: number
  at: string
  action: string
  entity: string
  field: string | null
  oldValue: string | null
  newValue: string | null
  userName: string
  roleName: string
}

export type TrailFilter = { userId?: string; entity?: string; from?: string; to?: string }

export async function getTrail(eventId: string, filter: TrailFilter = {}): Promise<TrailRow[]> {
  const conds = [sql`a.event_id = ${eventId}`]
  if (filter.userId) conds.push(sql`a.user_id = ${filter.userId}`)
  if (filter.entity) conds.push(sql`a.entity = ${filter.entity}`)
  if (filter.from) conds.push(sql`a.at >= ${filter.from}::timestamptz`)
  if (filter.to) conds.push(sql`a.at < (${filter.to}::date + 1)`)
  return (await db.execute(sql`
    SELECT a.seq, a.at, a.action, a.entity, a.field, a.old_value AS "oldValue", a.new_value AS "newValue",
           u.full_name AS "userName", a.role_name AS "roleName"
    FROM audit_log a JOIN users u ON u.id = a.user_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY a.seq
  `)) as unknown as TrailRow[]
}

/** The distinct entities touched on an event — drives the trail's entity filter. */
export async function trailEntities(eventId: string): Promise<string[]> {
  const rows = (await db.execute(sql`SELECT DISTINCT entity FROM audit_log WHERE event_id = ${eventId} ORDER BY entity`)) as unknown as { entity: string }[]
  return rows.map((r) => r.entity)
}

const csvCell = (v: string | null): string => {
  const s = v ?? ''
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function trailCsv(rows: TrailRow[]): string {
  const header = ['seq', 'at', 'action', 'entity', 'field', 'old_value', 'new_value', 'user', 'role']
  const lines = rows.map((r) => [String(r.seq), r.at, r.action, r.entity, r.field, r.oldValue, r.newValue, r.userName, r.roleName].map(csvCell).join(','))
  return [header.join(','), ...lines].join('\n')
}
