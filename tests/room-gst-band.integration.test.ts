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

afterEach(async () => { if (hasDb) await db.delete(schema.events) })
afterAll(async () => { if (hasDb) await db.delete(schema.events) })

d('the band itself', () => {
  it('turns on strictly above ₹7,500 a night', () => {
    expect(tax.roomGstBp(700_000, 'deluxe')).toBe(500)
    // Exactly ₹7,500 stays at 5% — "greater than", not "at least".
    expect(tax.roomGstBp(750_000, 'suite')).toBe(500)
    expect(tax.roomGstBp(750_001, 'suite')).toBe(1800)
    expect(tax.roomGstBp(1_100_000, 'presidential_suite')).toBe(1800)
  })

  it('exempts a dormitory whatever it costs', () => {
    // Palace's is ₹35,000 a night and Regency's ₹50,000, but the rate buys a room of 18–30
    // beds rather than a bed, so the threshold does not speak to it (client, 17 Aug 2026).
    expect(tax.roomGstBp(3_500_000, 'dormitory')).toBe(500)
    expect(tax.roomGstBp(5_000_000, 'dormitory')).toBe(500)
    // Keyed on the name, since `room_type` is free text and a lodge names its own categories.
    expect(tax.roomGstBp(5_000_000, 'Ladies Dormitory')).toBe(500)
    expect(tax.roomGstBp(5_000_000, 'dorm_a')).toBe(500)
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
  it('stays at 5% at ₹35,000 a night, in the estimate, the payable, the bill and the document', async () => {
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
    const fivePercent = Math.round((amount * 500) / 10000)

    expect((await pricing.roomEstimatePaise(e!.id)).roomsTaxPaise).toBe(fivePercent)
    expect((await schedule.payableBreakdown(e!.id)).roomsTaxPaise).toBe(fivePercent)

    const dorm = (await invoice.computeBillLines(db, e!.id)).find((l) => l.section === 'rooms')!
    expect(dorm.gstRateBp).toBe(500)
    expect(dorm.taxPaise).toBe(fivePercent)

    const doc = await proposal.proposalDocument(e!.id)
    expect(doc.totals.roomTaxSplit.high.basePaise).toBe(0) // nothing to print an 18% line for
    expect(doc.totals.roomTaxSplit.low.basePaise).toBe(amount)
    expect(doc.lodges[0]!.lines[0]!.gstRateBp).toBe(500)
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
