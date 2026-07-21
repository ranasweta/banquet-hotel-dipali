import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound, ApiError } from '@/lib/api'
import { percentOfPaise } from '@/lib/money'
import { occupancyParts } from '@/lib/occupancy'
import { foodAndAddonTotal, loadSubEventsForPricing, priceProposal, roomEstimatePaise } from '@/lib/pricing'
import { transitionEvent } from '@/lib/events'

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
 *      Aadhaar front+back on file, and at least one sub-event;
 *   3. prices the proposal from rate cards, refusing if any venue has no rate (BR-R1);
 *   4. records the advance (if supplied) and requires recorded advance ≥ 25%;
 *   5. inserts one venue_bookings row per venue window — the GiST exclusion makes a slot
 *      clash impossible, so exactly one of two racing confirms wins and the other 409s;
 *   6. snapshots venue rates, sets the proposal total and dates, and moves the event to
 *      confirmed.
 * Any failure rolls the whole thing back — no partial confirmation.
 */
export async function confirmEvent(
  actor: Actor,
  eventId: string,
  advance?: AdvancePayment,
): Promise<{ id: string; code: string; proposalTotalPaise: number }> {
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

      // 2b. Aadhaar front + back on file (FR-1.10).
      const docs = await tx
        .select({ kind: schema.guestDocuments.kind })
        .from(schema.guestDocuments)
        .where(
          and(
            eq(schema.guestDocuments.eventId, eventId),
            inArray(schema.guestDocuments.kind, ['aadhaar_front', 'aadhaar_back']),
          ),
        )
      const kinds = new Set(docs.map((d) => d.kind))
      if (!kinds.has('aadhaar_front') || !kinds.has('aadhaar_back')) {
        throw badRequest('Aadhaar front and back images must be on file to confirm')
      }

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
      const extras = await foodAndAddonTotal(eventId, tx)
      const proposalTotal = pricing.totalPaise + extras.foodPaise + extras.addonPaise
      // Rooms count toward the advance (client, 20 Jul 2026) but stay OUT of
      // proposal_total_paise, which BR-D2's 10% discount cap is measured against.
      const roomEst = await roomEstimatePaise(eventId, tx)
      const advanceBase = proposalTotal + roomEst.roomsPaise + roomEst.roomsTaxPaise

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

      // 4. Record the advance, then require recorded advance ≥ 25% of the proposal.
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

      const [{ paid }] = (await tx.execute(sql`
        SELECT COALESCE(sum(amount_paise), 0)::bigint AS paid
        FROM payments WHERE event_id = ${eventId} AND kind = 'advance_block'
      `)) as unknown as { paid: number }[]
      const required = percentOfPaise(advanceBase, 25)
      if (paid < required) {
        const rupees = (n: number) => `₹${(n / 100).toLocaleString('en-IN')}`
        const roomsPart = advanceBase > proposalTotal
          ? ` (venue, food and add-ons ${rupees(proposalTotal)} plus rooms ${rupees(roomEst.roomsPaise + roomEst.roomsTaxPaise)} including 5% tax)`
          : ''
        throw new ApiError(
          402,
          'advance_required',
          `A 25% advance is required to block the dates: ${rupees(required)} on a total of ${rupees(advanceBase)}${roomsPart}. Recorded so far: ${rupees(paid)}.`,
        )
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

      return { id: event.id, code: event.code, proposalTotalPaise: proposalTotal }
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
