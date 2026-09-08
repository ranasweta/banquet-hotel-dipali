import type { NextRequest } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound, ok, route } from '@/lib/api'
import { loadEventDetail } from '@/lib/events'
import { canAuthorityEditConfirmed } from '@/lib/post-confirm'
import { loadSubEventsForPricing, priceProposal, recomputeProposalTotal } from '@/lib/pricing'
import { formatPaise } from '@/lib/money'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The statuses whose event type is beyond correcting. Everything up to the lock is fair game
 * for the Auditor (client's lead, 8 Sep 2026); from the lock on, the guest holds a numbered
 * document priced from it and the change is a re-issue, not an edit (CLAUDE.md rule 6).
 *
 * A backstop, kept deliberately though the route's own status guard above reaches these first:
 * the day somebody widens `canAuthorityEditConfirmed`, the thing that must not silently follow
 * is a re-price of an invoiced booking.
 */
const TYPE_LOCKED_STATES = new Set(['locked', 'billed', 'closed'])

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
     * A CONFIRMED BOOKING TOO (client's lead, 8 Sep 2026, overruling the enquiry-only limit
     * this shipped with). The objection was real and is answered rather than waived: a
     * confirmed function's `venue_rate_paise` is FROZEN from the old type's rate card, so
     * moving the type without touching it would leave the booking quoting one figure and
     * holding another. Every function is therefore re-snapshotted off the new type's card in
     * this same transaction, through `priceProposal` so the venue-day carrier rule (rule 3)
     * still decides which function pays for the hall.
     *
     * Two things that follow from re-pricing a booking that is already held:
     *   • A MISSING RATE CARD REFUSES THE CHANGE. BR-R1 says a missing rate is a gate and
     *     never a zero, and on a held booking there is no later gate to catch it — confirm
     *     has already happened. The functions are named in the error so the Auditor can add
     *     the card in the venue master and come back. (An ENQUIRY is left permissive: nothing
     *     is held, and `confirmEvent` still gates it.)
     *   • THE 25% CAN GO SHORT. The advance was measured against the old type's total; if
     *     the new one is dearer the booking is behind its milestone the moment this saves.
     *     Nothing blocks on that — it is the same debt-not-gate rule as BR-P1 — and it shows
     *     on the Billing panel, so the audit row below states the old and new totals to make
     *     the jump traceable.
     *
     * STILL REFUSED FROM `locked` ONWARD, for everyone. There the guest holds a numbered
     * document printed from these figures, and changing them is `reissueInvoice`'s job under
     * the Authority's override (rule 6) — a supersede-and-renumber, not a correction.
     *
     * WHAT MOVES WITH IT, since the point is that everything stays connected:
     *   • every function's venue charge, off the new type's rate card — re-snapshotted on a
     *     held booking, and live on an enquiry — and with it `events.proposal_total_paise`;
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
      if (TYPE_LOCKED_STATES.has(event.status)) {
        throw conflict(
          `This booking is ${event.status} and the guest holds a document priced from its event type. ` +
            'Change it from the approvals screen, which supersedes that document and issues a new version.',
        )
      }
      const [type] = await tx
        .select({ code: schema.eventTypes.code, isWedding: schema.eventTypes.isWedding })
        .from(schema.eventTypes)
        .where(eq(schema.eventTypes.code, input.event_type))
        .limit(1)
      if (!type) throw badRequest('That is not an event type on file.')

      const before = await tx
        .select({ total: schema.events.proposalTotalPaise })
        .from(schema.events)
        .where(eq(schema.events.id, id))
        .limit(1)

      await tx
        .update(schema.events)
        .set({ eventType: input.event_type, updatedAt: new Date().toISOString() })
        .where(eq(schema.events.id, id))

      // A held booking carries frozen venue rates; re-cut them from the new type's cards or
      // the change is cosmetic and the hall goes on charging the old type's price.
      if (event.status !== 'enquiry') {
        const subs = await loadSubEventsForPricing(id, tx)
        const priced = await priceProposal(input.event_type, subs, tx)
        if (priced.missing.length > 0) {
          throw badRequest(
            `${input.event_type} has no rate card for ${priced.missing.map((m) => m.name).join(', ')}. ` +
              'Add it in the venue master first — a held booking cannot be left unpriced (BR-R1).',
          )
        }
        for (const sub of subs) {
          await tx
            .update(schema.subEvents)
            .set({ venueRatePaise: priced.rates.get(sub.id) ?? 0 })
            .where(eq(schema.subEvents.id, sub.id))
        }
      }

      /**
       * The plate surcharge, which is the other half of the money the type decides.
       *
       * `sub_event_menus.surcharge_paise` is snapshotted when the menu is SAVED, from
       * `menu_tier_prices.wedding_surcharge_paise` if the event was a wedding and 0 if it was
       * not (lib/menus.ts). Nothing re-reads it afterwards — correctly, since a snapshot is
       * the point — so a type change left every plate carrying the old type's surcharge:
       * ₹50 a head on every tier in the seed, which is ₹20,000 on a 400-pax reception, wrong
       * in whichever direction the type moved and invisible on every screen.
       *
       * Only the surcharge is re-cut. `base_rate_paise` stays exactly as it was snapshotted:
       * that is the tier's price on the day the menu was chosen and has nothing to do with the
       * event type, and re-reading it here would silently re-price the food for an unrelated
       * reason. This runs for an enquiry too — the snapshot is just as wrong there.
       */
      await tx.execute(sql`
        UPDATE sub_event_menus m
           SET surcharge_paise = ${type.isWedding ? sql`COALESCE((
                 SELECT p.wedding_surcharge_paise FROM menu_tier_prices p
                  WHERE p.tier_id = m.tier_id AND p.effective_from <= se.event_date
                  ORDER BY p.effective_from DESC LIMIT 1), 0)` : sql`0`}
          FROM sub_events se
         WHERE se.id = m.sub_event_id AND se.event_id = ${id}
      `)

      // Rate cards are per event type, so the running total is stale the moment this changes.
      // After the surcharge above, which it reads.
      const total = await recomputeProposalTotal(tx, id, input.event_type)
      await audit(tx, actor, {
        entity: 'events',
        entityId: id,
        eventId: id,
        action: 'update',
        field: 'event_type',
        oldValue: `${event.eventType} (${formatPaise(Number(before[0]?.total ?? 0))})`,
        newValue: `${input.event_type} (${formatPaise(total)})`,
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
