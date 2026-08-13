import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound, ApiError } from '@/lib/api'
import { percentOfPaise } from '@/lib/money'
import { occupancyParts } from '@/lib/occupancy'
import { loadSubEventsForPricing, priceProposal } from '@/lib/pricing'
import { discountCap } from '@/lib/discounts'
import { transitionEvent } from '@/lib/events'
import { ADVANCE_PCT, payableBreakdown } from '@/lib/payment-schedule'
import { AUTHORITY_ROLES } from '@/lib/post-confirm'

export type AdvancePayment = {
  amountPaise: number
  mode: string
  receiptNo: string
  receivedOn: string // YYYY-MM-DD
}

/** Postgres exclusion-violation code — a venue window clash on venue_bookings. */
const EXCLUSION_VIOLATION = '23P01'
const UNIQUE_VIOLATION = '23505'

/**
 * The Postgres SQLSTATE, unwrapping Drizzle's error wrapper. Drizzle raises a
 * DrizzleQueryError whose `.cause` is the original postgres.js error carrying `.code`, so
 * a bare `err.code` check would miss the exclusion/unique violations.
 */
function pgCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && typeof (cur as { code: unknown }).code === 'string') {
      return (cur as { code: string }).code
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * THE confirm transaction (FR-1.7, BR-P1). In ONE transaction it:
 *   1. locks the event and requires it to be an enquiry;
 *   2. checks the guest name, the contact count for the event type (3 for weddings),
 *      and at least one sub-event (Aadhaar is optional now — added later from the booking page);
 *   3. prices the proposal from rate cards, refusing if any venue has no rate (BR-R1);
 *   4. records the advance and requires SOME money against a receipt — see below;
 *   5. inserts one venue_bookings row per venue window — the GiST exclusion makes a slot
 *      clash impossible, so exactly one of two racing confirms wins and the other 409s;
 *   6. snapshots venue rates, sets the proposal total and dates, and moves the event to
 *      confirmed.
 * Any failure rolls the whole thing back — no partial confirmation.
 *
 * THE 25% IS A DEBT NOW, NOT A GATE (client's lead, 4 Aug 2026). A guest who brings ₹1 lakh
 * against a ₹3 lakh advance used to be turned away with a 402 and the dates left open for
 * anyone. The hotel's answer is to take the money and hold the dates: the booking confirms,
 * blocks its venues like any other, and carries the shortfall as **Downpayment due** — on the
 * calendar, on the booking, and in the audit trail. What is still refused is a hold for
 * nothing: an advance of zero, or one with no receipt number, blocks no dates at all.
 *
 * The shortfall is deliberately given no timer. Chasing it is a phone call, not a cron: when a
 * second guest wants the same venue, the Booking Manager sees the marker on the calendar and
 * rings the GM, who has the authority to cancel (lib/events.ts, cancelEvent).
 */
export async function confirmEvent(
  actor: Actor,
  eventId: string,
  advance?: AdvancePayment,
): Promise<{
  id: string
  code: string
  proposalTotalPaise: number
  /** Still owed on the 25%. Zero when the advance was paid in full; the caller says so. */
  advanceShortfallPaise: number
  advanceRequiredPaise: number
}> {
  try {
    return await db.transaction(async (tx) => {
      // 1. Lock the event row so a double confirm serialises.
      const [event] = await tx
        .select({
          id: schema.events.id,
          code: schema.events.code,
          status: schema.events.status,
          guestName: schema.events.guestName,
          eventType: schema.events.eventType,
        })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .for('update')
        .limit(1)
      if (!event) throw notFound('Event not found')
      if (event.status !== 'enquiry') {
        throw conflict(`This event is already ${event.status} — only an enquiry can be confirmed`)
      }
      if (!event.guestName.trim()) throw badRequest('A guest name is required to confirm')

      // 2a. Contacts (FR-1.11): weddings need 3, others 1.
      const [et] = await tx
        .select({ contactNumbers: schema.eventTypes.contactNumbers })
        .from(schema.eventTypes)
        .where(eq(schema.eventTypes.code, event.eventType))
        .limit(1)
      const need = et?.contactNumbers ?? 1
      const [{ n: contactCount }] = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM event_contacts WHERE event_id = ${eventId}
      `)) as unknown as { n: number }[]
      if (contactCount < need) {
        throw badRequest(`${need} contact number${need > 1 ? 's are' : ' is'} required to confirm`)
      }

      // 2b. Aadhaar is no longer required to confirm (client, 22 Jul 2026): KYC images can be
      //     captured later from the booking's page. The block that demanded aadhaar_front +
      //     aadhaar_back here was removed so a date can be held on the advance alone. This
      //     relaxes the old FR-1.10 gate — see docs/SEED_ASSUMPTIONS.md.

      // 2c. At least one sub-event.
      const subs = await loadSubEventsForPricing(eventId, tx)
      if (subs.length === 0) throw badRequest('Add at least one sub-event before confirming')

      // 3. Price the proposal; a venue with no rate card is a gate (BR-R1). Food and
      //    add-ons from any menu already saved this enquiry fold into the total, so the
      //    25% advance covers them too (nil when menus were deferred — the common case).
      const pricing = await priceProposal(event.eventType, subs, tx)
      if (pricing.missing.length > 0) {
        const names = pricing.missing.map((m) => m.name).join(', ')
        throw badRequest(
          `No rate is defined for: ${names}. An Authority-approved manual rate is needed before confirming (BR-R1).`,
        )
      }

      // 3a. A fixed-rupee discount cannot shrink with the bill the way a percentage did, so a
      //     function removed after one was given can push the combined total over the cap with
      //     nothing noticing. Confirm is the last gate before the money is committed, so the
      //     test `addDiscount` applies at entry runs once more here — the same `discountCap`,
      //     never a second opinion. It does not bind the Higher Authority, on this screen as
      //     on every other (FR-11.3a).
      if (!AUTHORITY_ROLES.has(actor.roleName)) {
        const cap = await discountCap(eventId, tx)
        if (cap.usedPaise > cap.capPaise) {
          const rupees = (n: number) => `₹${(n / 100).toLocaleString('en-IN')}`
          throw badRequest(
            `The combined discount is now ${rupees(cap.usedPaise)}, over the ${cap.capPct}% cap of ${rupees(cap.capPaise)} — the bill has changed since it was given. Reduce it, or ask the Higher Authority (BR-D2).`,
          )
        }
      }

      // 3b. BR-L2: 35+ rooms need the Authority first. Rooms are booked in bulk on the
      //     proposal now, so this is the gate that matters — confirm is the moment those
      //     rooms start occupying the lodging calendar. Approving the request clears it.
      const [{ pending }] = (await tx.execute(sql`
        SELECT count(*)::int AS pending FROM exceptions
        WHERE event_id = ${eventId} AND kind = 'room_allocation_35plus' AND status = 'pending'
      `)) as unknown as { pending: number }[]
      if (pending > 0) {
        throw badRequest(
          'This proposal takes 35 or more rooms, which needs Higher Authority approval before the dates can be blocked (BR-L2).',
        )
      }

      // 4. Record the advance, then require that SOME of it arrived.
      if (advance) {
        try {
          await tx.insert(schema.payments).values({
            eventId,
            kind: 'advance_block',
            amountPaise: advance.amountPaise,
            mode: advance.mode,
            receiptNo: advance.receiptNo,
            receivedOn: advance.receivedOn,
            recordedBy: actor.id,
          })
        } catch (err) {
          if (pgCode(err) === UNIQUE_VIOLATION) {
            throw conflict(`Receipt number ${advance.receiptNo} is already recorded`)
          }
          throw err
        }
        await audit(tx, actor, {
          entity: 'payments',
          eventId,
          action: 'insert',
          field: 'advance_block',
          newValue: String(advance.amountPaise),
        })
      }

      // The payable amount and everything received against it, from the one module that owns
      // that arithmetic. The 18% GST is not in it: it is printed on the document and collected
      // from nobody, so it can play no part in what a quarter comes to (client's lead, 4 Aug
      // 2026). Rooms and their 5% ARE in it (client, 20 Jul 2026).
      const bill = await payableBreakdown(eventId, tx)
      const proposalTotal = bill.proposalPaise
      // The PRE-EVENT base: maintenance is billed but cannot raise an advance that falls due
      // now, before a single entry exists (client, 11 Aug 2026).
      const required = percentOfPaise(bill.preEventPayablePaise, ADVANCE_PCT)
      const paid = bill.paidPaise
      const rupees = (n: number) => `₹${(n / 100).toLocaleString('en-IN')}`

      // Nothing at all still blocks nothing at all. A date is held against money, and the
      // receipt number is how the hotel proves it arrived (BR-P1, FR-11.4).
      if (paid <= 0) {
        throw new ApiError(
          402,
          'advance_required',
          `An advance must be recorded to block the dates. The full ${ADVANCE_PCT}% comes to ${rupees(required)} on a payable total of ${rupees(bill.preEventPayablePaise)}${
            bill.roomsPaise > 0
              ? ` (venue, food and add-ons ${rupees(proposalTotal)} plus rooms ${rupees(bill.roomsPaise + bill.roomsTaxPaise)} including 5% GST)`
              : ''
          }; a part payment is accepted and the rest is carried as due.`,
        )
      }

      // Short is allowed and is not an error — but it is a fact worth being able to point at
      // later, so it goes in the audit trail beside the payment that caused it.
      const advanceShortfallPaise = Math.max(0, required - paid)
      if (advanceShortfallPaise > 0) {
        await audit(tx, actor, {
          entity: 'events',
          entityId: eventId,
          eventId,
          action: 'update',
          field: 'advance_shortfall',
          oldValue: rupees(required),
          newValue: `${rupees(paid)} received — ${rupees(advanceShortfallPaise)} still due`,
        })
      }

      // 5. Block every venue window atomically. The exclusion constraint decides races.
      for (const sub of subs) {
        const full = await tx
          .select({
            eventDate: schema.subEvents.eventDate,
            startTime: schema.subEvents.startTime,
            endTime: schema.subEvents.endTime,
          })
          .from(schema.subEvents)
          .where(eq(schema.subEvents.id, sub.id))
          .limit(1)
        const { eventDate, startTime, endTime } = full[0]!
        const { lowerDate, lowerTime, upperDate, upperTime } = occupancyParts(
          eventDate,
          startTime,
          endTime,
        )

        // Resolve target venues: a bundle's members, or the single venue.
        const venueIds = sub.bundleId
          ? (
              await tx
                .select({ venueId: schema.venueBundleMembers.venueId })
                .from(schema.venueBundleMembers)
                .where(eq(schema.venueBundleMembers.bundleId, sub.bundleId))
            ).map((r) => r.venueId)
          : [sub.venueId!]

        for (const venueId of venueIds) {
          await tx.execute(sql`
            INSERT INTO venue_bookings (venue_id, sub_event_id, event_id, occupancy)
            VALUES (${venueId}, ${sub.id}, ${eventId},
                    tsrange((${lowerDate}::date + ${lowerTime}::time),
                            (${upperDate}::date + ${upperTime}::time), '[)'))
          `)
        }

        // 6a. Snapshot the venue rate onto the sub-event.
        await tx
          .update(schema.subEvents)
          .set({ venueRatePaise: pricing.rates.get(sub.id) ?? 0 })
          .where(eq(schema.subEvents.id, sub.id))
      }

      // 6a-ii. Freeze the ROOM rates too (client, 13 Aug 2026: "yes freeze the room rates at
      // confirm like venues"). Until now a room charge was recomputed from the live rack rate
      // on every read, so re-pricing a category in the lodge master moved bookings that had
      // already been quoted — a guest promised 27 deluxe at 4,500 could be billed at 5,200
      // with nothing on the booking to explain it.
      //
      // The lodge's own rate for the category, exactly as `roomsEstimate` prices it: the
      // proposal names the lodge (21 Jul 2026), and the cheapest-across-lodges fallback is
      // only for rows captured before it asked. A category with no active room prices at
      // nothing and is left NULL rather than frozen at zero — a zero here would be a promise
      // of free rooms, where NULL simply goes on reading live.
      await tx.execute(sql`
        UPDATE room_requirements rr
           SET rate_paise = (
             SELECT min(r.rack_rate_paise) FROM rooms r
              WHERE r.room_type = rr.room_type AND r.is_active
                AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)
           )
         WHERE rr.event_id = ${eventId}
      `)

      // 6b. Proposal total + derived dates, then move to confirmed (via the state machine).
      const dates = subs.map((s) => s.eventDate).sort()
      await tx
        .update(schema.events)
        .set({
          proposalTotalPaise: proposalTotal,
          firstDate: dates[0],
          lastDate: dates[dates.length - 1],
        })
        .where(eq(schema.events.id, eventId))

      await transitionEvent(tx, eventId, 'confirmed', actor)

      return {
        id: event.id,
        code: event.code,
        proposalTotalPaise: proposalTotal,
        advanceShortfallPaise,
        advanceRequiredPaise: required,
      }
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      // A racing confirm won this slot between our check and our insert.
      throw conflict(
        'One or more of these venue slots was just taken by another confirmed booking. Please pick a different time or venue.',
      )
    }
    throw err
  }
}
