/**
 * The ₹7,500 room GST band (client, 17 Aug 2026) — `lib/tax.ts`, `roomGstBp`.
 *
 * "if the room price is greater then 7500 then on it we will take 18% rather then 5% tax but
 * that 18% tax will be added to payable" — so this is nothing like the 18% on venue and food.
 * That one is printed and collected from nobody (rule 11); THIS one is money. It enters the
 * payable amount, the 25% advance, the wedding 50% and the balance, exactly as the 5% does.
 *
 * The two ways it could go quietly wrong, and what each test here defends:
 *
 *   - THE BAND IS READ OFF THE NIGHTLY RATE, NOT THE LINE TOTAL. Six nights of a ₹5,000 Deluxe
 *     is ₹30,000 of accommodation and still 5%. Testing the amount instead would tax half the
 *     hotel at 18% and nobody would notice until a guest added it up.
 *   - THE 18% ON A ROOM IS COLLECTED. If it fell into `shownTaxPaise` with the other 18%, the
 *     hotel would print the charge and never take it — the mirror image of overcharging, and
 *     invisible until the year's accounts.
 *
 * Palace's seed carries both bands: Deluxe at ₹5,000 (5%) and Suite at ₹8,000 (18%), so one
 * booking can hold one of each and the two must not blend.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const tax = await import('@/lib/tax')
const pricing = await import('@/lib/pricing')
const schedule = await import('@/lib/payment-schedule')
const invoice = await import('@/lib/invoice')
const proposal = await import('@/lib/proposal')
const lodgeExtras = await import('@/lib/lodge-extras')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping room GST band tests\n')

const auditor = { id: '', roleName: 'auditor' }
const lodge = { id: '', roleName: 'lodge_manager' }
let palace = ''

/** Deluxe ₹5,000 and Suite ₹8,000 — read from the seed rather than assumed. */
const RATES = { deluxe: 0, suite: 0 }

async function userId(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}

async function rate(roomType: string): Promise<number> {
  const [r] = (await db.execute(sql`
    SELECT min(r.rack_rate_paise)::bigint AS rate FROM rooms r
    WHERE r.unit_id = ${palace} AND r.room_type = ${roomType} AND r.is_active
  `)) as unknown as { rate: number }[]
  return Number(r!.rate)
}

/**
 * A booking with one function and rooms on both sides of the threshold: two Deluxe and one
 * Suite, each for two nights.
 */
async function makeBooking(status = 'in_progress'): Promise<string> {
  const [{ code }] = (await db.execute(
    sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
  )) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({
      code,
      guestName: 'Room GST Band Test',
      eventType: 'engagement',
      status: status as 'in_progress',
      createdBy: auditor.id,
    })
    .returning({ id: schema.events.id })
  const [venue] = await db.select({ id: schema.venues.id }).from(schema.venues).limit(1)
  await db.insert(schema.subEvents).values({
    eventId: e!.id, name: 'Function', eventDate: '2027-10-01', startTime: '11:00', endTime: '15:00',
    venueId: venue!.id, pax: 100, venueRatePaise: 10_000_000,
  })
  await db.insert(schema.roomRequirements).values([
    { eventId: e!.id, unitId: palace, roomType: 'deluxe', count: 2, checkIn: '2027-10-01', checkOut: '2027-10-03' },
    { eventId: e!.id, unitId: palace, roomType: 'suite', count: 1, checkIn: '2027-10-01', checkOut: '2027-10-03' },
  ])
  return e!.id
}

const deluxeAmount = () => RATES.deluxe * 2 * 2 // 2 rooms × 2 nights
const suiteAmount = () => RATES.suite * 1 * 2 // 1 room × 2 nights
const expectedRoomTax = () =>
  Math.round((deluxeAmount() * 500) / 10000) + Math.round((suiteAmount() * 1800) / 10000)

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
  const [p] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = 'Palace'`)) as unknown as { id: string }[]
  palace = p!.id
  RATES.deluxe = await rate('deluxe')
  RATES.suite = await rate('suite')
}, 90_000)

/** Invoices first — they reference the event and do not cascade with it. */
async function cleanup() {
  await db.delete(schema.invoices)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('the band itself', () => {
  it('turns on strictly above ₹7,500 a night', () => {
    expect(tax.roomGstBp(700_000, 'deluxe')).toBe(500)
    // Exactly ₹7,500 stays at 5% — "greater than", not "at least".
    expect(tax.roomGstBp(750_000, 'suite')).toBe(500)
    expect(tax.roomGstBp(750_001, 'suite')).toBe(1800)
    expect(tax.roomGstBp(1_100_000, 'presidential_suite')).toBe(1800)
  })

  it('charges a dormitory no room GST at all', () => {
    // Palace's is ₹35,000 a night and Regency's ₹50,000, but the rate buys a room of 18–30
    // beds rather than a bed, so the threshold does not speak to it (client, 17 Aug 2026). It
    // was held at 5% until the client settled it at nil on 8 Sep 2026.
    expect(tax.roomGstBp(3_500_000, 'dormitory')).toBe(0)
    expect(tax.roomGstBp(5_000_000, 'dormitory')).toBe(0)
    // Cheap or dear makes no difference — it is the category, not the rate.
    expect(tax.roomGstBp(100_000, 'dormitory')).toBe(0)
    // Keyed on the name, since `room_type` is free text and a lodge names its own categories.
    expect(tax.roomGstBp(5_000_000, 'Ladies Dormitory')).toBe(0)
    expect(tax.roomGstBp(5_000_000, 'dorm_a')).toBe(0)
    expect(tax.isDormitory('DORMITORY')).toBe(true)
    expect(tax.isDormitory('suite')).toBe(false)
  })

  it('never blends into the 18% that is only shown', () => {
    // A room line is collected whichever band it is in; that is what keeps a suite's 18% out
    // of `shownTaxPaise` and inside the balance.
    expect(tax.isCollectedSection('rooms')).toBe(true)
    expect(tax.isCollectedSection('food')).toBe(false)
  })
})

d('a booking with rooms on both sides of the line', () => {
  it('prices the estimate at 5% and 18% per line, never one blended rate', async () => {
    const e = await makeBooking()
    const est = await pricing.roomEstimatePaise(e)
    expect(est.roomsPaise).toBe(deluxeAmount() + suiteAmount())
    expect(est.roomsTaxPaise).toBe(expectedRoomTax())
    // Not the old flat 5% — the suite's share alone is worth ₹2,880 more.
    expect(est.roomsTaxPaise).toBeGreaterThan(Math.round((est.roomsPaise * 500) / 10000))
  }, 90_000)

  it('puts the 18% inside the payable amount and the 25% advance', async () => {
    const e = await makeBooking()
    const bill = await schedule.payableBreakdown(e)
    expect(bill.roomsTaxPaise).toBe(expectedRoomTax())
    // The whole room tax is in the payable, so the balance can reach zero.
    expect(bill.payablePaise).toBe(10_000_000 + bill.roomsPaise + bill.roomsTaxPaise)

    const plan = await schedule.paymentSchedule(e)
    expect(plan.milestones[0]!.requiredPaise).toBe(
      Math.round((plan.preEventPayablePaise * 25) / 100),
    )
    // The advance base carries it too — a suite raises what has to be collected to confirm.
    expect(plan.preEventPayablePaise).toBe(bill.payablePaise)
  }, 90_000)

  it('bills the suite as a rooms line at 1800 bp, and it is collected', async () => {
    const e = await makeBooking()
    const lines = await invoice.computeBillLines(db, e)
    const rooms = lines.filter((l) => l.section === 'rooms')
    const suite = rooms.find((l) => l.description.includes('suite'))!
    const deluxe = rooms.find((l) => l.description.includes('deluxe'))!

    expect(deluxe.gstRateBp).toBe(500)
    expect(suite.gstRateBp).toBe(1800)
    expect(suite.taxPaise).toBe(Math.round((suiteAmount() * 1800) / 10000))
    // Section stays `rooms`, which is what makes the 18% collected rather than merely shown.
    expect(suite.section).toBe('rooms')
    expect(await invoice.shownTaxPaise(e)).toBe(
      lines
        .filter((l) => l.section !== 'rooms')
        .reduce((n, l) => n + l.taxPaise, 0),
    )
  }, 90_000)

  it('bifurcates the printed document, with the money each band was charged on', async () => {
    const e = await makeBooking()
    const doc = await proposal.proposalDocument(e)
    const { low, high } = doc.totals.roomTaxSplit

    expect(low.basePaise).toBe(deluxeAmount())
    expect(low.taxPaise).toBe(Math.round((deluxeAmount() * 500) / 10000))
    expect(high.basePaise).toBe(suiteAmount())
    expect(high.taxPaise).toBe(Math.round((suiteAmount() * 1800) / 10000))

    // The split is a VIEW of the collected room tax, never an addition to it.
    expect(low.taxPaise + high.taxPaise).toBe(doc.totals.roomsTaxPaise + doc.totals.extraRoomsTaxPaise)
    expect(doc.totals.roomsTaxPaise).toBe(expectedRoomTax())
  }, 90_000)

  it('agrees to the paisa across the estimate, the payable and the bill', async () => {
    const e = await makeBooking()
    const [est, bill, lines, doc] = await Promise.all([
      pricing.roomEstimatePaise(e),
      schedule.payableBreakdown(e),
      invoice.computeBillLines(db, e),
      proposal.proposalDocument(e),
    ])
    const billed = lines.filter((l) => l.section === 'rooms').reduce((n, l) => n + l.taxPaise, 0)
    expect(est.roomsTaxPaise).toBe(bill.roomsTaxPaise)
    expect(billed).toBe(bill.roomsTaxPaise)
    expect(doc.totals.roomsTaxPaise).toBe(bill.roomsTaxPaise)

    // And the whole figure, not just the tax on it: the Draft's Amount Payable is what
    // the booking page's header card shows, and both are `payableBreakdown`. They are
    // built by two separate modules, so nothing but this stops them drifting apart and
    // leaving the screen asking for a different number than the paper in the guest's hand.
    expect(doc.totals.totalPaise).toBe(bill.payablePaise)
  }, 90_000)
})

d('the band follows the nightly rate, not the size of the line', () => {
  it('leaves a long cheap stay at 5% however large the total grows', async () => {
    const [{ code }] = (await db.execute(
      sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
    )) as unknown as { code: string }[]
    const [e] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Long Stay', eventType: 'other', createdBy: auditor.id })
      .returning({ id: schema.events.id })
    // 10 Deluxe for 6 nights = ₹3,00,000 of accommodation, all of it at ₹5,000 a night.
    await db.insert(schema.roomRequirements).values({
      eventId: e!.id, unitId: palace, roomType: 'deluxe', count: 10,
      checkIn: '2027-10-01', checkOut: '2027-10-07',
    })
    const est = await pricing.roomEstimatePaise(e!.id)
    expect(est.roomsPaise).toBe(RATES.deluxe * 10 * 6)
    expect(est.roomsTaxPaise).toBe(Math.round((est.roomsPaise * 500) / 10000))
  }, 90_000)
})

d('a dormitory is exempt, end to end', () => {
  it('draws no room GST at ₹35,000 a night, in the estimate, the payable, the bill and the document', async () => {
    const dormRate = await rate('dormitory')
    expect(dormRate).toBeGreaterThan(750_000) // the seed's is ₹35,000 — well over the threshold

    const [{ code }] = (await db.execute(
      sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
    )) as unknown as { code: string }[]
    const [e] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Dormitory Party', eventType: 'other', createdBy: auditor.id })
      .returning({ id: schema.events.id })
    await db.insert(schema.roomRequirements).values({
      eventId: e!.id, unitId: palace, roomType: 'dormitory', count: 1,
      checkIn: '2027-10-01', checkOut: '2027-10-03',
    })

    const amount = dormRate * 2

    // Nil in every one of the four, and the ROOM is still charged — it is the tax that is
    // exempt, not the accommodation.
    expect((await pricing.roomEstimatePaise(e!.id)).roomsPaise).toBe(amount)
    expect((await pricing.roomEstimatePaise(e!.id)).roomsTaxPaise).toBe(0)
    expect((await schedule.payableBreakdown(e!.id)).roomsTaxPaise).toBe(0)

    const dorm = (await invoice.computeBillLines(db, e!.id)).find((l) => l.section === 'rooms')!
    expect(dorm.gstRateBp).toBe(0)
    expect(dorm.taxPaise).toBe(0)

    const doc = await proposal.proposalDocument(e!.id)
    expect(doc.totals.roomTaxSplit.high.basePaise).toBe(0) // nothing to print an 18% line for
    // And nothing in the 5% line either: printing "GST 5% — rooms on ₹70,000" beside ₹0.00 of
    // tax is a base the guest cannot multiply out. The dormitory's money is its own band.
    expect(doc.totals.roomTaxSplit.low.basePaise).toBe(0)
    expect(doc.totals.roomTaxSplit.exempt.basePaise).toBe(amount)
    expect(doc.totals.roomTaxSplit.exempt.taxPaise).toBe(0)
    expect(doc.lodges[0]!.lines[0]!.gstRateBp).toBe(0)
  }, 90_000)

  /**
   * WHICH BOOKINGS THE CHANGE REACHES, and the one kind it does not.
   *
   * Nothing stores a room's tax: `roomGstBp` is read at the point of every estimate, payable,
   * bill and document, so every booking that existed before 8 Sep 2026 and has not been billed
   * re-prices the moment the constant changes — no backfill, no migration, nothing to touch.
   * The test above is that guarantee: its event is built from bare `room_requirements` rows,
   * exactly as an existing booking's are, and four different readers agree on nil.
   *
   * A DRAFTED INVOICE is the exception, and deliberately so. `invoice_lines.gst_rate_bp` and
   * `tax_paise` are snapshotted when the Draft is raised, because a document the guest holds is
   * a record of what was charged and not a live view. So an invoice drafted under the old 5%
   * keeps it until somebody re-issues — which is the sanctioned path (CLAUDE.md rule 6), and
   * recomputes the line at nil. This pins both halves so the boundary is a decision on the
   * record rather than a surprise on a bill.
   */
  it('keeps a drafted invoice as issued, and drops the tax when it is re-issued', async () => {
    const dormRate = await rate('dormitory')
    const [{ code }] = (await db.execute(
      sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
    )) as unknown as { code: string }[]
    const [e] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Dormitory Party', eventType: 'other', createdBy: auditor.id })
      .returning({ id: schema.events.id })
    await db.insert(schema.roomRequirements).values({
      eventId: e!.id, unitId: palace, roomType: 'dormitory', count: 1,
      checkIn: '2027-10-01', checkOut: '2027-10-03',
    })
    const amount = dormRate * 2
    const oldTax = Math.round((amount * 500) / 10000)

    await db.transaction(async (tx) => { await invoice.draftInvoice(tx, auditor, e!.id) })

    // Put the Draft back the way 7 Sep would have raised it: the dormitory at 5%.
    await db.execute(sql`
      UPDATE invoice_lines SET gst_rate_bp = 500, tax_paise = ${oldTax}
       WHERE section = 'rooms'
         AND invoice_id = (SELECT id FROM invoices WHERE event_id = ${e!.id} AND superseded_at IS NULL)
    `)
    await db.execute(sql`
      UPDATE invoices SET tax_paise = ${oldTax}, net_paise = ${amount + oldTax}, balance_paise = ${amount + oldTax}
       WHERE event_id = ${e!.id} AND superseded_at IS NULL
    `)

    // Frozen: the document says what it said when it was raised.
    const before = (await invoice.getInvoice(e!.id))!
    expect(before.taxPaise).toBe(oldTax)
    expect(before.lines.find((l) => l.section === 'rooms')!.gstRateBp).toBe(500)

    // Re-issued: recomputed from `computeBillLines`, so the exemption lands.
    await db.transaction(async (tx) => {
      await invoice.reissueInvoice(tx, auditor, e!.id, 'Dormitory GST withdrawn (client, 8 Sep 2026)')
    })
    const after = (await invoice.getInvoice(e!.id))!
    expect(after.taxPaise).toBe(0)
    expect(after.lines.find((l) => l.section === 'rooms')!.gstRateBp).toBe(0)
    expect(after.lines.find((l) => l.section === 'rooms')!.taxPaise).toBe(0)
    // The room is still charged; only its tax went.
    expect(after.lines.find((l) => l.section === 'rooms')!.amountPaise).toBe(amount)
  }, 90_000)
})

d('rooms handed over on the day', () => {
  it('bands the Lodge Manager’s extras the same way, and collects the 18%', async () => {
    const e = await makeBooking()
    await lodgeExtras.addRoomLine(lodge, e, { unitId: palace, roomType: 'suite', count: 2, nights: 1 })
    await lodgeExtras.addRoomLine(lodge, e, { unitId: palace, roomType: 'deluxe', count: 1, nights: 1 })

    const view = await lodgeExtras.getLodgeExtras(e)
    const extraSuite = RATES.suite * 2
    const extraDeluxe = RATES.deluxe * 1
    expect(view.roomsTaxPaise).toBe(
      Math.round((extraSuite * 1800) / 10000) + Math.round((extraDeluxe * 500) / 10000),
    )
    // The panel tells the desk which band each line is in.
    expect(view.rooms.map((r) => r.gstRateBp).sort((a, b) => a - b)).toEqual([500, 1800])

    // Still nothing until the close — the band changes the rate, not when it counts.
    expect((await schedule.payableBreakdown(e)).extraRoomsTaxPaise).toBe(0)
    await lodgeExtras.closeLodgeExtras(lodge, e)
    const after = await schedule.payableBreakdown(e)
    expect(after.extraRoomsTaxPaise).toBe(view.roomsTaxPaise)
    // Collected: it is in the payable and so in the balance.
    expect(after.payablePaise).toBe(
      after.preEventPayablePaise + after.extraRoomsPaise + after.extraRoomsTaxPaise,
    )
    // And outside the pre-event base, exactly as before (rule 12's split is untouched).
    expect(after.preEventPayablePaise).toBe(10_000_000 + after.roomsPaise + after.roomsTaxPaise)
  }, 90_000)
})
