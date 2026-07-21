/**
 * M3 acceptance: the confirm transaction (FR-1.7, BR-P1).
 *
 *   - a wedding without 3 contacts cannot confirm;
 *   - two parallel confirms on the same slot: exactly one wins, the loser gets a 409.
 *
 * Plus the other confirm gates (Aadhaar on file, 25% advance, missing rate = BR-R1).
 * Drives confirmEvent directly against the test database with data built in-line.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const { confirmEvent } = await import('@/lib/confirm')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')
const { ApiError } = await import('@/lib/api')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping booking tests\n')

const actor = { id: '', roleName: 'booking_manager' }
let venueId: Record<string, string> = {}

async function venue(name: string): Promise<string> {
  if (!venueId[name]) {
    const [v] = await db.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.name, name)).limit(1)
    venueId[name] = v!.id
  }
  return venueId[name]!
}

let receiptCounter = 0

type EnquiryOpts = {
  eventType?: string
  contacts?: number
  venueName?: string
  date?: string
  start?: string
  end?: string
  docs?: boolean
}

async function makeEnquiry(opts: EnquiryOpts = {}): Promise<string> {
  const { eventType = 'wedding', contacts = 3, venueName = 'Crystal', date = '2026-09-01', start = '11:00', end = '15:00', docs = true } = opts
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [event] = await db
    .insert(schema.events)
    .values({ code, guestName: `${venueName} Party`, eventType, createdBy: actor.id })
    .returning({ id: schema.events.id })
  const eventId = event!.id

  if (contacts > 0) {
    await db.insert(schema.eventContacts).values(
      Array.from({ length: contacts }, (_, i) => ({ eventId, phone: `90000${String(i).padStart(3, '0')}${eventId.slice(0, 4)}`, label: i === 0 ? 'primary' : null })),
    )
  }
  await db.insert(schema.subEvents).values({
    eventId,
    name: 'Wedding',
    eventDate: date,
    startTime: start,
    endTime: end,
    venueId: await venue(venueName),
    pax: 300,
  })
  if (docs) {
    await db.insert(schema.guestDocuments).values([
      { eventId, kind: 'aadhaar_front', fileKey: 'test-front.enc', uploadedBy: actor.id },
      { eventId, kind: 'aadhaar_back', fileKey: 'test-back.enc', uploadedBy: actor.id },
    ])
  }
  return eventId
}

function advance(amountPaise: number) {
  receiptCounter += 1
  return { amountPaise, mode: 'upi', receiptNo: `RCPT-${Date.now() % 100000}-${receiptCounter}`, receivedOn: '2026-08-01' }
}

// Crystal wedding rate = Rs 1,51,000 = 15,100,000 paise; 25% = 3,775,000 paise.
const ENOUGH_ADVANCE = 4_000_000

beforeAll(async () => {
  if (!hasDb) return
  const setup = createClient('TEST_DATABASE_URL')
  try {
    await migrate(setup, () => {})
    await seed(setup, { reset: true, force: true, password: 'test-only' }, () => {})
  } finally {
    await setup.end()
  }
  const [bm] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, 'booking_manager'))
    .limit(1)
  actor.id = bm!.id
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

d('confirm gates', () => {
  it('confirms a fully-satisfied wedding enquiry and blocks its slot', async () => {
    const id = await makeEnquiry()
    const res = await confirmEvent(actor, id, advance(ENOUGH_ADVANCE))
    expect(res.code).toMatch(/^E-/)
    expect(res.proposalTotalPaise).toBe(15_100_000)

    const [ev] = await db.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, id))
    expect(ev!.status).toBe('confirmed')
    const bookings = await db.select({ id: schema.venueBookings.id }).from(schema.venueBookings).where(eq(schema.venueBookings.eventId, id))
    expect(bookings).toHaveLength(1)
  })

  it('refuses a wedding with fewer than 3 contacts', async () => {
    const id = await makeEnquiry({ contacts: 1 })
    await expect(confirmEvent(actor, id, advance(ENOUGH_ADVANCE))).rejects.toMatchObject({ status: 400 })
    await expect(confirmEvent(actor, id, advance(ENOUGH_ADVANCE))).rejects.toThrow(/3 contact/)
  })

  it('refuses confirm without Aadhaar front and back', async () => {
    const id = await makeEnquiry({ docs: false })
    await expect(confirmEvent(actor, id, advance(ENOUGH_ADVANCE))).rejects.toThrow(/Aadhaar/)
  })

  it('refuses confirm when the advance is below 25% (402)', async () => {
    const id = await makeEnquiry()
    await expect(confirmEvent(actor, id, advance(1_000_000))).rejects.toMatchObject({ status: 402 })
  })

  it('refuses confirm while a 35+ room request is pending (BR-L2)', async () => {
    // Rooms are booked in bulk on the proposal, so confirm — not allocation — is the moment
    // they take inventory on the lodging calendar. That makes it the gate for BR-L2.
    const id = await makeEnquiry()
    const rooms = await import('@/lib/rooms')
    const [unit] = (await db.execute(
      sql`SELECT id FROM lodging_units WHERE name = 'Palace'`,
    )) as unknown as { id: string }[]

    await rooms.saveRoomRequirements(actor, id, [
      { unitId: unit!.id, roomType: 'deluxe', count: 35, checkIn: '2026-09-01', checkOut: '2026-09-03' },
    ])
    await expect(confirmEvent(actor, id, advance(ENOUGH_ADVANCE))).rejects.toThrow(/35 or more rooms/)

    // Trimming below the threshold withdraws the request and confirm goes through — with a
    // bigger advance, because rooms and their 5% tax count toward the 25% base (BR-P1 as
    // amended 20 Jul 2026): 2 deluxe × 2 nights lifts what a quarter comes to.
    await rooms.saveRoomRequirements(actor, id, [
      { unitId: unit!.id, roomType: 'deluxe', count: 2, checkIn: '2026-09-01', checkOut: '2026-09-03' },
    ])
    const ok = await confirmEvent(actor, id, advance(5_000_000))
    expect(ok.code).toMatch(/^E-/)
  })

  it('refuses confirm when a venue has no rate card (BR-R1), never pricing at zero', async () => {
    // Gulmohar Lawn is sold only as the "Gulmohar + Middle" bundle, so it carries no rate
    // of its own. It replaces Upper Hall here, which was removed from the seed on 19 Jul
    // 2026 — the fixture had been erroring on setup ever since, quietly leaving this
    // non-negotiable unverified.
    const id = await makeEnquiry({ venueName: 'Gulmohar Lawn', date: '2026-09-05' })
    await expect(confirmEvent(actor, id, advance(ENOUGH_ADVANCE))).rejects.toThrow(/No rate is defined/)
  })

  it('refuses to re-confirm an already-confirmed event', async () => {
    const id = await makeEnquiry()
    await confirmEvent(actor, id, advance(ENOUGH_ADVANCE))
    await expect(confirmEvent(actor, id, advance(ENOUGH_ADVANCE))).rejects.toMatchObject({ status: 409 })
  })
})

d('concurrency (NFR-2): two confirms race for one slot', () => {
  it('lets exactly one win; the loser gets a 409', async () => {
    // Two separate enquiries, same venue + date + time.
    const slot = { venueName: 'Signature', date: '2026-10-10', start: '18:00', end: '23:00' }
    const [a, b] = await Promise.all([makeEnquiry(slot), makeEnquiry(slot)])

    // Signature wedding rate = Rs 2,00,000; 25% = 5,00,000 paise.
    const results = await Promise.allSettled([
      confirmEvent(actor, a, advance(6_000_000)),
      confirmEvent(actor, b, advance(6_000_000)),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const err = (rejected[0] as PromiseRejectedResult).reason
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(409)

    // The database holds exactly one booking for that venue/time.
    const sigId = await venue('Signature')
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM venue_bookings
      WHERE venue_id = ${sigId}::uuid
        AND occupancy && tsrange('2026-10-10 18:00'::timestamp, '2026-10-10 23:00'::timestamp, '[)')
    `)) as unknown as { n: number }[]
    expect(rows[0]!.n).toBe(1)
  })
})
