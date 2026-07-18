import 'server-only'
import { sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api'
import { transitionEvent } from '@/lib/events'
import { draftInvoice } from '@/lib/invoice'

/**
 * Lock checklist, sign-offs and the lock transaction (M9, FR-7.1/7.2). Lock is the terminal
 * editing state: the Auditor may lock only a Completed event with every checklist item green,
 * and the lock freezes the record (the DB trigger + service guards enforce immutability) and
 * drafts the consolidated invoice in the same transaction.
 */

const SIGNOFF_STATES = new Set(['in_progress', 'completed'])
type Designation = 'banquet_manager' | 'lodge_manager' | 'maintenance' | 'booking_manager'
const DESIGNATIONS = new Set<Designation>(['banquet_manager', 'lodge_manager', 'maintenance', 'booking_manager'])

export type ChecklistItem = { key: string; label: string; done: boolean; blocking: boolean }
export type Checklist = { status: string; canLock: boolean; hasRooms: boolean; items: ChecklistItem[] }

/** Computes the lock-checklist item states for an event (FR-7.1). */
export async function lockChecklist(eventId: string): Promise<Checklist> {
  const [row] = (await db.execute(sql`
    SELECT e.status::text AS status,
      (SELECT count(*)::int FROM sub_events WHERE event_id = e.id) AS "subCount",
      (SELECT count(*)::int FROM sub_events se JOIN sub_event_menus m ON m.sub_event_id = se.id WHERE se.event_id = e.id AND m.is_complete) AS "menuComplete",
      (SELECT count(*)::int FROM exceptions WHERE event_id = e.id AND status = 'pending') AS "pendingExc",
      (SELECT count(*)::int FROM change_requests WHERE event_id = e.id AND status = 'pending') AS "pendingCr",
      EXISTS (SELECT 1 FROM lock_signoffs WHERE event_id = e.id AND designation = 'banquet_manager') AS banquet,
      EXISTS (SELECT 1 FROM lock_signoffs WHERE event_id = e.id AND designation = 'lodge_manager') AS lodge,
      EXISTS (SELECT 1 FROM lock_signoffs WHERE event_id = e.id AND designation = 'maintenance') AS maint,
      (EXISTS (SELECT 1 FROM room_requirements WHERE event_id = e.id) OR EXISTS (SELECT 1 FROM room_allocations WHERE event_id = e.id)) AS "hasRooms",
      COALESCE((SELECT sum(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) FROM payments WHERE event_id = e.id), 0)::bigint AS paid
    FROM events e WHERE e.id = ${eventId}
  `)) as unknown as {
    status: string; subCount: number; menuComplete: number; pendingExc: number; pendingCr: number
    banquet: boolean; lodge: boolean; maint: boolean; hasRooms: boolean; paid: number
  }[]
  if (!row) throw notFound('Event not found')

  const items: ChecklistItem[] = [
    { key: 'menus', label: 'All function menus complete', done: row.subCount > 0 && row.menuComplete === row.subCount, blocking: true },
    { key: 'exceptions', label: 'No approvals pending', done: row.pendingExc === 0, blocking: true },
    { key: 'changes', label: 'No change requests pending', done: row.pendingCr === 0, blocking: true },
    { key: 'banquet', label: 'Banquet Manager day-sheet sign-off', done: row.banquet, blocking: true },
    { key: 'lodge', label: 'Lodge Manager rooms reconciliation sign-off', done: !row.hasRooms || row.lodge, blocking: true },
    { key: 'maintenance', label: 'Maintenance closed', done: row.maint, blocking: true },
    { key: 'payments', label: 'Advance / payments recorded', done: Number(row.paid) > 0, blocking: true },
  ]
  const canLock = row.status === 'completed' && items.every((i) => !i.blocking || i.done)
  return { status: row.status, canLock, hasRooms: row.hasRooms, items }
}

/** Records a lock sign-off for a designation (its holder, or the Auditor). Idempotent. */
export async function signoff(actor: Actor, eventId: string, designation: string): Promise<void> {
  if (!DESIGNATIONS.has(designation as Designation)) throw badRequest('Unknown sign-off designation')
  if (actor.roleName !== designation && actor.roleName !== 'auditor') {
    throw forbidden(`Only the ${designation.replace(/_/g, ' ')} (or Auditor) can give this sign-off.`)
  }
  const [ev] = await db.select({ status: schema.events.status }).from(schema.events).where(sql`id = ${eventId}`).limit(1)
  if (!ev) throw notFound('Event not found')
  if (!SIGNOFF_STATES.has(ev.status)) throw badRequest('Sign-offs are recorded while the event is In Progress or Completed.')

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO lock_signoffs (event_id, designation, signed_by)
      VALUES (${eventId}, ${designation}::signoff_role, ${actor.id})
      ON CONFLICT (event_id, designation) DO UPDATE SET signed_by = ${actor.id}, signed_at = now()
    `)
    await audit(tx, actor, { entity: 'lock_signoffs', entityId: eventId, eventId, action: 'lock', field: designation, newValue: 'signed' })
  })
}

/** Locks a Completed event whose checklist is green and drafts its invoice (Auditor only). */
export async function lockEvent(actor: Actor, eventId: string): Promise<{ locked: true }> {
  if (actor.roleName !== 'auditor') throw forbidden('Only the Auditor may lock an event (FR-7.2).')
  return db.transaction(async (tx) => {
    const [ev] = await tx.select({ status: schema.events.status }).from(schema.events).where(sql`id = ${eventId}`).for('update').limit(1)
    if (!ev) throw notFound('Event not found')
    if (ev.status === 'locked' || ev.status === 'billed' || ev.status === 'closed') throw conflict(`This event is already ${ev.status}.`)
    if (ev.status !== 'completed') throw conflict('Only a Completed event can be locked.')

    const checklist = await lockChecklist(eventId)
    const blockers = checklist.items.filter((i) => i.blocking && !i.done)
    if (blockers.length > 0) throw conflict(`Cannot lock — pending: ${blockers.map((b) => b.label).join('; ')}.`)

    await tx.update(schema.events).set({ lockedAt: new Date().toISOString(), lockedBy: actor.id }).where(sql`id = ${eventId}`)
    await transitionEvent(tx, eventId, 'locked', actor)
    await draftInvoice(tx, actor, eventId)
    return { locked: true }
  })
}
