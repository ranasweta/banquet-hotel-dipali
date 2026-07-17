import 'server-only'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { conflict, notFound } from '@/lib/api'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type EventStatus =
  | 'enquiry'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'locked'
  | 'billed'
  | 'closed'
  | 'cancelled'

/**
 * The only legal status moves (PRD §4.1). Cancellation is allowed from any pre-lock
 * state. Everything funnels through transitionEvent — never an ad-hoc status update
 * (CLAUDE.md rule 8).
 */
const ALLOWED: Record<EventStatus, EventStatus[]> = {
  enquiry: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['locked', 'cancelled'],
  locked: ['billed'],
  billed: ['closed'],
  closed: [],
  cancelled: [],
}

/**
 * Moves an event to `to`, validating the transition and stamping the audit trail. Runs
 * inside the caller's transaction. `extra` sets the timestamp/reason columns that go with
 * certain transitions (confirmed_at, cancelled_at + reason).
 */
export async function transitionEvent(
  tx: Tx,
  eventId: string,
  to: EventStatus,
  actor: Actor,
  extra: { reason?: string } = {},
): Promise<void> {
  const [event] = await tx
    .select({ status: schema.events.status })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1)
  if (!event) throw notFound('Event not found')

  const from = event.status as EventStatus
  if (from === to) return
  if (!ALLOWED[from].includes(to)) {
    throw conflict(`Cannot move an event from ${from} to ${to}`)
  }

  const patch: Record<string, unknown> = { status: to, updatedAt: new Date().toISOString() }
  if (to === 'confirmed') patch.confirmedAt = new Date().toISOString()
  if (to === 'cancelled') {
    patch.cancelledAt = new Date().toISOString()
    patch.cancelReason = extra.reason ?? null
  }

  await tx.update(schema.events).set(patch).where(eq(schema.events.id, eventId))
  await audit(tx, actor, {
    entity: 'events',
    entityId: eventId,
    eventId,
    action: 'status',
    field: 'status',
    oldValue: from,
    newValue: to,
  })
}

/** Assembles the full event detail the wizard and detail screen need. */
export async function loadEventDetail(eventId: string) {
  const [event] = await db
    .select({
      id: schema.events.id,
      code: schema.events.code,
      guestName: schema.events.guestName,
      eventType: schema.events.eventType,
      status: schema.events.status,
      firstDate: schema.events.firstDate,
      lastDate: schema.events.lastDate,
      proposalTotalPaise: schema.events.proposalTotalPaise,
      confirmedAt: schema.events.confirmedAt,
      createdAt: schema.events.createdAt,
    })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1)
  if (!event) return null

  const [contacts, subs, rooms, docs, payments] = await Promise.all([
    db
      .select({ phone: schema.eventContacts.phone, label: schema.eventContacts.label })
      .from(schema.eventContacts)
      .where(eq(schema.eventContacts.eventId, eventId)),
    db
      .select({
        id: schema.subEvents.id,
        name: schema.subEvents.name,
        eventDate: schema.subEvents.eventDate,
        startTime: schema.subEvents.startTime,
        endTime: schema.subEvents.endTime,
        venueId: schema.subEvents.venueId,
        bundleId: schema.subEvents.bundleId,
        pax: schema.subEvents.pax,
        venueRatePaise: schema.subEvents.venueRatePaise,
      })
      .from(schema.subEvents)
      .where(eq(schema.subEvents.eventId, eventId))
      .orderBy(schema.subEvents.eventDate, schema.subEvents.startTime),
    db
      .select({
        id: schema.roomRequirements.id,
        roomType: schema.roomRequirements.roomType,
        count: schema.roomRequirements.count,
        checkIn: schema.roomRequirements.checkIn,
        checkOut: schema.roomRequirements.checkOut,
      })
      .from(schema.roomRequirements)
      .where(eq(schema.roomRequirements.eventId, eventId)),
    db
      .select({ kind: schema.guestDocuments.kind, uploadedAt: schema.guestDocuments.uploadedAt })
      .from(schema.guestDocuments)
      .where(eq(schema.guestDocuments.eventId, eventId)),
    db
      .select({
        kind: schema.payments.kind,
        amountPaise: schema.payments.amountPaise,
        mode: schema.payments.mode,
        receiptNo: schema.payments.receiptNo,
        receivedOn: schema.payments.receivedOn,
      })
      .from(schema.payments)
      .where(eq(schema.payments.eventId, eventId)),
  ])

  return { ...event, contacts, subEvents: subs, roomRequirements: rooms, documents: docs, payments }
}
