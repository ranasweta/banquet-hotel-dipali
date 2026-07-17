import 'server-only'
import { db, schema } from '@/db/drizzle'

/** A Drizzle db handle or a transaction handle — audit always runs inside the write's tx. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Who is making the change. Both fields are stamped on every audit row (FR-10.1). */
export type Actor = { id: string; roleName: string }

export type AuditEntry = {
  entity: string // table name
  entityId?: string | null
  field?: string | null
  oldValue?: string | null
  newValue?: string | null
  action: 'insert' | 'update' | 'delete' | 'status' | 'approval' | 'lock'
  eventId?: string | null // null for master-data changes (roles, users, …)
}

/**
 * Appends one or more rows to the append-only audit log (CLAUDE.md rule 5, FR-10.x).
 * Call inside the same transaction as the write it records, so the two commit together
 * — an unaudited write, or an audit row for a write that rolled back, is a bug.
 *
 * The audit_log table is guarded against UPDATE/DELETE at the database level; this only
 * ever inserts.
 */
export async function audit(
  tx: DbOrTx,
  actor: Actor,
  entries: AuditEntry | AuditEntry[],
): Promise<void> {
  const list = Array.isArray(entries) ? entries : [entries]
  if (list.length === 0) return
  await tx.insert(schema.auditLog).values(
    list.map((e) => ({
      entity: e.entity,
      entityId: e.entityId ?? null,
      eventId: e.eventId ?? null,
      field: e.field ?? null,
      oldValue: e.oldValue ?? null,
      newValue: e.newValue ?? null,
      action: e.action,
      userId: actor.id,
      roleName: actor.roleName,
    })),
  )
}

/**
 * Diffs two flat records and returns one field-level AuditEntry per changed field.
 * Keeps update handlers from hand-writing a row per column.
 */
export function diffEntries(
  base: Omit<AuditEntry, 'field' | 'oldValue' | 'newValue' | 'action'>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditEntry[] {
  const entries: AuditEntry[] = []
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      entries.push({
        ...base,
        action: 'update',
        field: key,
        oldValue: before[key] == null ? null : String(before[key]),
        newValue: after[key] == null ? null : String(after[key]),
      })
    }
  }
  return entries
}
