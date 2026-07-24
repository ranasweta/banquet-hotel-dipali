/**
 * Post-confirm function editing by the Higher Authority / Auditor (tester, 23 Jul 2026).
 *
 * A confirmed booking already holds its venue slots, so these edits must keep venue_bookings in
 * step. Verifies against the test DB, driving the service directly:
 *   - an authority ADD inserts the sub-event AND its venue hold, and recomputes the total;
 *   - the add is overlap-checked (BR-C1) — it can't double-book a venue window;
 *   - a non-authority actor is refused on a confirmed booking;
 *   - an authority REMOVE frees the hold (cascade) and won't drop the last function.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const { confirmEvent } = await import('@/lib/confirm')
const { addConfirmedFunction, removeConfirmedFunction } = await import('@/lib/post-confirm')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')
const { ApiError } = await import('@/lib/api')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping post-confirm-edit tests\n')

const booking = { id: '', roleName: 'booking_manager' }
const authority = { id: '', roleName: 'higher_authority' }
let venueId: Record<string, string> = {}
let receiptCounter = 0

async function venue(name: string): Promise<string> {
  if (!venueId[name]) {
    const [v] = await db.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.name, name)).limit(1)
    venueId[name] = v!.id
  }
  return venueId[name]!
}

function advance(amountPaise: number) {
  receiptCounter += 1
  return { amountPaise, mode: 'upi', receiptNo: `RCPT-${Date.now() % 100000}-${receiptCounter}`, receivedOn: '2026-08-01' }
}

/** A confirmed wedding at Crystal, 2026-09-01 11:00–15:00. Returns its id. */
async function makeConfirmed(): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [event] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Crystal Party', eventType: 'wedding', createdBy: booking.id })
    .returning({ id: schema.events.id })
  const eventId = event!.id
  await db.insert(schema.eventContacts).values(
    Array.from({ length: 3 }, (_, i) => ({ eventId, phone: `90000${String(i).padStart(3, '0')}${eventId.slice(0, 4)}`, label: i === 0 ? 'primary' : null })),
  )
  await db.insert(schema.subEvents).values({
    eventId, name: 'Wedding', eventDate: '2026-09-01', startTime: '11:00', endTime: '15:00', venueId: await venue('Crystal'), pax: 300,
  })
  await confirmEvent(booking, eventId, advance(4_000_000))
  return eventId
}

async function counts(eventId: string): Promise<{ subs: number; bookings: number; total: number }> {
  const [s] = (await db.execute(sql`SELECT count(*)::int AS n FROM sub_events WHERE event_id = ${eventId}`)) as unknown as { n: number }[]
  const [b] = (await db.execute(sql`SELECT count(*)::int AS n FROM venue_bookings WHERE event_id = ${eventId}`)) as unknown as { n: number }[]
  const [e] = await db.select({ total: schema.events.proposalTotalPaise }).from(schema.events).where(eq(schema.events.id, eventId))
  return { subs: s!.n, bookings: b!.n, total: Number(e!.total) }
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
  const roleUser = async (role: string) => {
    const [u] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
      .where(eq(schema.roles.name, role))
      .limit(1)
    return u!.id
  }
  booking.id = await roleUser('booking_manager')
  authority.id = await roleUser('higher_authority')
  venueId = {}
}, 90_000)

afterEach(async () => {
  if (!hasDb) return
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
})

afterAll(async () => {
  if (!hasDb) return
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
})

d('post-confirm function editing (Authority)', () => {
  it('adds a function to a confirmed booking, blocking its venue window and recomputing the total', async () => {
    const id = await makeConfirmed()
    const before = await counts(id)
    expect(before).toMatchObject({ subs: 1, bookings: 1 })

    await addConfirmedFunction(authority, id, {
      name: 'Reception', eventDate: '2026-09-01', startTime: '18:00', endTime: '22:00', venueId: await venue('Signature'), pax: 300,
    })

    const after = await counts(id)
    expect(after.subs).toBe(2)
    expect(after.bookings).toBe(2) // the new function holds its own venue slot
    expect(after.total).toBeGreaterThan(before.total) // total recomputed with the new venue + food
  })

  it('refuses an add that overlaps an existing venue hold (BR-C1)', async () => {
    const id = await makeConfirmed()
    // Same venue (Crystal) and an overlapping window as the event's own Wedding (11:00–15:00).
    await expect(
      addConfirmedFunction(authority, id, {
        name: 'Clash', eventDate: '2026-09-01', startTime: '12:00', endTime: '14:00', venueId: await venue('Crystal'), pax: 100,
      }),
    ).rejects.toMatchObject({ status: 409 })
    // Nothing partial left behind: still one function, one hold.
    expect(await counts(id)).toMatchObject({ subs: 1, bookings: 1 })
  })

  it('refuses a non-authority actor on a confirmed booking', async () => {
    const id = await makeConfirmed()
    await expect(
      addConfirmedFunction(booking, id, {
        name: 'Nope', eventDate: '2026-09-02', startTime: '10:00', endTime: '12:00', venueId: await venue('Signature'), pax: 100,
      }),
    ).rejects.toBeInstanceOf(ApiError)
    expect(await counts(id)).toMatchObject({ subs: 1, bookings: 1 })
  })

  it('removes a function and frees its hold, but keeps at least one', async () => {
    const id = await makeConfirmed()
    const { id: subId } = await addConfirmedFunction(authority, id, {
      name: 'Reception', eventDate: '2026-09-01', startTime: '18:00', endTime: '22:00', venueId: await venue('Signature'), pax: 300,
    })
    expect(await counts(id)).toMatchObject({ subs: 2, bookings: 2 })

    await removeConfirmedFunction(authority, subId)
    expect(await counts(id)).toMatchObject({ subs: 1, bookings: 1 }) // hold gone via cascade

    // Removing the last remaining function is refused — cancel the booking instead.
    const [remaining] = await db.select({ id: schema.subEvents.id }).from(schema.subEvents).where(eq(schema.subEvents.eventId, id)).limit(1)
    await expect(removeConfirmedFunction(authority, remaining!.id)).rejects.toMatchObject({ status: 400 })
  })
})
