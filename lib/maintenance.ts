import 'server-only'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, diffEntries, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api'

/**
 * Maintenance entries (M8, FR-5.x). The Maintenance team logs event-linked extra costs while
 * an event is In Progress or Completed — never before it starts, never after lock (FR-5.1).
 * Entries are editable by their creator (or the Auditor) until the Maintenance lead closes
 * the section; closure freezes them and is a lock-checklist item (FR-5.2), recorded as the
 * maintenance lock sign-off. Closed entries flow to the bill in M9 (FR-5.3).
 */

const OPEN_STATES = new Set(['in_progress', 'completed'])

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

/** Maintenance is writable only while In Progress / Completed, and only before it's closed. */
function assertWritable(state: EventState): void {
  if (!OPEN_STATES.has(state.status)) {
    throw badRequest('Maintenance can be logged only while an event is In Progress or Completed.')
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
    if (!OPEN_STATES.has(state.status)) throw badRequest('Maintenance can be closed only for an In Progress or Completed event.')
    if (state.closed) throw conflict('Maintenance for this event is already closed.')
    await tx.update(schema.maintenanceEntries).set({ isClosed: true }).where(eq(schema.maintenanceEntries.eventId, eventId))
    await tx.insert(schema.lockSignoffs).values({ eventId, designation: 'maintenance', signedBy: actor.id })
    await audit(tx, actor, { entity: 'lock_signoffs', entityId: eventId, eventId, action: 'lock', field: 'maintenance', newValue: 'closed' })
  })
}

export type MaintenanceView = {
  closed: boolean
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
    totalPaise: rows.reduce((s, r) => s + r.amountPaise, 0),
    entries: rows.map((r) => ({
      id: r.id, item: r.item, qty: r.qty, unit: r.unit, ratePaise: r.ratePaise, amountPaise: r.amountPaise,
      remarks: r.remarks, hasAttachment: Boolean(r.fileKey), createdBy: r.createdBy, isClosed: r.isClosed,
    })),
  }
}

/** Events the Maintenance team may act on: In Progress or Completed (FR-5.1). */
export async function listMaintenanceEvents(): Promise<{ id: string; code: string; guestName: string; status: string; firstDate: string | null; entryCount: number; closed: boolean }[]> {
  return (await db.execute(sql`
    SELECT e.id, e.code, e.guest_name AS "guestName", e.status::text AS status, e.first_date::text AS "firstDate",
           (SELECT count(*)::int FROM maintenance_entries m WHERE m.event_id = e.id) AS "entryCount",
           EXISTS (SELECT 1 FROM lock_signoffs s WHERE s.event_id = e.id AND s.designation = 'maintenance') AS closed
    FROM events e
    WHERE e.status IN ('in_progress','completed')
    ORDER BY e.first_date NULLS LAST, e.code
  `)) as unknown as { id: string; code: string; guestName: string; status: string; firstDate: string | null; entryCount: number; closed: boolean }[]
}

/** The file_key of an entry's attachment, for a permission-checked download. */
export async function entryAttachmentKey(entryId: string): Promise<string | null> {
  const [e] = await db.select({ fileKey: schema.maintenanceEntries.fileKey }).from(schema.maintenanceEntries).where(eq(schema.maintenanceEntries.id, entryId)).limit(1)
  if (!e) throw notFound('Entry not found')
  return e.fileKey
}
