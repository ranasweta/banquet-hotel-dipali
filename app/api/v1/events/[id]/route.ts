import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound, ok, route } from '@/lib/api'
import { loadEventDetail } from '@/lib/events'
import { canAuthorityEditConfirmed } from '@/lib/post-confirm'
import { recomputeProposalTotal } from '@/lib/pricing'

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
    // A mis-picked event type, corrected (client, 8 Sep 2026: "just in case we fill it
    // mistakenly"). Enquiry only — see the handler.
    event_type: z.string().trim().min(1).max(40).optional(),
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
    // Enquiries: anyone with create_edit. A confirmed booking: Higher Authority / Auditor may
    // edit guest / contacts / declared dates directly (tester, 23 Jul 2026) — none of these
    // touch venue holds. Everyone else, and any later status, still routes to change requests.
    if (event.status !== 'enquiry' && !canAuthorityEditConfirmed(event.status, actor)) {
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

    /**
     * The event type, which is a correction and not a re-negotiation.
     *
     * THE AUDITOR'S, AND NOBODY ELSE'S (client, 8 Sep 2026: "should be only given to the
     * auditor only … as he changes the pricing and all gets changed too"). It is not really a
     * field on a booking — it is the key every venue rate card is filed under (BR-R1), so
     * moving it re-prices every function on the proposal at once. That is the same authority
     * the Auditor already holds over the venue master, the menu master and the lodge master,
     * and it is why the Booking Manager who typed it cannot quietly change what the hall
     * costs by correcting his own mistake.
     *
     * ENQUIRY ONLY, and deliberately narrower than the guest name and the dates beside it.
     * Those were opened to the Authority on a confirmed booking because "none of these touch
     * venue holds"; the type does. On a confirmed booking the hall is already held at a rate
     * snapshotted from the OLD type, so re-typing it would leave the booking quoting one
     * figure and holding another — and the snapshot is what the guest's document was printed
     * from. Past confirmation this is a re-quote, not a typo, and belongs in the approvals
     * screen where the whole bill is in front of him.
     *
     * WHAT MOVES WITH IT, since the point is that everything stays connected:
     *   • every function's venue charge, off the new type's rate card, and with it
     *     `events.proposal_total_paise` — recomputed below rather than left to drift until
     *     something else happens to save;
     *   • the food surcharge and the wedding 50% milestone, both derived from the type on
     *     every read, so they follow with no work here;
     *   • the contact rule, which is NOT enforced here on purpose. Switching to `wedding`
     *     needs three numbers, and `confirmEvent` already refuses without them — blocking the
     *     correction itself would trap a booking mis-typed as an engagement with one contact
     *     in the wrong type for ever.
     */
    if (input.event_type && input.event_type !== event.eventType) {
      if (actor.roleName !== 'auditor') {
        throw forbidden('Only the Auditor can change a booking’s event type — it re-prices every function.')
      }
      if (event.status !== 'enquiry') {
        throw conflict('The event type can only be corrected while the booking is still an enquiry.')
      }
      const [type] = await tx
        .select({ code: schema.eventTypes.code })
        .from(schema.eventTypes)
        .where(eq(schema.eventTypes.code, input.event_type))
        .limit(1)
      if (!type) throw badRequest('That is not an event type on file.')

      await tx
        .update(schema.events)
        .set({ eventType: input.event_type, updatedAt: new Date().toISOString() })
        .where(eq(schema.events.id, id))
      await audit(tx, actor, {
        entity: 'events',
        entityId: id,
        eventId: id,
        action: 'update',
        field: 'event_type',
        oldValue: event.eventType,
        newValue: input.event_type,
      })
      // Rate cards are per event type, so the running total is stale the moment this changes.
      await recomputeProposalTotal(tx, id, input.event_type)
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
