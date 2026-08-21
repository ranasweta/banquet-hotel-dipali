/**
 * The hall is hired by the DAY, not by the function (client, 12 Aug 2026).
 *
 * Staff hit this in the field: a booking with three functions in one hall on one day was
 * charged the hire three times. The guest took the room for the day — check-in 8 AM, check-out
 * 7:59 the next morning — and however many functions run inside that window, it is one let.
 *
 * This file pins the arithmetic in all FOUR places it is computed, because they are four
 * separate code paths and a fix in one is worth nothing if another still triples the charge:
 * `priceProposal` (the proposal total and the discount cap), `computeBillLines` (the Draft),
 * `proposalDocument` (what the guest is handed), and `payableRows` (the amount payable, the
 * 25% advance, the wedding 50% and the balance).
 *
 * The fourth was added on 20 Aug 2026, having been missed: it had no dedupe at all, so the one
 * figure money is actually collected against charged the day once per function while the three
 * documents charged it once. The overlap rule is NOT relaxed — windows still may not collide
 * (BR-C1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

const pricing = await import('@/lib/pricing')
const proposal = await import('@/lib/proposal')
const invoice = await import('@/lib/invoice')
const schedule = await import('@/lib/payment-schedule')
const availability = await import('@/lib/availability')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping venue-day tests\n')

let bmId = ''
let hallA = ''
let hallB = ''
let rateA = 0
let rateB = 0

/** A venue with a rate card for `engagement`, and what that rate is. */
async function ratedVenue(skip: number): Promise<{ id: string; rate: number }> {
  const [row] = (await db.execute(sql`
    SELECT v.id, rc.rate_paise AS rate
    FROM venues v
    JOIN venue_rate_cards rc ON rc.venue_id = v.id AND rc.event_type = 'engagement'
    WHERE v.is_active
    ORDER BY v.name
    OFFSET ${skip} LIMIT 1
  `)) as unknown as { id: string; rate: number }[]
  return { id: row!.id, rate: Number(row!.rate) }
}

async function makeEvent(): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Day Hire Test', eventType: 'engagement', createdBy: bmId })
    .returning({ id: schema.events.id })
  return ev!.id
}

async function addFunction(
  eventId: string,
  name: string,
  date: string,
  startTime: string,
  endTime: string,
  venueId: string,
): Promise<string> {
  const [se] = await db
    .insert(schema.subEvents)
    .values({ eventId, name, eventDate: date, startTime, endTime, venueId, pax: 100 })
    .returning({ id: schema.subEvents.id })
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
  bmId = u!.id
  const a = await ratedVenue(0)
  const b = await ratedVenue(1)
  hallA = a.id
  rateA = a.rate
  hallB = b.id
  rateB = b.rate
}, 120_000)

async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('one hall, one day, one charge', () => {
  it('charges the hire once for three functions in the same hall on the same day', async () => {
    const eventId = await makeEvent()
    // Three non-overlapping windows, as BR-C1 requires. This is the case that was billed 3x.
    const morning = await addFunction(eventId, 'Haldi', '2027-09-01', '09:00', '12:00', hallA)
    const evening = await addFunction(eventId, 'Sangeet', '2027-09-01', '18:00', '21:00', hallA)
    const night = await addFunction(eventId, 'Reception', '2027-09-01', '21:00', '23:30', hallA)

    const subs = await pricing.loadSubEventsForPricing(eventId)
    const priced = await pricing.priceProposal('engagement', subs)

    expect(priced.totalPaise).toBe(rateA) // once, not three times
    expect(priced.rates.get(morning)).toBe(rateA) // the day's FIRST function carries it
    expect(priced.rates.get(evening)).toBe(0)
    expect(priced.rates.get(night)).toBe(0)
    expect(priced.coveredBy.get(evening)).toBe(morning)
    expect(priced.coveredBy.get(night)).toBe(morning)
    expect(priced.missing).toHaveLength(0) // covered is not the same as unrated
  }, 120_000)

  /**
   * THE MORNING AFTER (client, 21 Aug 2026). A wedding runs in Gulmohar until midnight and
   * breakfast is served in the same hall at 6 the next morning. The hall was never given back:
   * the let that began at 8 AM on the wedding day runs to 8 AM the next morning, so the
   * breakfast is inside it and there is nothing more to charge. Keyed on the calendar date, as
   * this was, it billed a second full day's hire for an hour of tea.
   */
  it('does not charge again for a function that is out of the hall by 8 AM', async () => {
    const eventId = await makeEvent()
    const wedding = await addFunction(eventId, 'Wedding', '2027-09-01', '19:00', '23:59', hallA)
    const breakfast = await addFunction(eventId, 'Breakfast', '2027-09-02', '06:00', '07:00', hallA)

    const priced = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(eventId))
    expect(priced.totalPaise).toBe(rateA) // one let, not two
    expect(priced.rates.get(wedding)).toBe(rateA)
    expect(priced.rates.get(breakfast)).toBe(0)
    expect(priced.coveredBy.get(breakfast)).toBe(wedding)

    // The other three readers must agree, or the bill and the balance charge the morning twice.
    const billVenue = (await invoice.computeBillLines(db, eventId))
      .filter((l) => l.section === 'venue')
      .reduce((n, l) => n + l.amountPaise, 0)
    expect(billVenue).toBe(rateA)
    const doc = await proposal.proposalDocument(eventId)
    expect(doc.totals.proposalPaise).toBe(rateA)
    expect(doc.functions.find((f) => f.name === 'Breakfast')!.venueCoveredBy).toBe('Wedding')
    expect((await schedule.payableBreakdown(eventId)).payablePaise).toBe(rateA)
  }, 120_000)

  /**
   * THE DAY THAT OPENS WITH BREAKFAST (client, 21 Aug 2026, on the first cut of the rule above).
   * An engagement breakfast at 7 AM, lunch at noon and a sangeet in the evening — all in
   * Imperial, all on one day. The early-morning shift pushed the breakfast onto the day before,
   * where NOTHING was booked, so it invented a second let and the guest was charged the hire
   * twice: the very fault this rule exists to prevent, arriving from the other side.
   *
   * There is no previous let to belong to, so the breakfast stays on its own day and shares it.
   */
  it('charges one hire when the day opens early and runs past 8 AM', async () => {
    const eventId = await makeEvent()
    const breakfast = await addFunction(eventId, 'Engagement breakfast', '2027-09-05', '07:00', '10:00', hallA)
    const lunch = await addFunction(eventId, 'Engagement lunch', '2027-09-05', '12:00', '15:00', hallA)
    const sangeet = await addFunction(eventId, 'Sangeet', '2027-09-05', '19:00', '23:59', hallA)

    const priced = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(eventId))
    expect(priced.totalPaise).toBe(rateA) // ONE hire for the day, not two
    expect(priced.rates.get(breakfast)).toBe(rateA) // the day's earliest carries it
    expect(priced.rates.get(lunch)).toBe(0)
    expect(priced.rates.get(sangeet)).toBe(0)

    const billVenue = (await invoice.computeBillLines(db, eventId))
      .filter((l) => l.section === 'venue')
      .reduce((n, l) => n + l.amountPaise, 0)
    expect(billVenue).toBe(rateA)
    expect((await proposal.proposalDocument(eventId)).totals.proposalPaise).toBe(rateA)
    expect((await schedule.payableBreakdown(eventId)).payablePaise).toBe(rateA)
  }, 120_000)

  /**
   * THE BOUNDARY, TO THE MINUTE (client, 21 Aug 2026): "7:59 AM — checkout (until this time no
   * double charging). 8:00 AM — checkin (charge of the venue from first event starts from
   * here)." There is no gap between the two: 07:59 is the last minute of one let and 08:00 is
   * the first minute of the next. Both sides are pinned so neither can drift.
   */
  it('lets a checkout at 08:00 go free and charges one a minute later', async () => {
    const onTime = await makeEvent()
    const nightA = await addFunction(onTime, 'Wedding', '2027-09-01', '19:00', '23:59', hallA)
    const outAtEight = await addFunction(onTime, 'Breakfast', '2027-09-02', '06:00', '08:00', hallA)
    const a = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(onTime))
    expect(a.totalPaise).toBe(rateA)
    expect(a.coveredBy.get(outAtEight)).toBe(nightA)

    const overstayed = await makeEvent()
    await addFunction(overstayed, 'Wedding', '2027-09-01', '19:00', '23:59', hallA)
    const outAtEightOhOne = await addFunction(overstayed, 'Breakfast', '2027-09-02', '06:00', '08:01', hallA)
    const b = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(overstayed))
    expect(b.totalPaise).toBe(rateA * 2)
    expect(b.rates.get(outAtEightOhOne)).toBe(rateA)
    expect(b.coveredBy.has(outAtEightOhOne)).toBe(false)
  }, 120_000)

  /**
   * The case the start-time rule got backwards: a breakfast that begins at 6 but keeps the hall
   * until 10 has run well into the new let, and is charged for it — "if checkout of event
   * exceeds 8 AM then it will be charged" (client, 21 Aug 2026).
   */
  it('charges a breakfast that keeps the hall past 8 AM, however early it started', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'Wedding', '2027-09-01', '19:00', '23:59', hallA)
    const long = await addFunction(eventId, 'Long breakfast', '2027-09-02', '06:00', '10:00', hallA)
    const priced = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(eventId))
    expect(priced.totalPaise).toBe(rateA * 2)
    expect(priced.rates.get(long)).toBe(rateA)
  }, 120_000)

  it('charges each day separately when the same hall is taken on two dates', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'Day one', '2027-09-01', '18:00', '23:00', hallA)
    await addFunction(eventId, 'Day two', '2027-09-02', '18:00', '23:00', hallA)

    const priced = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(eventId))
    expect(priced.totalPaise).toBe(rateA * 2)
    expect(priced.coveredBy.size).toBe(0)
  }, 120_000)

  it('charges each hall separately when the venue changes on the same day', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'Ceremony', '2027-09-01', '10:00', '13:00', hallA)
    await addFunction(eventId, 'Party', '2027-09-01', '19:00', '23:00', hallB)

    const priced = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(eventId))
    expect(priced.totalPaise).toBe(rateA + rateB) // a different hall is a different let
    expect(priced.coveredBy.size).toBe(0)
  }, 120_000)

  it('treats a function running past midnight as one day, not two', async () => {
    const eventId = await makeEvent()
    // 8 PM to 6 AM: end_time <= start_time is the past-midnight window (BR-C1). It belongs to
    // the day it STARTED on, so a second function that morning shares the same hire.
    const night = await addFunction(eventId, 'Night', '2027-09-01', '20:00', '06:00', hallA)
    const brunch = await addFunction(eventId, 'Brunch', '2027-09-01', '11:00', '14:00', hallA)

    const priced = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(eventId))
    expect(priced.totalPaise).toBe(rateA)
    // Brunch is earlier in the day, so it carries the charge and the night is covered.
    expect(priced.rates.get(brunch)).toBe(rateA)
    expect(priced.coveredBy.get(night)).toBe(brunch)
  }, 120_000)
})

d('an "Other" booking pays for the dining, not for the hall', () => {
  /** Same shape as makeEvent, but the event type is the caller's. */
  async function eventOfType(type: string): Promise<string> {
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [ev] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Other Test', eventType: type, createdBy: bmId })
      .returning({ id: schema.events.id })
    return ev!.id
  }

  it('charges nothing for a standalone hall', async () => {
    const eventId = await eventOfType('other')
    await addFunction(eventId, 'Party', '2027-09-01', '18:00', '23:00', hallA)

    const priced = await pricing.priceProposal('other', await pricing.loadSubEventsForPricing(eventId))
    expect(priced.totalPaise).toBe(0)
    // Zero is a DECISION, not the missing-rate gate — confirm must not be blocked by it.
    expect(priced.missing).toHaveLength(0)
  }, 120_000)

  it('still charges for a bundle', async () => {
    const [bundle] = (await db.execute(sql`
      SELECT b.id, rc.rate_paise AS rate
      FROM venue_bundles b
      JOIN venue_rate_cards rc ON rc.bundle_id = b.id AND rc.event_type = 'other'
      ORDER BY b.name LIMIT 1
    `)) as unknown as { id: string; rate: number }[]

    const eventId = await eventOfType('other')
    const [se] = await db
      .insert(schema.subEvents)
      .values({
        eventId, name: 'Party', eventDate: '2027-09-01', startTime: '18:00', endTime: '23:00',
        bundleId: bundle!.id, pax: 100,
      })
      .returning({ id: schema.subEvents.id })
    expect(se).toBeTruthy()

    const priced = await pricing.priceProposal('other', await pricing.loadSubEventsForPricing(eventId))
    // "if they select bundle then thats okay we take that money" — the catch in the rule.
    expect(priced.totalPaise).toBe(Number(bundle!.rate))
    expect(priced.totalPaise).toBeGreaterThan(0)
  }, 120_000)

  it('leaves every other event type paying full price', async () => {
    // The client scoped this to "Other" alone: engagement, mahila sangeet, birthday and
    // corporate go on paying exactly what they paid before.
    for (const type of ['engagement', 'mahila_sangeet', 'birthday', 'corporate']) {
      const eventId = await eventOfType(type)
      await addFunction(eventId, 'Function', '2027-09-01', '18:00', '23:00', hallA)
      const priced = await pricing.priceProposal(type, await pricing.loadSubEventsForPricing(eventId))
      expect(priced.totalPaise, `${type} should still pay the hall`).toBe(rateA)
    }
  }, 120_000)

  it('keeps a free hall on offer — free is a price, not a missing rate', async () => {
    const avail = await availability.listVenueAvailability('2027-09-01', '18:00', '23:00')
    expect(avail.venues.map((v) => v.name)).toContain('Ashoka Hall')
    expect(avail.venues.map((v) => v.name)).toContain('Diamond Hall')
    // Still bundle-only: no standalone rate card was ever written for these two.
    expect(avail.venues.map((v) => v.name)).not.toContain('Gulmohar Lawn')
  }, 120_000)
})

d('the bill and the printed proposal agree with the total', () => {
  it('puts ONE venue line on the bill for three functions in one hall', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'Haldi', '2027-09-01', '09:00', '12:00', hallA)
    await addFunction(eventId, 'Sangeet', '2027-09-01', '18:00', '21:00', hallA)
    await addFunction(eventId, 'Reception', '2027-09-01', '21:00', '23:30', hallA)

    const lines = await invoice.computeBillLines(db, eventId)
    const venueLines = lines.filter((l) => l.section === 'venue')
    expect(venueLines).toHaveLength(1)
    expect(venueLines[0]!.amountPaise).toBe(rateA)
    // On the day's first function, matching lib/pricing.ts — the two documents must not
    // disagree about where the charge sits, never mind what it is.
    expect(venueLines[0]!.functionLabel).toBe('Haldi')
  }, 120_000)

  it('shows the covered functions as included rather than as a second charge', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'Haldi', '2027-09-01', '09:00', '12:00', hallA)
    await addFunction(eventId, 'Sangeet', '2027-09-01', '18:00', '21:00', hallA)

    const doc = await proposal.proposalDocument(eventId)
    const [first, second] = doc.functions

    expect(first!.venueRatePaise).toBe(rateA)
    expect(first!.venueCoveredBy).toBeNull()
    // Zero AND named — a blank reads as an omission, and null would mean "no rate card" (BR-R1).
    expect(second!.venueRatePaise).toBe(0)
    expect(second!.venueCoveredBy).toBe('Haldi')

    // The sub-totals follow, so the document adds up to what the guest is asked to pay.
    expect(first!.subtotalPaise).toBe(rateA)
    expect(second!.subtotalPaise).toBe(0)
    expect(doc.totals.proposalPaise).toBe(rateA)
  }, 120_000)

  /**
   * THE FOURTH PATH, and the one that decides money (20 Aug 2026). `payableRows` summed the
   * hire straight over every sub_event with no venue-day dedupe, so this exact booking was
   * charged the day twice in the amount payable while all three paths above charged it once.
   *
   * That figure is not display: the 25% advance and the wedding 50% are percentages of it, and
   * the balance is payable − paid. A guest who settled in full against the printed proposal
   * would have been left short for ever, unable to reach zero and so unable to be closed —
   * and the screen asked for more than the document in their hand said.
   */
  it('charges the amount payable once, and agrees with all three documents', async () => {
    const eventId = await makeEvent()
    await addFunction(eventId, 'Haldi', '2027-09-01', '09:00', '12:00', hallA)
    await addFunction(eventId, 'Sangeet', '2027-09-01', '18:00', '21:00', hallA)
    await addFunction(eventId, 'Reception', '2027-09-01', '21:00', '23:30', hallA)

    const priced = await pricing.priceProposal('engagement', await pricing.loadSubEventsForPricing(eventId))
    const billVenue = (await invoice.computeBillLines(db, eventId))
      .filter((l) => l.section === 'venue')
      .reduce((n, l) => n + l.amountPaise, 0)
    const doc = await proposal.proposalDocument(eventId)
    const bill = await schedule.payableBreakdown(eventId)

    expect(priced.totalPaise).toBe(rateA)
    expect(billVenue).toBe(rateA)
    expect(doc.totals.proposalPaise).toBe(rateA)
    // No menus, no rooms, no discount on this booking, so the payable IS the day's hire.
    expect(bill.payablePaise).toBe(rateA)
    expect(bill.preEventPayablePaise).toBe(rateA)
  }, 120_000)

  it('still charges two days, and two halls, once each', async () => {
    const twoDays = await makeEvent()
    await addFunction(twoDays, 'Day one', '2027-09-01', '18:00', '23:00', hallA)
    await addFunction(twoDays, 'Day two', '2027-09-02', '18:00', '23:00', hallA)
    expect((await schedule.payableBreakdown(twoDays)).payablePaise).toBe(rateA * 2)

    const twoHalls = await makeEvent()
    await addFunction(twoHalls, 'Ceremony', '2027-09-03', '10:00', '13:00', hallA)
    await addFunction(twoHalls, 'Party', '2027-09-03', '19:00', '23:00', hallB)
    expect((await schedule.payableBreakdown(twoHalls)).payablePaise).toBe(rateA + rateB)
  }, 120_000)
})
