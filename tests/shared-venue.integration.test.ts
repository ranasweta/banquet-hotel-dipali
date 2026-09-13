/**
 * An all-day live counter may share a hall with the booking's OWN functions (client,
 * 13 Sep 2026), and nothing else may.
 *
 * Two bookings could not be confirmed — E-1093 and E-1128, both weddings carrying a
 * `Hi-Tea Live Counter-15k for 12 Hours.` function inside their own breakfast, in the hall the
 * breakfast was in. The venue exclusion refused the second hold and `confirmEvent` reported it
 * as "another confirmed booking just took this slot", which was nobody's booking but their own.
 *
 * What this pins:
 *   - two ORDINARY functions of one booking still cannot overlap in one venue, and the refusal
 *     now names both of them instead of blaming a booking that does not exist;
 *   - a function on a `shares_venue` tier may sit inside them, and its hold is written;
 *   - that exemption stops at the booking: a sharing function still cannot take a window
 *     ANOTHER booking holds. Two parties in one hall is what BR-C1 exists to prevent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const { confirmEvent } = await import('@/lib/confirm')
const { findSiblingClashes } = await import('@/lib/availability')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')
const { ApiError } = await import('@/lib/api')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping shared-venue tests\n')

const booking = { id: '', roleName: 'booking_manager' }
let hall = ''
let otherHall = ''
let plainTier = ''
let sharingTier = ''
let receipts = 0

/** A venue with an `engagement` rate card, so confirm never meets the BR-R1 gate. */
async function ratedVenue(skip: number): Promise<string> {
  const [row] = (await db.execute(sql`
    SELECT v.id FROM venues v
    JOIN venue_rate_cards rc ON rc.venue_id = v.id AND rc.event_type = 'engagement'
    WHERE v.is_active ORDER BY v.name OFFSET ${skip} LIMIT 1
  `)) as unknown as { id: string }[]
  return row!.id
}

function advance(amountPaise: number) {
  receipts += 1
  return { amountPaise, mode: 'upi', receiptNo: `SV-${Date.now() % 100000}-${receipts}`, receivedOn: '2027-01-01' }
}

async function makeEvent(): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Counter Test', eventType: 'engagement', createdBy: booking.id })
    .returning({ id: schema.events.id })
  await db.insert(schema.eventContacts).values({ eventId: ev!.id, phone: `9${String(Date.now()).slice(-9)}`, label: 'primary' })
  return ev!.id
}

/** A function, with a menu on `tierId` so the sharing flag has something to read. */
async function addFunction(
  eventId: string,
  name: string,
  startTime: string,
  endTime: string,
  venueId: string,
  tierId: string,
): Promise<string> {
  const [se] = await db
    .insert(schema.subEvents)
    .values({ eventId, name, eventDate: '2027-11-20', startTime, endTime, venueId, pax: 100 })
    .returning({ id: schema.subEvents.id })
  await db.insert(schema.subEventMenus).values({
    subEventId: se!.id,
    tierId,
    tierName: 'snapshot',
    baseRatePaise: 30000,
    surchargePaise: 0,
  })
  return se!.id
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
  const [u] = (await db.execute(sql`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'booking_manager' LIMIT 1
  `)) as unknown as { id: string }[]
  booking.id = u!.id
  hall = await ratedVenue(0)
  otherHall = await ratedVenue(1)

  const [plain] = await db.select({ id: schema.menuTiers.id }).from(schema.menuTiers).where(eq(schema.menuTiers.name, 'Silver')).limit(1)
  plainTier = plain!.id
  const [counter] = await db
    .insert(schema.menuTiers)
    .values({ name: 'Test Live Counter', sharesVenue: true })
    .returning({ id: schema.menuTiers.id })
  sharingTier = counter!.id
}, 120_000)

async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => {
  if (!hasDb) return
  await cleanup()
  await db.delete(schema.menuTiers).where(eq(schema.menuTiers.id, sharingTier))
})

d('a booking clashing with itself', () => {
  it('refuses two ordinary functions overlapping in one hall, and names them', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'BREAKFAST', '08:00', '22:00', hall, plainTier)
    await addFunction(eventId, 'DINNER', '19:00', '23:00', hall, plainTier)

    const err = await confirmEvent(booking, eventId, advance(1_000_000)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const message = (err as InstanceType<typeof ApiError>).message
    expect(message).toContain('BREAKFAST')
    expect(message).toContain('DINNER')
    expect(message).not.toContain('another confirmed booking')

    // Nothing was held and nothing was confirmed — the whole transaction rolled back.
    const [{ n }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM venue_bookings WHERE event_id = ${eventId}`,
    )) as unknown as { n: number }[]
    expect(n).toBe(0)
  })

  it('lets a sharing tier sit inside another function of the same booking', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'BREAKFAST', '08:00', '10:00', hall, plainTier)
    await addFunction(eventId, 'TEA COUNTER', '08:59', '09:00', hall, sharingTier)

    expect(await findSiblingClashes(eventId)).toHaveLength(0)
    const result = await confirmEvent(booking, eventId, advance(1_000_000))
    expect(result.id).toBe(eventId)

    // Both functions hold the hall, and the counter's row carries the flag.
    const rows = (await db.execute(sql`
      SELECT shares_venue AS "sharesVenue" FROM venue_bookings WHERE event_id = ${eventId} ORDER BY shares_venue
    `)) as unknown as { sharesVenue: boolean }[]
    expect(rows.map((r) => r.sharesVenue)).toEqual([false, true])
  })

  it('still refuses two ordinary functions when a sharing one is also present', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'LUNCH', '12:00', '16:00', hall, plainTier)
    await addFunction(eventId, 'HITEA', '15:00', '18:00', hall, plainTier)
    await addFunction(eventId, 'TEA COUNTER', '09:00', '21:00', hall, sharingTier)

    const clashes = await findSiblingClashes(eventId)
    expect(clashes).toHaveLength(1)
    expect([clashes[0]!.aName, clashes[0]!.bName].sort()).toEqual(['HITEA', 'LUNCH'])
  })
})

d('the exemption stops at the booking', () => {
  it('refuses a sharing function in a window another booking holds', async () => {
    const held = await makeEvent()
    await addFunction(held, 'RECEPTION', '18:00', '23:00', otherHall, plainTier)
    await confirmEvent(booking, held, advance(1_000_000))

    const second = await makeEvent()
    await addFunction(second, 'TEA COUNTER', '09:00', '21:00', otherHall, sharingTier)
    const err = await confirmEvent(booking, second, advance(1_000_000)).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as InstanceType<typeof ApiError>).message).toContain('another confirmed booking')
    const [{ n }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM venue_bookings WHERE event_id = ${second}`,
    )) as unknown as { n: number }[]
    expect(n).toBe(0)
  })
})
