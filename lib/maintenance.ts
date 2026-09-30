import 'server-only'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, diffEntries, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api'

/**
 * Maintenance entries (M8, FR-5.x). The Maintenance team logs event-linked extra costs from
 * the moment a booking is CONFIRMED until its maintenance is closed — never on an enquiry,
 * never after lock (FR-5.1, amended 30 Sep 2026).
 *
 * The window used to open only when the event did, which assumed every maintenance cost is
 * incurred on the day. Plenty are not: a generator hired in, a marquee repaired, scaffolding
 * brought on site — all arranged and paid for in the run-up, and the team had nowhere to put
 * them until the morning of. An enquiry is still refused: it holds nothing and may never
 * happen, so there is no booking for the cost to belong to.
 *
 * Entries are editable by their creator (or the Auditor) until the Maintenance lead closes
 * the section; closure freezes them and is a lock-checklist item (FR-5.2), recorded as the
 * maintenance lock sign-off. Closed entries flow to the bill in M9 (FR-5.3).
 *
 * Closing keeps the narrower window it always had — see CLOSE_STATES. The payment schedule is
 * unaffected by the widening either way: maintenance is deliberately outside the 25% and the
 * wedding 50% (CLAUDE.md rule 12), so a cost logged before the event still reaches only the
 * settlement and the balance, and no threshold that has already fallen due can move.
 */

const OPEN_STATES = new Set(['confirmed', 'in_progress', 'completed'])
/**
 * Closing is NOT allowed as early as logging. The close means "nothing more is coming", which
 * cannot be true of an event that has not happened yet, and it is a one-way door — it freezes
 * every entry and there is no reopen. Closed on the day it was confirmed, a booking would lose
 * the whole of its on-the-day maintenance, silently, because the sign-off also makes the lock
 * checklist green. So the close keeps the window the event's other sign-offs have
 * (lib/lock.ts SIGNOFF_STATES): the event has at least started.
 */
const CLOSE_STATES = new Set(['in_progress', 'completed'])

function computeAmount(qty: number, ratePaise: number): number {
  return Math.round(qty * ratePaise)
}

type EventState = { status: string; closed: boolean }

async function loadEventState(exec: typeof db, eventId: string): Promise<EventState> {
  const [row] = (await exec.execute(sql`
    SELECT e.status,
           EXISTS (SELECT 1 FROM lock_signoffs s WHERE s.event_id = e.id AND s.designation = 'maintenance') AS closed
    FROM events e WHERE e.id = ${eventId}
  `)) as unknown as EventState[]
  if (!row) throw notFound('Event not found')
  return row
}

/** Maintenance is writable from Confirmed to Completed, and only before it's closed. */
function assertWritable(state: EventState): void {
  if (!OPEN_STATES.has(state.status)) {
    throw badRequest('Maintenance can be logged once a booking is confirmed, and only until it is locked.')
  }
  if (state.closed) throw conflict('Maintenance for this event is closed and can no longer change.')
}

export type MaintenanceInput = { item: string; qty: number; unit: string; ratePaise: number; remarks?: string; fileKey?: string }

export async function addEntry(actor: Actor, eventId: string, input: MaintenanceInput): Promise<{ id: string; amountPaise: number }> {
  if (input.qty <= 0) throw badRequest('Quantity must be positive')
  if (input.ratePaise < 0) throw badRequest('Rate cannot be negative')
  return db.transaction(async (tx) => {
    assertWritable(await loadEventState(tx, eventId))
    const amountPaise = computeAmount(input.qty, input.ratePaise)
    const [row] = await tx
      .insert(schema.maintenanceEntries)
      .values({
        eventId,
        item: input.item,
        qty: String(input.qty),
        unit: input.unit,
        ratePaise: input.ratePaise,
        amountPaise,
        remarks: input.remarks ?? null,
        fileKey: input.fileKey ?? null,
        createdBy: actor.id,
      })
      .returning({ id: schema.maintenanceEntries.id })
    await audit(tx, actor, { entity: 'maintenance_entries', entityId: row!.id, eventId, action: 'insert', field: 'item', newValue: `${input.item} — ${amountPaise}` })
    return { id: row!.id, amountPaise }
  })
}

export async function updateEntry(actor: Actor, entryId: string, patch: Partial<MaintenanceInput>): Promise<void> {
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(schema.maintenanceEntries).where(eq(schema.maintenanceEntries.id, entryId)).limit(1)
    if (!e) throw notFound('Entry not found')
    if (e.createdBy !== actor.id && actor.roleName !== 'auditor') throw forbidden('Only the entry’s author can edit it.')
    if (e.isClosed) throw conflict('This entry is closed and can no longer change.')
    assertWritable(await loadEventState(tx, e.eventId))

    const qty = patch.qty ?? Number(e.qty)
    const ratePaise = patch.ratePaise ?? e.ratePaise
    const before = { item: e.item, qty: e.qty, unit: e.unit, ratePaise: e.ratePaise, amountPaise: e.amountPaise, remarks: e.remarks }
    const after = {
      item: patch.item ?? e.item,
      qty: String(qty),
      unit: patch.unit ?? e.unit,
      ratePaise,
      amountPaise: computeAmount(qty, ratePaise),
      remarks: patch.remarks ?? e.remarks,
    }
    await tx.update(schema.maintenanceEntries).set(after).where(eq(schema.maintenanceEntries.id, entryId))
    await audit(tx, actor, diffEntries({ entity: 'maintenance_entries', entityId: entryId, eventId: e.eventId }, before, after))
  })
}

export async function deleteEntry(actor: Actor, entryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [e] = await tx.select({ id: schema.maintenanceEntries.id, eventId: schema.maintenanceEntries.eventId, createdBy: schema.maintenanceEntries.createdBy, isClosed: schema.maintenanceEntries.isClosed, item: schema.maintenanceEntries.item }).from(schema.maintenanceEntries).where(eq(schema.maintenanceEntries.id, entryId)).limit(1)
    if (!e) throw notFound('Entry not found')
    if (e.createdBy !== actor.id && actor.roleName !== 'auditor') throw forbidden('Only the entry’s author can remove it.')
    if (e.isClosed) throw conflict('This entry is closed and can no longer change.')
    assertWritable(await loadEventState(tx, e.eventId))
    await tx.delete(schema.maintenanceEntries).where(eq(schema.maintenanceEntries.id, entryId))
    await audit(tx, actor, { entity: 'maintenance_entries', entityId: entryId, eventId: e.eventId, action: 'delete', field: 'item', oldValue: e.item })
  })
}

/** Marks the event's maintenance section closed: freezes entries and records the sign-off. */
export async function closeMaintenance(actor: Actor, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const state = await loadEventState(tx, eventId)
    if (!CLOSE_STATES.has(state.status)) throw badRequest('Maintenance can be closed only once the event has started — until then more may still be logged.')
    if (state.closed) throw conflict('Maintenance for this event is already closed.')
    await tx.update(schema.maintenanceEntries).set({ isClosed: true }).where(eq(schema.maintenanceEntries.eventId, eventId))
    await tx.insert(schema.lockSignoffs).values({ eventId, designation: 'maintenance', signedBy: actor.id })
    await audit(tx, actor, { entity: 'lock_signoffs', entityId: eventId, eventId, action: 'lock', field: 'maintenance', newValue: 'closed' })
  })
}

export type MaintenanceView = {
  closed: boolean
  /** Whether the close is available yet — false on a confirmed booking that hasn't started. */
  canClose: boolean
  totalPaise: number
  entries: { id: string; item: string; qty: string; unit: string; ratePaise: number; amountPaise: number; remarks: string | null; hasAttachment: boolean; createdBy: string; isClosed: boolean }[]
}

export async function listEntries(eventId: string): Promise<MaintenanceView> {
  const state = await loadEventState(db, eventId)
  const rows = await db
    .select()
    .from(schema.maintenanceEntries)
    .where(eq(schema.maintenanceEntries.eventId, eventId))
    .orderBy(asc(schema.maintenanceEntries.createdAt))
  return {
    closed: state.closed,
    canClose: !state.closed && CLOSE_STATES.has(state.status),
    totalPaise: rows.reduce((s, r) => s + r.amountPaise, 0),
    entries: rows.map((r) => ({
      id: r.id, item: r.item, qty: r.qty, unit: r.unit, ratePaise: r.ratePaise, amountPaise: r.amountPaise,
      remarks: r.remarks, hasAttachment: Boolean(r.fileKey), createdBy: r.createdBy, isClosed: r.isClosed,
    })),
  }
}

/** Events the Maintenance team may act on: Confirmed, In Progress or Completed (FR-5.1). */
export async function listMaintenanceEvents(): Promise<{ id: string; code: string; guestName: string; status: string; firstDate: string | null; entryCount: number; closed: boolean }[]> {
  return (await db.execute(sql`
    SELECT e.id, e.code, e.guest_name AS "guestName", e.status::text AS status,
           -- From sub_events, not the events.first_date cache, which is written at confirm and
           -- goes stale the moment a function moves. Now that the list reaches forward to
           -- Confirmed bookings the date is how the team finds the right one, so a stale or
           -- NULL cache would show a wrong day, or sort the booking to the bottom as "date TBD".
           (SELECT min(se.event_date)::text FROM sub_events se WHERE se.event_id = e.id) AS "firstDate",
           (SELECT count(*)::int FROM maintenance_entries m WHERE m.event_id = e.id) AS "entryCount",
           EXISTS (SELECT 1 FROM lock_signoffs s WHERE s.event_id = e.id AND s.designation = 'maintenance') AS closed
    FROM events e
    WHERE e.status IN ('confirmed','in_progress','completed')
    -- ISO text sorts as the date does. NULLS LAST keeps a dateless booking off the top.
    ORDER BY "firstDate" NULLS LAST, e.code
  `)) as unknown as { id: string; code: string; guestName: string; status: string; firstDate: string | null; entryCount: number; closed: boolean }[]
}

/** The file_key of an entry's attachment, for a permission-checked download. */
export async function entryAttachmentKey(entryId: string): Promise<string | null> {
  const [e] = await db.select({ fileKey: schema.maintenanceEntries.fileKey }).from(schema.maintenanceEntries).where(eq(schema.maintenanceEntries.id, entryId)).limit(1)
  if (!e) throw notFound('Entry not found')
  return e.fileKey
}
