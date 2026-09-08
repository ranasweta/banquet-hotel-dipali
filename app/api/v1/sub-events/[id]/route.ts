import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit, diffEntries } from '@/lib/audit'
import { conflict, notFound, ok, route } from '@/lib/api'
import { subEventSchema } from '@/app/api/v1/events/[id]/sub-events/route'
import { canAuthorityEditConfirmed, removeConfirmedFunction } from '@/lib/post-confirm'
import { recomputeProposalTotal } from '@/lib/pricing'
import { applyGmProposalEdits } from '@/lib/gm-authority'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function loadEditableSub(subId: string, exec: typeof db | Tx = db) {
  const [sub] = await exec
    .select({
      id: schema.subEvents.id,
      eventId: schema.subEvents.eventId,
      status: schema.events.status,
      eventType: schema.events.eventType,
      name: schema.subEvents.name,
      eventDate: schema.subEvents.eventDate,
      startTime: schema.subEvents.startTime,
      endTime: schema.subEvents.endTime,
      venueId: schema.subEvents.venueId,
      bundleId: schema.subEvents.bundleId,
      pax: schema.subEvents.pax,
    })
    .from(schema.subEvents)
    .innerJoin(schema.events, eq(schema.events.id, schema.subEvents.eventId))
    .where(eq(schema.subEvents.id, subId))
    .limit(1)
  if (!sub) throw notFound('Sub-event not found')
  return sub
}

/**
 * PUT /sub-events/:id — edit a function on an enquiry: its name, date, time, venue or pax.
 *
 * The route existed from M3 but nothing called it — the only way to change a function's venue
 * was to delete it and add it again, which threw away the menu with it (client, 15 Aug 2026).
 * The booking page edits in place through this now.
 *
 * IT RECOMPUTES THE PROPOSAL TOTAL, which the original did not. Venue and pax are both priced
 * — the venue by its rate card, the pax by `pax × per-plate` — so an edit that did not
 * recompute left `proposal_total_paise` quoting the old figure until something else happened to
 * save a menu. That was invisible while nothing called this; it would not be now.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const input = subEventSchema.parse(await req.json())

  const total = await db.transaction(async (tx) => {
    const sub = await loadEditableSub(id, tx)

    /**
     * A CONFIRMED booking is the Authority's to edit here, exactly as an enquiry is (client,
     * 8 Sep 2026: "an auditor can edit any confirmed booking same as enquiry").
     *
     * It is not the same WRITE, though, and that is the whole point of routing rather than
     * relaxing the guard. An enquiry holds no `venue_bookings` — they are written at confirm —
     * so moving its date, venue or time moves nothing and can clash with nothing, and the plain
     * UPDATE below is honest. A confirmed function is a HELD SLOT: moving it has to release the
     * old window and take the new one, under the GiST exclusion, or the calendar and the booking
     * part company. `applyGmProposalEdits` already does exactly that (it is what the approvals
     * screen calls), so this hands over to it rather than growing a second copy that could
     * drift. It also re-checks the Authority role, audits field by field, recomputes the total
     * and — past billing — re-issues the guest's document.
     *
     * Everyone else still meets the old refusal: a held slot is not a Booking Manager's to move.
     */
    if (sub.status !== 'enquiry') {
      if (!canAuthorityEditConfirmed(sub.status, actor)) {
        throw conflict('This booking is confirmed. Changing a function needs a change request.')
      }
      await applyGmProposalEdits(tx, actor, sub.eventId, {
        functions: [
          {
            id,
            name: input.name,
            eventDate: input.event_date,
            startTime: input.start_time,
            endTime: input.end_time,
            venueId: input.venue_id ?? null,
            bundleId: input.bundle_id ?? null,
            pax: input.pax,
          },
        ],
      })
      const [ev] = await tx
        .select({ total: schema.events.proposalTotalPaise })
        .from(schema.events)
        .where(eq(schema.events.id, sub.eventId))
        .limit(1)
      return Number(ev?.total ?? 0)
    }

    const after = {
      name: input.name,
      eventDate: input.event_date,
      startTime: input.start_time,
      endTime: input.end_time,
      venueId: input.venue_id ?? null,
      bundleId: input.bundle_id ?? null,
      pax: input.pax,
    }
    await tx.update(schema.subEvents).set(after).where(eq(schema.subEvents.id, id))

    // Field by field, so the trail says what actually moved rather than "the function changed".
    // `startTime`/`endTime` come back from the driver as HH:MM:SS and the input is HH:MM, so
    // they are compared on the first five characters or every save would look like a change.
    const before = {
      name: sub.name,
      eventDate: sub.eventDate,
      startTime: String(sub.startTime).slice(0, 5),
      endTime: String(sub.endTime).slice(0, 5),
      venueId: sub.venueId,
      bundleId: sub.bundleId,
      pax: sub.pax,
    }
    await audit(
      tx,
      actor,
      diffEntries({ entity: 'sub_events', entityId: id, eventId: sub.eventId }, before, after),
    )
    return recomputeProposalTotal(tx, sub.eventId, sub.eventType)
  })

  return ok({ subEvent: { id }, proposalTotalPaise: total })
})

/**
 * DELETE /sub-events/:id — remove a function. Enquiries: anyone with create_edit. A confirmed
 * booking: Higher Authority / Auditor only, via removeConfirmedFunction (which frees the venue
 * holds and recomputes totals). Everyone else on a confirmed booking is sent to change requests.
 */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params

  const [sub] = await db
    .select({ eventId: schema.subEvents.eventId, status: schema.events.status })
    .from(schema.subEvents)
    .innerJoin(schema.events, eq(schema.events.id, schema.subEvents.eventId))
    .where(eq(schema.subEvents.id, id))
    .limit(1)
  if (!sub) throw notFound('Sub-event not found')

  if (canAuthorityEditConfirmed(sub.status, actor)) {
    await removeConfirmedFunction(actor, id)
    return ok({ ok: true })
  }
  if (sub.status !== 'enquiry') {
    throw conflict('This event is confirmed. Changing sub-events needs a change request (coming in M8).')
  }

  await db.delete(schema.subEvents).where(eq(schema.subEvents.id, id))
  await audit(db, actor, { entity: 'sub_events', entityId: id, eventId: sub.eventId, action: 'delete', field: 'name' })
  return ok({ ok: true })
})
