/**
 * What a cancellation actually releases (PRD §4.1).
 *
 * The two holds a booking places are enforced by different machinery, so they are released
 * differently and both need proving:
 *
 *   venue  a `venue_bookings` row guarded by a GiST exclusion — a database rule that cannot
 *          consult event status, so the row must be DELETED or the window stays blocked;
 *   rooms  `room_requirements` rows counted by queries that join on event status, so they are
 *          simply FILTERED out and the rows survive.
 *
 * The venue half had no coverage until now because the logic lived inside the route handler
 * where nothing could call it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const events = await import('@/lib/events')
const roomsSvc = await import('@/lib/rooms')
const { occupancyParts } = await import('@/lib/occupancy')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping cancellation tests\n')

const bm = { id: '', roleName: 'booking_manager' }
const DATE = '2026-11-14'
const START = '19:00'
const END = '23:00'

async function idOf(table: 'venues' | 'lodgingUnits', name: string): Promise<string> {
  const t = table === 'venues' ? schema.venues : schema.lodgingUnits
  const [r] = await db.select({ id: t.id }).from(t).where(eq(t.name, name)).limit(1)
  return r!.id
}
async function userId(role: string): Promise<string> {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(eq(schema.roles.name, role)).limit(1)
  return u!.id
}

/** Books the venue window the way confirm does — one venue_bookings row per member venue. */
async function holdVenue(eventId: string, subEventId: string, venueId: string): Promise<void> {
  const { lowerDate, lowerTime, upperDate, upperTime } = occupancyParts(DATE, START, END)
  await db.execute(sql`
    INSERT INTO venue_bookings (venue_id, sub_event_id, event_id, occupancy)
    VALUES (${venueId}, ${subEventId}, ${eventId},
            tsrange((${lowerDate}::date + ${lowerTime}::time), (${upperDate}::date + ${upperTime}::time), '[)'))
  `)
}

/** A confirmed booking holding the Crystal window on DATE, plus 4 Regency deluxe rooms. */
async function confirmedBooking(): Promise<{ eventId: string; subId: string; venueId: string }> {
  const venueId = await idOf('venues', 'Crystal')
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Cancellation Test', eventType: 'engagement', status: 'confirmed', createdBy: bm.id, plannedFrom: DATE, plannedTo: '2026-11-16' })
    .returning({ id: schema.events.id })
  const [sub] = await db
    .insert(schema.subEvents)
    .values({ eventId: ev!.id, name: 'Reception', eventDate: DATE, startTime: START, endTime: END, venueId, pax: 150 })
    .returning({ id: schema.subEvents.id })
  await holdVenue(ev!.id, sub!.id, venueId)
  await db.insert(schema.roomRequirements).values({
    eventId: ev!.id, unitId: await idOf('lodgingUnits', 'Regency'), roomType: 'deluxe',
    count: 4, checkIn: DATE, checkOut: '2026-11-16',
  })
  return { eventId: ev!.id, subId: sub!.id, venueId }
}

/** Can somebody else take the same window? Returns false when the exclusion refuses. */
async function windowIsFree(venueId: string): Promise<boolean> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [rival] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Rival Booking', eventType: 'engagement', status: 'confirmed', createdBy: bm.id })
    .returning({ id: schema.events.id })
  const [sub] = await db
    .insert(schema.subEvents)
    .values({ eventId: rival!.id, name: 'Rival', eventDate: DATE, startTime: START, endTime: END, venueId, pax: 10 })
    .returning({ id: schema.subEvents.id })
  try {
    await holdVenue(rival!.id, sub!.id, venueId)
    return true
  } catch {
    return false
  } finally {
    // The hold has to go before the event it points at, or the foreign key refuses.
    await db.delete(schema.venueBookings).where(eq(schema.venueBookings.eventId, rival!.id))
    await db.delete(schema.events).where(eq(schema.events.id, rival!.id))
  }
}

async function deluxeAvailable(): Promise<number> {
  const [line] = await roomsSvc.getRoomAvailability([
    { unitId: await idOf('lodgingUnits', 'Regency'), roomType: 'deluxe', count: 1, checkIn: DATE, checkOut: '2026-11-16' },
  ])
  return line!.available
}

beforeAll(async () => {
  if (!hasDb) return
  const setup = createClient('TEST_DATABASE_URL')
  try {
    await migrate(setup, () => {})
    await seed(setup, { reset: true, force: true, password: 'test-only' }, () => {})
  } finally {
    await setup.end()
  }
  bm.id = await userId('booking_manager')
}, 900_000)

async function cleanup() {
  // Drop every fixture out of a locked state first. The immutability trigger guards
  // venue_bookings, so a test that left an event `locked` would otherwise block its own
  // teardown — and then block the next test's insert on the foreign key.
  await db.execute(sql`UPDATE events SET status = 'enquiry' WHERE status IN ('locked','billed','closed')`)
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('cancelling a confirmed booking', () => {
  it('frees the venue window for somebody else', async () => {
    const { eventId, venueId } = await confirmedBooking()
    // While it stands, the exclusion refuses the same window — that is the hold working.
    expect(await windowIsFree(venueId)).toBe(false)

    await events.cancelEvent(bm, eventId, 'Guest called off the wedding')

    expect(await windowIsFree(venueId)).toBe(true)
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM venue_bookings WHERE event_id = ${eventId}
    `)) as unknown as { n: number }[]
    expect(n).toBe(0)
  }, 300_000)

  it('releases the rooms back to the lodge', async () => {
    const before = await deluxeAvailable()
    const { eventId } = await confirmedBooking()
    expect(await deluxeAvailable()).toBe(before - 4)

    await events.cancelEvent(bm, eventId, 'Guest called off the wedding')
    expect(await deluxeAvailable()).toBe(before)
  }, 300_000)

  it('keeps the record: the function, the rooms and the reason all survive', async () => {
    // Releasing a hold is not erasing a booking. An advance may have been taken.
    const { eventId, subId } = await confirmedBooking()
    await events.cancelEvent(bm, eventId, 'Guest called off the wedding')

    const [ev] = (await db.execute(sql`
      SELECT status::text AS status, cancel_reason AS "reason", cancelled_at IS NOT NULL AS stamped
        FROM events WHERE id = ${eventId}
    `)) as unknown as { status: string; reason: string; stamped: boolean }[]
    expect(ev!.status).toBe('cancelled')
    expect(ev!.reason).toBe('Guest called off the wedding')
    expect(ev!.stamped).toBe(true)

    const [{ subs }] = (await db.execute(sql`SELECT count(*)::int AS subs FROM sub_events WHERE id = ${subId}`)) as unknown as { subs: number }[]
    const [{ rooms }] = (await db.execute(sql`SELECT count(*)::int AS rooms FROM room_requirements WHERE event_id = ${eventId}`)) as unknown as { rooms: number }[]
    expect(subs).toBe(1)
    expect(rooms).toBe(1) // kept, but no longer counted — see deluxeAvailable above
  }, 300_000)

  it('is audited', async () => {
    const { eventId } = await confirmedBooking()
    await events.cancelEvent(bm, eventId, 'Double booking on our side')
    const rows = (await db.execute(sql`
      SELECT old_value AS "from", new_value AS "to" FROM audit_log
       WHERE event_id = ${eventId} AND entity = 'events' AND field = 'status'
    `)) as unknown as { from: string; to: string }[]
    expect(rows.some((r) => r.from === 'confirmed' && r.to === 'cancelled')).toBe(true)
  }, 300_000)
})

d('what cancellation refuses', () => {
  it('needs a reason', async () => {
    const { eventId } = await confirmedBooking()
    await expect(events.cancelEvent(bm, eventId, '   ')).rejects.toMatchObject({ status: 400 })
  }, 300_000)

  it('will not cancel a LOCKED booking — by then it is a billing matter', async () => {
    const { eventId, venueId } = await confirmedBooking()
    await db.update(schema.events).set({ status: 'locked' }).where(eq(schema.events.id, eventId))

    await expect(events.cancelEvent(bm, eventId, 'too late')).rejects.toMatchObject({ status: 409 })
    // And the refusal is total: the venue is still held, because the whole thing rolled back.
    expect(await windowIsFree(venueId)).toBe(false)
  }, 300_000)

  it('cancelling twice is a harmless no-op, and the FIRST reason stands', async () => {
    // `transitionEvent` returns early when the status is already the target, so a repeated
    // cancel does not error — a double-click, or two people reaching for it at once, is not
    // a failure worth showing anyone. What matters is that it changes nothing: the recorded
    // reason stays the one given when the booking was actually called off.
    const { eventId } = await confirmedBooking()
    await events.cancelEvent(bm, eventId, 'Guest called off the wedding')
    await expect(events.cancelEvent(bm, eventId, 'second attempt')).resolves.toEqual({ ok: true })

    const [ev] = (await db.execute(sql`
      SELECT cancel_reason AS "reason" FROM events WHERE id = ${eventId}
    `)) as unknown as { reason: string }[]
    expect(ev!.reason).toBe('Guest called off the wedding')

    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE event_id = ${eventId} AND field = 'status' AND new_value = 'cancelled'
    `)) as unknown as { n: number }[]
    expect(n).toBe(1) // one cancellation in the trail, not two
  }, 300_000)
})
