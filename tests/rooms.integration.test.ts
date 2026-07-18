/**
 * M5 acceptance (the rooms module, FR-4.x, BR-L1/L2, BR-D1):
 *
 *   - an overlapping allocation on the same room fails cleanly (409, DB exclusion);
 *   - a 35-room allocation sits pending as an exception until Authority approves (nothing
 *     inserted yet);
 *   - a Rs.600 discount on a deluxe room is rejected, Rs.900 on a suite is accepted (BR-D1).
 *
 * Plus the lawn-wedding Palace override (BR-L1), reconciliation counts, and the
 * confirmed-status gate. Drives lib/rooms against the test database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const rooms = await import('@/lib/rooms')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping rooms tests\n')

const actor = { id: '', roleName: 'lodge_manager' }

async function roomsOfType(unitName: string, roomType: string, n: number): Promise<string[]> {
  const list = (await db.execute(sql`
    SELECT r.id FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
    WHERE u.name = ${unitName} AND r.room_type = ${roomType} AND r.is_active
    ORDER BY r.room_no LIMIT ${n}
  `)) as unknown as { id: string }[]
  return list.map((r) => r.id)
}
async function anyRooms(unitName: string, n: number): Promise<string[]> {
  const list = (await db.execute(sql`
    SELECT r.id FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
    WHERE u.name = ${unitName} AND r.is_active ORDER BY r.room_no LIMIT ${n}
  `)) as unknown as { id: string }[]
  return list.map((r) => r.id)
}
async function lawnVenueId(): Promise<string> {
  const [v] = (await db.execute(sql`SELECT id FROM venues WHERE kind = 'lawn' LIMIT 1`)) as unknown as { id: string }[]
  return v!.id
}

async function makeEvent(opts: { eventType?: string; status?: string; lawnSub?: boolean } = {}): Promise<string> {
  const { eventType = 'engagement', status = 'confirmed', lawnSub = false } = opts
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [event] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Rooms Test', eventType, createdBy: actor.id, status: status as 'confirmed' })
    .returning({ id: schema.events.id })
  if (lawnSub) {
    await db.insert(schema.subEvents).values({
      eventId: event!.id, name: 'Wedding', eventDate: '2026-12-01', startTime: '18:00', endTime: '23:00',
      venueId: await lawnVenueId(), pax: 500,
    })
  }
  return event!.id
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
  const [lm] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, 'lodge_manager'))
    .limit(1)
  actor.id = lm!.id
}, 90_000)

async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('allocation + overlap guard (FR-4.3)', () => {
  it('allocates rooms and blocks an overlapping stay on the same room (409)', async () => {
    const a = await makeEvent()
    const b = await makeEvent()
    const [room] = await anyRooms('Regency', 1)

    const res = await rooms.allocateRooms(actor, a, [{ roomId: room!, checkIn: '2026-09-01', checkOut: '2026-09-03' }])
    expect(res).toEqual({ deferred: false, allocated: 1 })

    // Overlapping stay on the same room → clean 409.
    await expect(
      rooms.allocateRooms(actor, b, [{ roomId: room!, checkIn: '2026-09-02', checkOut: '2026-09-04' }]),
    ).rejects.toMatchObject({ status: 409 })

    // Back-to-back (half-open) is allowed.
    const bb = await rooms.allocateRooms(actor, b, [{ roomId: room!, checkIn: '2026-09-03', checkOut: '2026-09-05' }])
    expect(bb).toEqual({ deferred: false, allocated: 1 })
  })

  it('refuses to allocate against an unconfirmed enquiry', async () => {
    const e = await makeEvent({ status: 'enquiry' })
    const [room] = await anyRooms('Regency', 1)
    await expect(
      rooms.allocateRooms(actor, e, [{ roomId: room!, checkIn: '2026-09-01', checkOut: '2026-09-02' }]),
    ).rejects.toThrow(/confirmed/)
  })
})

d('large allocation (BR-L2)', () => {
  it('defers a 35-room batch to a pending exception, inserting nothing', async () => {
    const e = await makeEvent()
    const ids = await anyRooms('Regency', 35)
    expect(ids.length).toBe(35)
    const res = await rooms.allocateRooms(
      actor, e,
      ids.map((roomId) => ({ roomId, checkIn: '2026-09-10', checkOut: '2026-09-12' })),
    )
    expect(res.deferred).toBe(true)

    // Exception raised, no allocations committed yet.
    const [exc] = await db.select().from(schema.exceptions).where(eq(schema.exceptions.eventId, e))
    expect(exc!.kind).toBe('room_allocation_35plus')
    expect(exc!.status).toBe('pending')
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM room_allocations WHERE event_id = ${e}`)) as unknown as { n: number }[]
    expect(n).toBe(0)
  })
})

d('per-room discount caps (BR-D1)', () => {
  it('rejects a Rs.600 discount on a deluxe room but accepts Rs.900 on a suite', async () => {
    const e = await makeEvent()
    const [deluxe] = await roomsOfType('Palace', 'deluxe', 1)
    const [suite] = await roomsOfType('Palace', 'suite', 1)

    // Rs.600 = 60000 paise > Rs.500 deluxe cap → rejected.
    await expect(
      rooms.allocateRooms(actor, e, [{ roomId: deluxe!, checkIn: '2026-09-01', checkOut: '2026-09-02', discountPaise: 60000 }]),
    ).rejects.toThrow(/cap for a deluxe/)

    // Rs.900 = 90000 paise ≤ Rs.1000 suite cap → accepted.
    const ok = await rooms.allocateRooms(actor, e, [{ roomId: suite!, checkIn: '2026-09-01', checkOut: '2026-09-02', discountPaise: 90000 }])
    expect(ok).toEqual({ deferred: false, allocated: 1 })
    const [row] = await db.select({ disc: schema.roomAllocations.discountPaise }).from(schema.roomAllocations).where(eq(schema.roomAllocations.eventId, e))
    expect(row!.disc).toBe(90000)
  })
})

d('lawn-wedding Palace preference (BR-L1)', () => {
  it('needs an override note to allocate a non-Palace room for a lawn wedding', async () => {
    const e = await makeEvent({ eventType: 'wedding', lawnSub: true })
    const [regency] = await anyRooms('Regency', 1)

    await expect(
      rooms.allocateRooms(actor, e, [{ roomId: regency!, checkIn: '2026-12-01', checkOut: '2026-12-03' }]),
    ).rejects.toThrow(/override note/)

    const ok = await rooms.allocateRooms(actor, e, [{ roomId: regency!, checkIn: '2026-12-01', checkOut: '2026-12-03', overrideNote: 'Guest requested Regency' }])
    expect(ok).toEqual({ deferred: false, allocated: 1 })
  })

  it('allocates a Palace room for a lawn wedding without any note', async () => {
    const e = await makeEvent({ eventType: 'wedding', lawnSub: true })
    const [palace] = await anyRooms('Palace', 1)
    const ok = await rooms.allocateRooms(actor, e, [{ roomId: palace!, checkIn: '2026-12-01', checkOut: '2026-12-03' }])
    expect(ok).toEqual({ deferred: false, allocated: 1 })
  })
})

d('reconciliation (FR-4.5)', () => {
  it('reports promised vs allocated vs variance per type', async () => {
    const e = await makeEvent()
    await db.insert(schema.roomRequirements).values([
      { eventId: e, roomType: 'deluxe', count: 3, checkIn: '2026-09-01', checkOut: '2026-09-03' },
    ])
    const [d1, d2] = await roomsOfType('Regency', 'deluxe', 2)
    await rooms.allocateRooms(actor, e, [
      { roomId: d1!, checkIn: '2026-09-01', checkOut: '2026-09-03' },
      { roomId: d2!, checkIn: '2026-09-01', checkOut: '2026-09-03' },
    ])

    const rec = await rooms.getReconciliation(e)
    const deluxe = rec.byType.find((r) => r.roomType === 'deluxe')!
    expect(deluxe.promised).toBe(3)
    expect(deluxe.allocated).toBe(2)
    expect(deluxe.variance).toBe(-1) // one short of promised
    expect(rec.totals.allocated).toBe(2)
    expect(rec.allocations).toHaveLength(2)
  })
})
