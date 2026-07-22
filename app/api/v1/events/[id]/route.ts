import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { badRequest, conflict, notFound, ok, route } from '@/lib/api'
import { loadEventDetail } from '@/lib/events'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** GET /events/:id — full detail (children included). */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('bookings', 'view')
  const { id } = await ctx.params
  const detail = await loadEventDetail(id)
  if (!detail) throw notFound('Event not found')
  return ok({ event: detail })
})

const updateSchema = z
  .object({
    guest_name: z.string().trim().min(1).max(160).optional(),
    // The proposal's declared run (client, 22 Jul 2026): rooms are bounded by this window.
    from_date: z.string().regex(ISO_DATE).optional(),
    to_date: z.string().regex(ISO_DATE).optional(),
    contacts: z
      .array(z.object({
        // Indian mobile numbers are exactly 10 digits (client, 22 Jul 2026).
        phone: z.string().trim().regex(/^\d{10}$/, 'Enter a 10-digit mobile number'),
        label: z.string().max(40).optional(),
      }))
      .min(1)
      .max(6)
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' })
  .refine((v) => !v.from_date || !v.to_date || v.to_date >= v.from_date, {
    message: 'The To date cannot be before the From date',
  })

/**
 * PUT /events/:id — pre-confirm edits. Post-confirmation edits become change requests
 * (FR-1.9), which arrive in M8; here they are refused with a clear message.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const input = updateSchema.parse(await req.json())

  await db.transaction(async (tx) => {
    const [event] = await tx
      .select({
        status: schema.events.status,
        guestName: schema.events.guestName,
        eventType: schema.events.eventType,
        plannedFrom: schema.events.plannedFrom,
        plannedTo: schema.events.plannedTo,
      })
      .from(schema.events)
      .where(eq(schema.events.id, id))
      .for('update')
      .limit(1)
    if (!event) throw notFound('Event not found')
    if (event.status !== 'enquiry') {
      throw conflict('This event is confirmed. Post-confirmation changes need a change request (coming in M8).')
    }

    // Declared run window (client, 22 Jul 2026). Only written when it actually changes, so a
    // plain "save contacts" that resends the same dates records nothing.
    if (
      (input.from_date !== undefined && input.from_date !== event.plannedFrom) ||
      (input.to_date !== undefined && input.to_date !== event.plannedTo)
    ) {
      await tx
        .update(schema.events)
        .set({ plannedFrom: input.from_date, plannedTo: input.to_date, updatedAt: new Date().toISOString() })
        .where(eq(schema.events.id, id))
      await audit(tx, actor, {
        entity: 'events',
        entityId: id,
        eventId: id,
        action: 'update',
        field: 'planned_dates',
        oldValue: `${event.plannedFrom ?? '—'} → ${event.plannedTo ?? '—'}`,
        newValue: `${input.from_date ?? '—'} → ${input.to_date ?? '—'}`,
      })
    }

    if (input.guest_name && input.guest_name !== event.guestName) {
      await tx.update(schema.events).set({ guestName: input.guest_name, updatedAt: new Date().toISOString() }).where(eq(schema.events.id, id))
      await audit(tx, actor, {
        entity: 'events',
        entityId: id,
        eventId: id,
        action: 'update',
        field: 'guest_name',
        oldValue: event.guestName,
        newValue: input.guest_name,
      })
    }

    if (input.contacts) {
      const [et] = await tx
        .select({ contactNumbers: schema.eventTypes.contactNumbers })
        .from(schema.eventTypes)
        .where(eq(schema.eventTypes.code, event.eventType))
        .limit(1)
      const contacts = [...new Map(input.contacts.map((c) => [c.phone, c])).values()]
      if (contacts.length < (et?.contactNumbers ?? 1)) {
        throw badRequest(`${et?.contactNumbers ?? 1} contact number(s) required for this event type`)
      }
      await tx.delete(schema.eventContacts).where(eq(schema.eventContacts.eventId, id))
      await tx.insert(schema.eventContacts).values(
        contacts.map((c) => ({ eventId: id, phone: c.phone, label: c.label ?? null })),
      )
      await tx.update(schema.events).set({ updatedAt: new Date().toISOString() }).where(eq(schema.events.id, id))
      await audit(tx, actor, { entity: 'event_contacts', entityId: id, eventId: id, action: 'update', field: 'contacts', newValue: contacts.map((c) => c.phone).join(', ') })
    }
  })

  const detail = await loadEventDetail(id)
  return ok({ event: detail })
})
