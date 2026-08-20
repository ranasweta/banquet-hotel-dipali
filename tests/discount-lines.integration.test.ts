/**
 * The Discounted column (client, 20 Aug 2026; migration 0036).
 *
 * A discount is the PRICE WE ARE CHARGING, not money taken off. What is stored is the GAP below
 * the actual, so the column keeps tracking when pax or a menu moves — "the Billing figure always
 * follows the live feeding of pax, menu, everything as it is". And tax follows the money: the
 * room 5%/18% is charged on the discounted line, and the band is re-read off the discounted
 * nightly rate.
 *
 * These are the four things that would be silently wrong if the arithmetic drifted:
 *   - the sheet prices a line at what was typed, and the gap survives a re-price;
 *   - room GST is charged on what is collected, and a discount can move the band;
 *   - the payable, the invoice and the printed proposal agree to the paisa;
 *   - the 10% cap still routes an over-cap save to the Authority, as one request.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const discounts = await import('@/lib/discounts')
const { balancesByEvent, payableBreakdown } = await import('@/lib/payment-schedule')
const { computeBillLines } = await import('@/lib/invoice')
const { proposalDocument } = await import('@/lib/proposal')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping discount-line tests\n')

const auditor = { id: '', roleName: 'auditor' }
const bm = { id: '', roleName: 'booking_manager' }

async function userId(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}

/**
 * One confirmed function with a snapshotted venue rate and a saved menu, plus room lines when
 * asked for. Rates are round numbers so every expectation below is exact rather than "about".
 */
async function makeEvent(opts: { venuePaise?: number; perPlatePaise?: number; pax?: number } = {}): Promise<{ eventId: string; subEventId: string }> {
  const { venuePaise = 10_000_00, perPlatePaise = 700_00, pax = 100 } = opts
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Discount Test', eventType: 'engagement', status: 'confirmed', proposalTotalPaise: venuePaise + perPlatePaise * pax, createdBy: auditor.id })
    .returning({ id: schema.events.id })
  const [venue] = await db.select({ id: schema.venues.id }).from(schema.venues).limit(1)
  const [se] = await db
    .insert(schema.subEvents)
    .values({
      eventId: e!.id, name: 'Reception', eventDate: '2026-09-01', startTime: '19:00', endTime: '23:00',
      venueId: venue!.id, pax, venueRatePaise: venuePaise,
    })
    .returning({ id: schema.subEvents.id })
  const [tier] = await db.select({ id: schema.menuTiers.id }).from(schema.menuTiers).limit(1)
  await db.insert(schema.subEventMenus).values({
    subEventId: se!.id, tierId: tier!.id, tierName: 'Silver', baseRatePaise: perPlatePaise, surchargePaise: 0,
  })
  return { eventId: e!.id, subEventId: se!.id }
}

/** A room line at a chosen nightly rate, priced from its own frozen rate. */
async function addRoom(eventId: string, roomType: string, ratePaise: number, count = 2, checkIn = '2026-09-01', checkOut = '2026-09-02') {
  await db.insert(schema.roomRequirements).values({ eventId, roomType, count, checkIn, checkOut, ratePaise })
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
  bm.id = await userId('booking_manager')
}, 90_000)

afterEach(async () => { if (hasDb) await db.delete(schema.events) })
afterAll(async () => { if (hasDb) await db.delete(schema.events) })

d('the Discounted column', () => {
  it('charges the price typed, and shows the actual beside it', async () => {
    const { eventId, subEventId } = await makeEvent({ venuePaise: 10_000_00, perPlatePaise: 700_00, pax: 100 })

    // Venue ₹10,000 given for ₹9,000. Nothing is subtracted anywhere — ₹9,000 IS the charge.
    await discounts.setLineDiscounts(auditor, eventId, [{ key: `venue:${subEventId}`, discountedPaise: 9_000_00 }])

    const sheet = await discounts.discountSheet(eventId)
    const fn = sheet.functions[0]!
    expect(fn.venue.actualPaise).toBe(10_000_00)
    expect(fn.venue.discountedPaise).toBe(9_000_00)
    // The food line is untouched and prints the same figure in both columns.
    expect(fn.food!.actualPaise).toBe(70_000_00)
    expect(fn.food!.discountedPaise).toBe(70_000_00)
    expect(sheet.lineDiscountPaise).toBe(1_000_00)
  })

  it('keeps the gap, not the typed price, when the booking is re-priced', async () => {
    // The client's rule of 20 Aug 2026: "the Billing figure always follows the live feeding of
    // pax, menu, everything as it is." Food at 100 pax × ₹700 = ₹70,000, given for ₹60,000 — a
    // gap of ₹10,000. Put the pax up to 150 and the actual becomes ₹1,05,000, so the discounted
    // must read ₹95,000. A frozen ₹60,000 would be 45 free plates nobody agreed to.
    const { eventId, subEventId } = await makeEvent({ perPlatePaise: 700_00, pax: 100 })
    // The Auditor gives it: ₹10,000 off an ₹80,000 booking is over the 10% cap, and a pending
    // discount would prove nothing about re-pricing.
    await discounts.setLineDiscounts(auditor, eventId, [{ key: `food:${subEventId}`, discountedPaise: 60_000_00 }])

    await db.update(schema.subEvents).set({ pax: 150 }).where(eq(schema.subEvents.id, subEventId))

    const sheet = await discounts.discountSheet(eventId)
    expect(sheet.functions[0]!.food!.actualPaise).toBe(105_000_00)
    expect(sheet.functions[0]!.food!.discountedPaise).toBe(95_000_00)
  })

  it('never turns a shrunken line into a credit', async () => {
    // Give ₹9,000 off a ₹10,000 hall, then re-price the hall down to ₹5,000. The line is free,
    // not worth −₹4,000: a clamp at the line is the only thing between a discount and a refund.
    const { eventId, subEventId } = await makeEvent({ venuePaise: 10_000_00 })
    await discounts.setLineDiscounts(auditor, eventId, [{ key: `venue:${subEventId}`, discountedPaise: 1_000_00 }])
    await db.update(schema.subEvents).set({ venueRatePaise: 5_000_00 }).where(eq(schema.subEvents.id, subEventId))

    const sheet = await discounts.discountSheet(eventId)
    expect(sheet.functions[0]!.venue.discountedPaise).toBe(0)
  })

  it('refuses a discounted price above the actual', async () => {
    const { eventId, subEventId } = await makeEvent({ venuePaise: 10_000_00 })
    await expect(
      discounts.setLineDiscounts(auditor, eventId, [{ key: `venue:${subEventId}`, discountedPaise: 11_000_00 }]),
    ).rejects.toThrow(/cannot be more than the actual/i)
  })

  it('takes a save with no remark (client, 20 Aug 2026)', async () => {
    const { eventId, subEventId } = await makeEvent()
    const res = await discounts.setLineDiscounts(bm, eventId, [{ key: `venue:${subEventId}`, discountedPaise: 9_000_00 }])
    expect(res.deferred).toBe(false)
    expect(res.changed).toBe(1)
  })

  it('taxes rooms on what is collected, and lets a discount move the band', async () => {
    // A ₹11,000 suite is an 18% room. Given for ₹7,000 a night it is a 5% room, because ₹7,000
    // is what the hotel collects on it (client, 20 Aug 2026). Two rooms, one night.
    const { eventId } = await makeEvent()
    await addRoom(eventId, 'presidential_suite', 11_000_00, 2)

    const before = await discounts.discountSheet(eventId)
    const line = before.roomGroups[0]!.lines[0]!
    expect(line.actualPaise).toBe(22_000_00)
    expect(line.gstRateBp).toBe(1800)
    expect(line.taxPaise).toBe(3_960_00)

    await discounts.setLineDiscounts(auditor, eventId, [{ key: line.key, discountedPaise: 14_000_00 }])

    const after = await discounts.discountSheet(eventId)
    const cut = after.roomGroups[0]!.lines[0]!
    expect(cut.discountedPaise).toBe(14_000_00)
    // ₹14,000 over 2 room-nights is ₹7,000 a night — at the threshold, not above it, so 5%.
    expect(cut.gstRateBp).toBe(500)
    expect(cut.taxPaise).toBe(700_00)
  })

  it('agrees to the paisa across the payable, the bill and the printed proposal', async () => {
    const { eventId, subEventId } = await makeEvent({ venuePaise: 10_000_00, perPlatePaise: 700_00, pax: 100 })
    await addRoom(eventId, 'deluxe', 4_500_00, 2)

    const sheet0 = await discounts.discountSheet(eventId)
    const roomKey = sheet0.roomGroups[0]!.lines[0]!.key
    await discounts.setLineDiscounts(auditor, eventId, [
      { key: `venue:${subEventId}`, discountedPaise: 8_000_00 },
      { key: `food:${subEventId}`, discountedPaise: 63_000_00 },
      { key: roomKey, discountedPaise: 8_000_00 },
    ])

    const sheet = await discounts.discountSheet(eventId)
    const bill = await computeBillLines(db, eventId)
    const payable = await payableBreakdown(eventId)
    const doc = await proposalDocument(eventId)

    const venueLine = bill.find((l) => l.section === 'venue')!
    const foodLine = bill.find((l) => l.section === 'food')!
    const roomLine = bill.find((l) => l.section === 'rooms')!
    expect(venueLine.amountPaise).toBe(8_000_00)
    expect(venueLine.grossAmountPaise).toBe(10_000_00) // the Actual column on the document
    expect(foodLine.amountPaise).toBe(63_000_00)
    expect(roomLine.amountPaise).toBe(8_000_00)

    // Rooms: ₹8,000 over 2 room-nights is ₹4,000 a night — 5%, and charged on the ₹8,000.
    expect(roomLine.gstRateBp).toBe(500)
    expect(roomLine.taxPaise).toBe(400_00)
    expect(sheet.roomsTaxPaise).toBe(400_00)
    expect(doc.totals.roomsTaxPaise).toBe(400_00)

    // Venue + food + rooms + the room tax. No lump discount exists, so nothing deducts after.
    expect(payable.payablePaise).toBe(8_000_00 + 63_000_00 + 8_000_00 + 400_00)
    expect(doc.totals.totalPaise).toBe(payable.payablePaise)
    expect(sheet.discountedTotalPaise).toBe(payable.payablePaise)

    // And the document carries the other column: the list price, and what was given off it.
    expect(doc.totals.actualProposalPaise).toBe(10_000_00 + 70_000_00)
    expect(doc.totals.actualRoomsPaise).toBe(9_000_00)
    expect(doc.totals.lineDiscountPaise).toBe(2_000_00 + 7_000_00 + 1_000_00)
  })

  it('sends a save over the 10% cap to the Authority as ONE request, and holds every cell', async () => {
    // Cap base is the ₹80,000 proposal total + rooms; 10% of it is the ceiling. Giving ₹20,000
    // across two lines crosses it, so BOTH lines wait — a half-applied save would leave the
    // booking at a price nobody quoted.
    const { eventId, subEventId } = await makeEvent({ venuePaise: 10_000_00, perPlatePaise: 700_00, pax: 100 })
    const res = await discounts.setLineDiscounts(bm, eventId, [
      { key: `venue:${subEventId}`, discountedPaise: 5_000_00 },
      { key: `food:${subEventId}`, discountedPaise: 55_000_00 },
    ])
    expect(res.deferred).toBe(true)

    const held = await discounts.discountSheet(eventId)
    expect(held.functions[0]!.venue.discountedPaise).toBe(10_000_00)
    expect(held.functions[0]!.venue.pending).toBe(true)
    expect(held.functions[0]!.food!.discountedPaise).toBe(70_000_00)
    expect(held.lineDiscountPaise).toBe(0)

    // One request in the queue, not one per cell.
    const pending = await db
      .select({ id: schema.exceptions.id })
      .from(schema.exceptions)
      .where(eq(schema.exceptions.eventId, eventId))
    expect(pending).toHaveLength(1)

    // Approved, both cells take effect together.
    await db.update(schema.exceptions).set({ status: 'approved' }).where(eq(schema.exceptions.id, pending[0]!.id))
    const live = await discounts.discountSheet(eventId)
    expect(live.functions[0]!.venue.discountedPaise).toBe(5_000_00)
    expect(live.functions[0]!.food!.discountedPaise).toBe(55_000_00)
    expect(live.lineDiscountPaise).toBe(20_000_00)
  })

  it('does not bind the Authority, wherever he gives it', async () => {
    const { eventId, subEventId } = await makeEvent({ venuePaise: 10_000_00, perPlatePaise: 700_00, pax: 100 })
    const res = await discounts.setLineDiscounts(auditor, eventId, [
      { key: `venue:${subEventId}`, discountedPaise: 0 },
      { key: `food:${subEventId}`, discountedPaise: 35_000_00 },
    ])
    expect(res.deferred).toBe(false)
    const sheet = await discounts.discountSheet(eventId)
    expect(sheet.lineDiscountPaise).toBe(10_000_00 + 35_000_00)
  })

  it('clears a line when the actual price is sent back', async () => {
    const { eventId, subEventId } = await makeEvent({ venuePaise: 10_000_00 })
    await discounts.setLineDiscounts(auditor, eventId, [{ key: `venue:${subEventId}`, discountedPaise: 9_000_00 }])
    await discounts.setLineDiscounts(auditor, eventId, [{ key: `venue:${subEventId}`, discountedPaise: 10_000_00 }])

    const sheet = await discounts.discountSheet(eventId)
    expect(sheet.lineDiscountPaise).toBe(0)
    const rows = await db.select({ id: schema.discounts.id }).from(schema.discounts).where(eq(schema.discounts.eventId, eventId))
    expect(rows).toHaveLength(0)
  })

  /**
   * A discount that is a PRICE is invisible to anything that reads the end-of-bill deduction,
   * because there is nothing left there to read. Two screens were quietly blanked by that and
   * are pinned here: the Billing panel's Discounts tile, and the revenue report.
   */
  it('still reports what the guest was given, though nothing is deducted at the end', async () => {
    const { eventId, subEventId } = await makeEvent({ venuePaise: 10_000_00, perPlatePaise: 700_00, pax: 100 })
    await discounts.setLineDiscounts(auditor, eventId, [{ key: `venue:${subEventId}`, discountedPaise: 6_000_00 }])

    const bill = await payableBreakdown(eventId)
    // Nothing deducts at the end — the ₹4,000 is off the venue line itself...
    expect(bill.discountPaise).toBe(0)
    // ...but the panel must still be able to say what was given, or it reads "—" on a booking
    // that was discounted a moment ago.
    expect(bill.givenDiscountPaise).toBe(4_000_00)
    expect(bill.payablePaise).toBe(6_000_00 + 70_000_00)
  })

  /**
   * The dashboard's "Payments due" tile used to compute what a guest owed itself: the proposal
   * total, less every discount, less payments. That base is venue + food ALONE — no rooms, no
   * room tax — so a ROOM discount subtracted money the base had never added and the tile
   * understated the debt. It reads the shared arithmetic now.
   */
  it('owes the same figure on the dashboard as on the billing panel, rooms discounted', async () => {
    const { eventId } = await makeEvent({ venuePaise: 10_000_00, perPlatePaise: 700_00, pax: 100 })
    await addRoom(eventId, 'deluxe', 4_500_00, 2)
    const sheet = await discounts.discountSheet(eventId)
    await discounts.setLineDiscounts(auditor, eventId, [
      { key: sheet.roomGroups[0]!.lines[0]!.key, discountedPaise: 5_000_00 },
    ])

    const panel = await payableBreakdown(eventId)
    const tile = (await balancesByEvent([eventId])).get(eventId)!

    expect(tile.payablePaise).toBe(panel.payablePaise)
    expect(tile.balancePaise).toBe(panel.balancePaise)
    // Venue 10,000 + food 70,000 + the room line at 5,000 + its 5% = 250.
    expect(tile.payablePaise).toBe(10_000_00 + 70_000_00 + 5_000_00 + 250_00)
  })

  it('survives the rooms being saved again, which deletes and re-inserts every line', async () => {
    // Rule 9: saving room requirements replaces every row. A discount keyed on the row's id
    // would be orphaned here; keyed on the category and the stay, it is still there.
    const { eventId } = await makeEvent()
    await addRoom(eventId, 'deluxe', 4_500_00, 2)
    const first = await discounts.discountSheet(eventId)
    await discounts.setLineDiscounts(auditor, eventId, [{ key: first.roomGroups[0]!.lines[0]!.key, discountedPaise: 8_000_00 }])

    await db.delete(schema.roomRequirements).where(eq(schema.roomRequirements.eventId, eventId))
    await addRoom(eventId, 'deluxe', 4_500_00, 2)

    const after = await discounts.discountSheet(eventId)
    expect(after.roomGroups[0]!.lines[0]!.discountedPaise).toBe(8_000_00)
  })
})
