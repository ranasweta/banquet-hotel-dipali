/**
 * The Lodge Manager's extras (client, 15 Aug 2026) — `lib/lodge-extras.ts`, migration 0034.
 *
 * Extra rooms handed out during an event and an in-room dining total, both logged after the
 * fact. Four things are worth pinning down by hand, because each is a way the money could go
 * quietly wrong:
 *
 *   - NOTHING COUNTS UNTIL THE CLOSE. Open lines are still being typed; they must not move a
 *     balance the guest is being quoted from.
 *   - THEY ARE OUTSIDE THE PRE-EVENT BASE. A room given out in September cannot be allowed to
 *     raise the 25% advance that fell due in June (rule 12's split, which maintenance already
 *     lives on).
 *   - THE 5% ON AN EXTRA ROOM IS COLLECTED; the 18% on dining is not (rule 11). Getting these
 *     the wrong way round either overcharges the guest or leaves the balance permanently short.
 *   - THE RATE IS FROZEN AT ENTRY. Re-pricing the category afterwards must not move a figure
 *     the guest was shown at checkout.
 *
 * And one arithmetic invariant: the payable, the bill and the printed proposal must agree to
 * the paisa, since all three now carry these lines.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const lodgeExtras = await import('@/lib/lodge-extras')
const schedule = await import('@/lib/payment-schedule')
const invoice = await import('@/lib/invoice')
const proposal = await import('@/lib/proposal')
const lock = await import('@/lib/lock')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping lodge-extras tests\n')

const auditor = { id: '', roleName: 'auditor' }
const lodge = { id: '', roleName: 'lodge_manager' }

async function userId(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}

async function palaceId(): Promise<string> {
  const [u] = (await db.execute(
    sql`SELECT id FROM lodging_units WHERE name = 'Palace'`,
  )) as unknown as { id: string }[]
  return u!.id
}

/** Palace deluxe is Rs. 5,000/night in the seed — read rather than assumed. */
async function palaceDeluxeRate(): Promise<number> {
  const [r] = (await db.execute(sql`
    SELECT min(r.rack_rate_paise)::bigint AS rate FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
    WHERE u.name = 'Palace' AND r.room_type = 'deluxe' AND r.is_active
  `)) as unknown as { rate: number }[]
  return Number(r!.rate)
}

/**
 * An in-progress booking with one function and two booked rooms, so the assertions can tell
 * the booking's rooms apart from the extras given out on top of them.
 */
async function makeBooking(status = 'in_progress'): Promise<string> {
  const [{ code }] = (await db.execute(
    sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
  )) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({
      code,
      guestName: 'Lodge Extras Test',
      eventType: 'engagement',
      status: status as 'in_progress',
      proposalTotalPaise: 10_000_000,
      createdBy: auditor.id,
    })
    .returning({ id: schema.events.id })
  const [venue] = await db.select({ id: schema.venues.id }).from(schema.venues).limit(1)
  await db.insert(schema.subEvents).values({
    eventId: e!.id, name: 'Function', eventDate: '2026-10-01', startTime: '11:00', endTime: '15:00',
    venueId: venue!.id, pax: 100, venueRatePaise: 10_000_000,
  })
  await db.insert(schema.roomRequirements).values({
    eventId: e!.id, unitId: await palaceId(), roomType: 'deluxe', count: 2,
    checkIn: '2026-10-01', checkOut: '2026-10-03',
  })
  return e!.id
}

/** Four extra Deluxe at Palace for two nights — the client's own example. */
async function addFourDeluxe(eventId: string) {
  return lodgeExtras.addRoomLine(lodge, eventId, {
    unitId: await palaceId(),
    roomType: 'deluxe',
    count: 4,
    nights: 2,
    remarks: 'extra baraatis',
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
  auditor.id = await userId('auditor')
  lodge.id = await userId('lodge_manager')
}, 90_000)

async function cleanup() {
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('extra rooms', () => {
  it('prices count × nights at the lodge rate and freezes it', async () => {
    const e = await makeBooking()
    const rate = await palaceDeluxeRate()
    const { amountPaise } = await addFourDeluxe(e)
    expect(amountPaise).toBe(rate * 4 * 2)

    // Re-pricing the category afterwards moves nothing already logged: the line holds its own
    // rate, exactly as a confirmed room requirement does (migration 0032).
    await db.execute(sql`
      UPDATE rooms SET rack_rate_paise = rack_rate_paise * 2
      WHERE room_type = 'deluxe' AND unit_id = ${await palaceId()}
    `)
    try {
      const view = await lodgeExtras.getLodgeExtras(e)
      expect(view.rooms[0]!.ratePaise).toBe(rate)
      expect(view.roomsPaise).toBe(rate * 4 * 2)
    } finally {
      await db.execute(sql`
        UPDATE rooms SET rack_rate_paise = rack_rate_paise / 2
        WHERE room_type = 'deluxe' AND unit_id = ${await palaceId()}
      `)
    }
  })

  it('refuses a category the lodge has no priced room of, rather than pricing it at zero', async () => {
    const e = await makeBooking()
    await expect(
      lodgeExtras.addRoomLine(lodge, e, { unitId: await palaceId(), roomType: 'igloo', count: 1, nights: 1 }),
    ).rejects.toThrow(/no priced/i)
  })

  it('refuses to be logged before the event starts, and after it is closed', async () => {
    const enquiry = await makeBooking('confirmed')
    await expect(addFourDeluxe(enquiry)).rejects.toThrow(/In Progress or Completed/i)

    const e = await makeBooking()
    await addFourDeluxe(e)
    await lodgeExtras.closeLodgeExtras(lodge, e)
    await expect(addFourDeluxe(e)).rejects.toThrow(/closed/i)
    await expect(lodgeExtras.setInRoomDining(lodge, e, 500_000)).rejects.toThrow(/closed/i)
  })
})

d('in-room dining', () => {
  it('is one box: saving replaces the figure rather than adding to it', async () => {
    const e = await makeBooking()
    await lodgeExtras.setInRoomDining(lodge, e, 420_000)
    await lodgeExtras.setInRoomDining(lodge, e, 500_000)
    expect((await lodgeExtras.getLodgeExtras(e)).inRoomDiningPaise).toBe(500_000)

    // The figure it replaced survives in the audit trail — that is where "what was it made of"
    // is answerable, since the column holds only the latest.
    const trail = (await db.execute(sql`
      SELECT old_value AS "oldValue", new_value AS "newValue" FROM audit_log
      WHERE event_id = ${e} AND entity = 'lodge_extras' AND field = 'in_room_dining_paise'
      ORDER BY seq
    `)) as unknown as { oldValue: string | null; newValue: string }[]
    expect(trail.map((t) => t.newValue)).toEqual(['420000', '500000'])
    expect(trail[1]!.oldValue).toBe('420000')
  })
})

d('the close', () => {
  it('is what puts the extras on the payable, the bill and the proposal — and they agree', async () => {
    const e = await makeBooking()
    const rate = await palaceDeluxeRate()
    await addFourDeluxe(e)
    await lodgeExtras.setInRoomDining(lodge, e, 420_000)

    const rooms = rate * 4 * 2
    const roomsTax = Math.round((rooms * 500) / 10000)

    // Open: logged, visible in the panel, and in none of the money.
    const before = await schedule.payableBreakdown(e)
    expect(before.extraRoomsPaise).toBe(0)
    expect(before.inRoomDiningPaise).toBe(0)
    expect((await invoice.computeBillLines(db, e)).some((l) => /extra deluxe|In-room dining/i.test(l.description))).toBe(false)

    await lodgeExtras.closeLodgeExtras(lodge, e)

    const after = await schedule.payableBreakdown(e)
    expect(after.extraRoomsPaise).toBe(rooms)
    expect(after.extraRoomsTaxPaise).toBe(roomsTax)
    expect(after.inRoomDiningPaise).toBe(420_000)
    // The pre-event base is untouched: the advance and the wedding 50% fell due long before.
    expect(after.preEventPayablePaise).toBe(before.preEventPayablePaise)
    expect(after.payablePaise).toBe(before.payablePaise + rooms + roomsTax + 420_000)

    // The bill carries them as a rooms line (5%, collected) and a food line (18%, shown).
    const lines = await invoice.computeBillLines(db, e)
    const extraRoom = lines.find((l) => l.description.includes('extra deluxe'))!
    expect(extraRoom.section).toBe('rooms')
    expect(extraRoom.gstRateBp).toBe(500)
    expect(extraRoom.amountPaise).toBe(rooms)
    const dining = lines.find((l) => l.description === 'In-room dining')!
    expect(dining.section).toBe('food')
    expect(dining.gstRateBp).toBe(1800)
    expect(dining.amountPaise).toBe(420_000)

    // The printed proposal shows both in the Extras block and reaches the same payable.
    const doc = await proposal.proposalDocument(e)
    expect(doc.extras.map((x) => x.amountPaise)).toEqual(expect.arrayContaining([rooms, 420_000]))
    expect(doc.totals.extraRoomsPaise).toBe(rooms)
    expect(doc.totals.extraRoomsTaxPaise).toBe(roomsTax)
    expect(doc.totals.totalPaise).toBe(after.payablePaise)
  })

  it('is a lock-checklist item that is green when there is nothing to close', async () => {
    const quiet = await makeBooking()
    const items = (await lock.lockChecklist(quiet)).items
    const item = items.find((i) => i.key === 'lodge_extras')!
    expect(item.done).toBe(true)
    // Non-blocking, like maintenance: most bookings take no extras and must still lock.
    expect(item.blocking).toBe(false)

    const busy = await makeBooking()
    await addFourDeluxe(busy)
    expect((await lock.lockChecklist(busy)).items.find((i) => i.key === 'lodge_extras')!.done).toBe(false)
    await lodgeExtras.closeLodgeExtras(lodge, busy)
    expect((await lock.lockChecklist(busy)).items.find((i) => i.key === 'lodge_extras')!.done).toBe(true)
  })
})
