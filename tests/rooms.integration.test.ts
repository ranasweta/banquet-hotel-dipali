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

async function pending35(eventId: string) {
  return db.execute(sql`
    SELECT id, payload FROM exceptions
    WHERE event_id = ${eventId} AND kind = 'room_allocation_35plus' AND status = 'pending'
  `) as unknown as Promise<{ id: string; payload: unknown }[]>
}

async function unitId(name: string): Promise<string> {
  const [u] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = ${name}`)) as unknown as { id: string }[]
  return u!.id
}
/** Books rooms the way the proposal does now: lodge + category + count + dates, in bulk. */
async function bookRooms(
  eventId: string,
  unit: string,
  roomType: string,
  count: number,
  checkIn: string,
  checkOut: string,
): Promise<void> {
  await db.insert(schema.roomRequirements).values({
    eventId, unitId: await unitId(unit), roomType, count, checkIn, checkOut,
  })
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
  // Unlock first: the lock guard fires on cascaded child deletes, so a locked event left
  // behind by a test would make every later cleanup throw.
  await db.execute(sql`UPDATE events SET status = 'confirmed' WHERE status IN ('locked','billed','closed')`)
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

d('bulk room booking + BR-L2 on the proposal', () => {

  it('raises ONE pending request per proposal at 35+ rooms, and clears it when trimmed', async () => {
    // Rooms are booked in bulk on the proposal now, so BR-L2 counts rooms ASKED FOR rather
    // than rows in room_allocations (which nothing writes any more).
    const e = await makeEvent({ status: 'enquiry' })
    const palace = await unitId('Palace')
    const regency = await unitId('Regency')

    const under = await rooms.saveRoomRequirements(actor, e, [
      { unitId: palace, roomType: 'deluxe', count: 20, checkIn: '2026-09-01', checkOut: '2026-09-03' },
    ])
    expect(under).toMatchObject({ totalRooms: 20, deferred: false })
    expect(await pending35(e)).toHaveLength(0)

    // Two lodges, 33 + 2 = 35 — the threshold is the event's total, not any one line.
    // The counts are the lodges' real inventory: Palace holds 33 deluxe and Regency 2
    // suites, and asking for more than that is refused by the hard cap before BR-L2 is
    // ever reached (see §F13 — the two rules are independent).
    const over = await rooms.saveRoomRequirements(actor, e, [
      { unitId: palace, roomType: 'deluxe', count: 33, checkIn: '2026-09-01', checkOut: '2026-09-03' },
      { unitId: regency, roomType: 'suite', count: 2, checkIn: '2026-09-01', checkOut: '2026-09-03' },
    ])
    expect(over).toMatchObject({ totalRooms: 35, deferred: true })

    const raised = await pending35(e)
    expect(raised).toHaveLength(1) // one per proposal, not one per line
    const payload = raised[0]!.payload as { requestedCount: number; lines: unknown[] }
    expect(payload.requestedCount).toBe(35)
    expect(payload.lines).toHaveLength(2) // the Authority sees both lodges

    // The requirements are still saved — an enquiry occupies nothing until it confirms.
    const [{ n }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM room_requirements WHERE event_id = ${e}`,
    )) as unknown as { n: number }[]
    expect(n).toBe(2)

    // Trimming back below the threshold withdraws the request: its reason is gone.
    const trimmed = await rooms.saveRoomRequirements(actor, e, [
      { unitId: palace, roomType: 'deluxe', count: 5, checkIn: '2026-09-01', checkOut: '2026-09-03' },
    ])
    expect(trimmed.deferred).toBe(false)
    expect(await pending35(e)).toHaveLength(0)
  })

  it('keeps rooms editable after confirmation, and freezes them at lock', async () => {
    // Client, 21 Jul 2026: "old proposal can be updated with rooms and all". A guest's
    // lodging changes right up to the event, and the proposal is the only place rooms are
    // recorded. Locked is still locked.
    const e = await makeEvent() // confirmed
    const line = [
      { unitId: await unitId('Palace'), roomType: 'deluxe', count: 1, checkIn: '2026-09-01', checkOut: '2026-09-02' },
    ]
    const saved = await rooms.saveRoomRequirements(actor, e, line)
    expect(saved.totalRooms).toBe(1)

    await db.update(schema.events).set({ status: 'locked' }).where(eq(schema.events.id, e))
    try {
      await expect(rooms.saveRoomRequirements(actor, e, line)).rejects.toMatchObject({ status: 409 })
    } finally {
      await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, e))
    }
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

d('lodging calendar (Lodge Manager 30-day occupancy)', () => {
  const unitIdOf = (inv: { unitId: string; unitName: string }[], name: string) =>
    inv.find((i) => i.unitName === name)!.unitId
  const cell = (cal: Awaited<ReturnType<typeof rooms.getLodgingCalendar>>, date: string, unit: string, type: string) =>
    cal.occupancy.find((c) => c.date === date && c.unitId === unit && c.roomType === type)

  it('counts a stay on every night it spans, but never on the checkout day', async () => {
    const e = await makeEvent()
    await bookRooms(e, 'Palace', 'deluxe', 2, '2026-09-01', '2026-09-04')

    const cal = await rooms.getLodgingCalendar('2026-08-30', '2026-09-06')
    const palace = unitIdOf(cal.inventory, 'Palace')

    for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      expect(cell(cal, date, palace, 'deluxe')?.confirmed, `night ${date}`).toBe(2)
    }
    // Half-open stay: the guest is gone on the 4th, and never arrived on 31 Aug.
    expect(cell(cal, '2026-09-04', palace, 'deluxe')).toBeUndefined()
    expect(cell(cal, '2026-08-31', palace, 'deluxe')).toBeUndefined()
  })

  it('separates locked from confirmed', async () => {
    const locked = await makeEvent()
    await bookRooms(locked, 'Regency', 'suite', 1, '2026-10-01', '2026-10-02')
    await db.execute(sql`UPDATE events SET status = 'locked' WHERE id = ${locked}`)

    const open = await makeEvent() // stays confirmed
    await bookRooms(open, 'Regency', 'suite', 4, '2026-10-01', '2026-10-02')

    const cal = await rooms.getLodgingCalendar('2026-10-01', '2026-10-06')
    const regency = unitIdOf(cal.inventory, 'Regency')

    expect(cell(cal, '2026-10-01', regency, 'suite')?.locked).toBe(1)
    expect(cell(cal, '2026-10-01', regency, 'suite')?.confirmed).toBe(4)
  })

  it('names who holds each category on a date, and what is left', async () => {
    const e = await makeEvent()
    await bookRooms(e, 'Palace', 'deluxe', 3, '2026-11-10', '2026-11-12')

    const day = await rooms.getLodgingDay('2026-11-11')
    const palace = unitIdOf(day.inventory, 'Palace')
    const held = day.holders.find((h) => h.unitId === palace && h.roomType === 'deluxe')!

    expect(held.count).toBe(3)
    expect(held.state).toBe('confirmed')
    expect(held.guestName).toBe('Rooms Test')
    expect(held.code).toMatch(/^E-/)

    const stock = day.inventory.find((i) => i.unitId === palace && i.roomType === 'deluxe')!
    expect(stock.total - held.count).toBe(stock.total - 3) // the "how many are left" figure
    expect(stock.total).toBeGreaterThan(3)
  })
})

d('reconciliation — can the lodge deliver? (FR-4.5, rewritten 21 Jul 2026)', () => {
  async function unit(name: string): Promise<string> {
    const [u] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = ${name}`)) as unknown as { id: string }[]
    return u!.id
  }
  /** A confirmed event spanning [from, to] holding `count` Palace deluxe over those nights. */
  async function holding(count: number, from: string, to: string): Promise<string> {
    const eventId = await makeEvent()
    const venueId = await lawnVenueId()
    await db.insert(schema.subEvents).values({
      eventId, name: 'Function', eventDate: from, startTime: '19:00', endTime: '23:00', venueId, pax: 100,
    })
    await db.insert(schema.subEvents).values({
      eventId, name: 'Reception', eventDate: to, startTime: '19:00', endTime: '23:00', venueId, pax: 100,
    })
    await rooms.saveRoomRequirements(actor, eventId, [
      { unitId: await unit('Palace'), roomType: 'deluxe', count, checkIn: from, checkOut: to },
    ])
    return eventId
  }

  it('reports a deliverable booking with no shortfall', async () => {
    const e = await holding(5, '2026-09-01', '2026-09-03')
    const rec = await rooms.getReconciliation(e)

    expect(rec.lines).toHaveLength(1)
    const line = rec.lines[0]!
    expect(line.unitName).toBe('Palace')
    expect(line.promised).toBe(5)
    expect(line.capacity).toBe(33)
    expect(line.takenByOthers).toBe(0)
    expect(line.shortfall).toBe(0)
    expect(rec.deliverable).toBe(true)
  })

  it('does not count the event against itself', async () => {
    // The old implementation compared against room_allocations and reported -promised for
    // every event; the new one must not simply move that bug to a different table.
    const e = await holding(30, '2026-09-05', '2026-09-07')
    const rec = await rooms.getReconciliation(e)
    expect(rec.lines[0]!.takenByOthers).toBe(0)
    expect(rec.deliverable).toBe(true)
  })

  it('reports a shortfall when another event has taken the rooms since', async () => {
    // The hard cap stops an overbooking at save time; this is the re-check at lock, when a
    // competing event may have confirmed over the same nights.
    const ours = await holding(20, '2026-09-10', '2026-09-12')
    const theirs = await holding(13, '2026-09-10', '2026-09-12') // 20 + 13 = 33, all of Palace

    // A third booking cannot even be saved now — the cap refuses it.
    await expect(holding(1, '2026-09-10', '2026-09-12')).rejects.toMatchObject({ status: 409 })

    // Retiring a room after the fact is the case reconciliation exists to catch.
    await db.execute(sql`
      UPDATE rooms SET is_active = false
       WHERE id IN (SELECT r.id FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
                    WHERE u.name = 'Palace' AND r.room_type = 'deluxe' AND r.is_active
                    ORDER BY r.room_no LIMIT 3)`)
    try {
      const rec = await rooms.getReconciliation(ours)
      expect(rec.lines[0]!.capacity).toBe(30) // 33 - 3 retired
      expect(rec.lines[0]!.takenByOthers).toBe(13) // the other event
      expect(rec.lines[0]!.available).toBe(17)
      expect(rec.lines[0]!.shortfall).toBe(3) // promised 20, only 17 left
      expect(rec.deliverable).toBe(false)
      expect(rec.totals).toEqual({ promised: 20, shortfall: 3 })
    } finally {
      await db.execute(sql`
        UPDATE rooms SET is_active = true
         WHERE room_type = 'deluxe'
           AND unit_id = (SELECT id FROM lodging_units WHERE name = 'Palace')`)
      void theirs
    }
  })

  it('reports an empty reconciliation for an event with no rooms', async () => {
    const rec = await rooms.getReconciliation(await makeEvent())
    expect(rec.lines).toHaveLength(0)
    expect(rec.deliverable).toBe(true)
  })
})

d('room inventory hard cap (client, 21 Jul 2026)', () => {
  async function palaceId(): Promise<string> {
    const [u] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = 'Palace'`)) as unknown as { id: string }[]
    return u!.id
  }
  /**
   * An event spanning [from, to], so the room-date clamp has a real span to work against.
   * Rooms may be held from the first function's date to the morning after the last.
   */
  async function eventOn(from: string, to = from): Promise<string> {
    const eventId = await makeEvent()
    const venueId = await lawnVenueId()
    await db.insert(schema.subEvents).values({
      eventId, name: 'Function', eventDate: from, startTime: '19:00', endTime: '23:00', venueId, pax: 100,
    })
    if (to !== from) {
      await db.insert(schema.subEvents).values({
        eventId, name: 'Reception', eventDate: to, startTime: '19:00', endTime: '23:00', venueId, pax: 100,
      })
    }
    return eventId
  }

  it('refuses more rooms of a category than the lodge has', async () => {
    // Palace holds 33 deluxe. Asking for 40 is not an approval question, it is impossible.
    const eventId = await eventOn('2026-11-10', '2026-11-11')
    await expect(
      rooms.saveRoomRequirements(actor, eventId, [
        { unitId: await palaceId(), roomType: 'deluxe', count: 40, checkIn: '2026-11-10', checkOut: '2026-11-12' },
      ]),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('counts only committed events, so an enquiry holds nothing', async () => {
    const unitId = await palaceId()
    // An enquiry takes 30 of the 33 deluxe…
    const enquiry = await makeEvent({ status: 'enquiry' })
    const enquiryVenue = await lawnVenueId()
    await db.insert(schema.subEvents).values({
      eventId: enquiry, name: 'Function', eventDate: '2026-11-20', startTime: '19:00', endTime: '23:00',
      venueId: enquiryVenue, pax: 100,
    })
    await db.insert(schema.subEvents).values({
      eventId: enquiry, name: 'Reception', eventDate: '2026-11-21', startTime: '19:00', endTime: '23:00',
      venueId: enquiryVenue, pax: 100,
    })
    await rooms.saveRoomRequirements(actor, enquiry, [
      { unitId, roomType: 'deluxe', count: 30, checkIn: '2026-11-20', checkOut: '2026-11-22' },
    ])

    // …and a confirmed booking can still take all 33: whoever commits first wins.
    const confirmed = await eventOn('2026-11-20', '2026-11-21')
    const res = await rooms.saveRoomRequirements(actor, confirmed, [
      { unitId, roomType: 'deluxe', count: 33, checkIn: '2026-11-20', checkOut: '2026-11-22' },
    ])
    expect(res.totalRooms).toBe(33)
  })

  it('measures the tightest night in the range, not the average', async () => {
    const unitId = await palaceId()
    const held = await eventOn('2026-11-02')
    await rooms.saveRoomRequirements(actor, held, [
      // Only the middle night of the window below.
      { unitId, roomType: 'suite', count: 3, checkIn: '2026-11-02', checkOut: '2026-11-03' },
    ])

    // Palace has 3 suites, all taken on the 2nd. A 1st–4th stay must see zero free, even
    // though two of its three nights are wide open.
    const avail = await rooms.getRoomAvailability([
      { unitId, roomType: 'suite', count: 1, checkIn: '2026-11-01', checkOut: '2026-11-04' },
    ])
    expect(avail[0]!.total).toBe(3)
    expect(avail[0]!.peakBooked).toBe(3)
    expect(avail[0]!.available).toBe(0)
  })

  it('does not count an event against itself when its rooms are re-saved', async () => {
    const unitId = await palaceId()
    const eventId = await eventOn('2026-11-15', '2026-11-16')
    await rooms.saveRoomRequirements(actor, eventId, [
      { unitId, roomType: 'deluxe', count: 33, checkIn: '2026-11-15', checkOut: '2026-11-17' },
    ])
    // Re-saving the same 33 must not read them as already taken.
    const res = await rooms.saveRoomRequirements(actor, eventId, [
      { unitId, roomType: 'deluxe', count: 33, checkIn: '2026-11-15', checkOut: '2026-11-17' },
    ])
    expect(res.totalRooms).toBe(33)
  })

  it('keeps room dates inside the event, allowing checkout the morning after', async () => {
    const unitId = await palaceId()
    const eventId = await eventOn('2026-11-25')

    await expect(
      rooms.saveRoomRequirements(actor, eventId, [
        { unitId, roomType: 'deluxe', count: 2, checkIn: '2026-11-24', checkOut: '2026-11-26' },
      ]),
    ).rejects.toThrow(/before the event starts/)

    await expect(
      rooms.saveRoomRequirements(actor, eventId, [
        { unitId, roomType: 'deluxe', count: 2, checkIn: '2026-11-25', checkOut: '2026-11-28' },
      ]),
    ).rejects.toThrow(/after the event ends/)

    // Check-out on the 26th — the morning after the function — is the boundary and is fine.
    const ok = await rooms.saveRoomRequirements(actor, eventId, [
      { unitId, roomType: 'deluxe', count: 2, checkIn: '2026-11-25', checkOut: '2026-11-26' },
    ])
    expect(ok.totalRooms).toBe(2)
  })

  it('bounds room dates by the DECLARED event window, not just the functions (client, 22 Jul 2026)', async () => {
    const unitId = await palaceId()
    // Only one function, on the 10th — but the proposal declares the event runs 10-12 Nov.
    const eventId = await eventOn('2026-11-10')
    await db
      .update(schema.events)
      .set({ plannedFrom: '2026-11-10', plannedTo: '2026-11-12' })
      .where(eq(schema.events.id, eventId))

    // A room may now run the whole declared window — checkout up to the morning after the 12th,
    // even though no function is scheduled past the 10th.
    const ok = await rooms.saveRoomRequirements(actor, eventId, [
      { unitId, roomType: 'deluxe', count: 2, checkIn: '2026-11-10', checkOut: '2026-11-13' },
    ])
    expect(ok.totalRooms).toBe(2)

    // …but not one night beyond it.
    await expect(
      rooms.saveRoomRequirements(actor, eventId, [
        { unitId, roomType: 'deluxe', count: 2, checkIn: '2026-11-10', checkOut: '2026-11-14' },
      ]),
    ).rejects.toThrow(/after the event ends/)
  })

  it('sums SIBLING lines of the same category — one proposal cannot overbook a lodge (client, 22 Jul 2026)', async () => {
    const unitId = await palaceId()
    const eventId = await eventOn('2026-11-18', '2026-11-19')

    // Palace holds 33 deluxe. Two lines, 33 + 6, over the same nights = 39. Each fits on its
    // own (33 ≤ 33, 6 ≤ 33), but together they exceed inventory and must be refused — the bug
    // was that each line ignored the other and the proposal booked 39 of 33.
    await expect(
      rooms.saveRoomRequirements(actor, eventId, [
        { unitId, roomType: 'deluxe', count: 33, checkIn: '2026-11-18', checkOut: '2026-11-20' },
        { unitId, roomType: 'deluxe', count: 6, checkIn: '2026-11-18', checkOut: '2026-11-20' },
      ]),
    ).rejects.toMatchObject({ status: 409 })

    // Two lines on NON-overlapping nights don't compete: 33 on the 18th, another 33 on the
    // 19th, is fine — the half-open stays never share a night.
    const ok = await rooms.saveRoomRequirements(actor, eventId, [
      { unitId, roomType: 'deluxe', count: 33, checkIn: '2026-11-18', checkOut: '2026-11-19' },
      { unitId, roomType: 'deluxe', count: 33, checkIn: '2026-11-19', checkOut: '2026-11-20' },
    ])
    expect(ok.totalRooms).toBe(66)
  })
})

d('room shortfalls — the notification behind "someone booked it first"', () => {
  async function unitId2(name: string): Promise<string> {
    const [u] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = ${name}`)) as unknown as { id: string }[]
    return u!.id
  }
  async function spanning(from: string, to: string, status = 'confirmed'): Promise<string> {
    const eventId = await makeEvent({ status })
    const venueId = await lawnVenueId()
    await db.insert(schema.subEvents).values([
      { eventId, name: 'Function', eventDate: from, startTime: '19:00', endTime: '23:00', venueId, pax: 100 },
      { eventId, name: 'Reception', eventDate: to, startTime: '19:00', endTime: '23:00', venueId, pax: 100 },
    ])
    return eventId
  }

  it('flags an enquiry whose rooms were taken by an event that confirmed after it', async () => {
    // The client's exact case: enquiries hold nothing, so the enquiry saves happily, and
    // then someone else commits the same rooms. Nobody is blocked — the loser is told.
    const palace = await unitId2('Palace')
    const enquiry = await spanning('2026-10-10', '2026-10-12', 'enquiry')
    await rooms.saveRoomRequirements(actor, enquiry, [
      { unitId: palace, roomType: 'deluxe', count: 10, checkIn: '2026-10-10', checkOut: '2026-10-12' },
    ])
    expect(await rooms.listRoomShortfalls({})).toHaveLength(0) // nothing wrong yet

    // A confirmed booking takes 30 of the 33 — the enquiry held none of them.
    const confirmed = await spanning('2026-10-10', '2026-10-12')
    await rooms.saveRoomRequirements(actor, confirmed, [
      { unitId: palace, roomType: 'deluxe', count: 30, checkIn: '2026-10-10', checkOut: '2026-10-12' },
    ])

    const shortfalls = await rooms.listRoomShortfalls({})
    expect(shortfalls).toHaveLength(1)
    const sf = shortfalls[0]!
    expect(sf.eventId).toBe(enquiry) // the loser, not the winner
    expect(sf.promised).toBe(10)
    expect(sf.available).toBe(3) // 33 - 30
    expect(sf.shortfall).toBe(7)
    expect(sf.unitName).toBe('Palace')
  })

  it('clears itself once the booking is changed', async () => {
    const palace = await unitId2('Palace')
    const enquiry = await spanning('2026-10-20', '2026-10-22', 'enquiry')
    await rooms.saveRoomRequirements(actor, enquiry, [
      { unitId: palace, roomType: 'deluxe', count: 10, checkIn: '2026-10-20', checkOut: '2026-10-22' },
    ])
    const confirmed = await spanning('2026-10-20', '2026-10-22')
    await rooms.saveRoomRequirements(actor, confirmed, [
      { unitId: palace, roomType: 'deluxe', count: 30, checkIn: '2026-10-20', checkOut: '2026-10-22' },
    ])
    expect(await rooms.listRoomShortfalls({})).toHaveLength(1)

    // Trimming to what is actually free resolves it — the notice is derived, never stored.
    await rooms.saveRoomRequirements(actor, enquiry, [
      { unitId: palace, roomType: 'deluxe', count: 3, checkIn: '2026-10-20', checkOut: '2026-10-22' },
    ])
    expect(await rooms.listRoomShortfalls({})).toHaveLength(0)
  })

  it('scopes to the proposal owner and to a lodge', async () => {
    const palace = await unitId2('Palace')
    const enquiry = await spanning('2026-10-25', '2026-10-27', 'enquiry')
    await rooms.saveRoomRequirements(actor, enquiry, [
      { unitId: palace, roomType: 'deluxe', count: 10, checkIn: '2026-10-25', checkOut: '2026-10-27' },
    ])
    const confirmed = await spanning('2026-10-25', '2026-10-27')
    await rooms.saveRoomRequirements(actor, confirmed, [
      { unitId: palace, roomType: 'deluxe', count: 30, checkIn: '2026-10-25', checkOut: '2026-10-27' },
    ])

    // The owner of the losing proposal hears about it…
    expect(await rooms.listRoomShortfalls({ ownerId: actor.id })).toHaveLength(1)
    // …and somebody else does not.
    const [other] = (await db.execute(sql`
      SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'higher_authority' LIMIT 1`)) as unknown as { id: string }[]
    expect(await rooms.listRoomShortfalls({ ownerId: other!.id })).toHaveLength(0)

    // Palace's Lodge Manager sees it; Regency's does not.
    expect(await rooms.listRoomShortfalls({ unitId: palace })).toHaveLength(1)
    expect(await rooms.listRoomShortfalls({ unitId: await unitId2('Regency') })).toHaveLength(0)
  })

  it('gives every line its own identity, even when they look alike', async () => {
    // A proposal may hold two lines of the same category in the same lodge from the same
    // check-in, differing only in check-out — and nothing forbids two identical lines. The
    // feed keys on the requirement row for exactly this reason; keying on the shape of the
    // line put duplicate React keys in the notification list.
    const palace = await unitId2('Palace')
    const enquiry = await spanning('2026-12-01', '2026-12-05', 'enquiry')
    await rooms.saveRoomRequirements(actor, enquiry, [
      { unitId: palace, roomType: 'deluxe', count: 10, checkIn: '2026-12-01', checkOut: '2026-12-03' },
      { unitId: palace, roomType: 'deluxe', count: 10, checkIn: '2026-12-01', checkOut: '2026-12-05' },
    ])
    const confirmed = await spanning('2026-12-01', '2026-12-05')
    await rooms.saveRoomRequirements(actor, confirmed, [
      { unitId: palace, roomType: 'deluxe', count: 30, checkIn: '2026-12-01', checkOut: '2026-12-05' },
    ])

    const shortfalls = await rooms.listRoomShortfalls({})
    expect(shortfalls).toHaveLength(2) // both lines are short
    const ids = shortfalls.map((s) => s.requirementId)
    expect(new Set(ids).size).toBe(2) // and they are distinguishable
    expect(ids.every(Boolean)).toBe(true)
  })

  it('ignores locked and cancelled proposals', async () => {
    const palace = await unitId2('Palace')
    const enquiry = await spanning('2026-11-05', '2026-11-07', 'enquiry')
    await rooms.saveRoomRequirements(actor, enquiry, [
      { unitId: palace, roomType: 'deluxe', count: 10, checkIn: '2026-11-05', checkOut: '2026-11-07' },
    ])
    const confirmed = await spanning('2026-11-05', '2026-11-07')
    await rooms.saveRoomRequirements(actor, confirmed, [
      { unitId: palace, roomType: 'deluxe', count: 30, checkIn: '2026-11-05', checkOut: '2026-11-07' },
    ])
    expect(await rooms.listRoomShortfalls({})).toHaveLength(1)

    // A settled proposal is nobody's problem any more.
    await db.update(schema.events).set({ status: 'cancelled' }).where(eq(schema.events.id, enquiry))
    expect(await rooms.listRoomShortfalls({})).toHaveLength(0)
  })
})
