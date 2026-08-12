/**
 * The hall is hired by the DAY, not by the function (client, 12 Aug 2026).
 *
 * Staff hit this in the field: a booking with three functions in one hall on one day was
 * charged the hire three times. The guest took the room for the day — 9 AM to 8 AM the next
 * morning — and however many functions run inside that window, it is one let.
 *
 * This file pins the arithmetic in all three places it is computed, because they are three
 * separate code paths and a fix in one is worth nothing if another still triples the charge:
 * `priceProposal` (the proposal total, and therefore the payable, the advance base and the
 * discount cap), `computeBillLines` (the Draft), and `proposalDocument` (what the guest is
 * handed). The overlap rule is NOT relaxed — windows still may not collide (BR-C1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

const pricing = await import('@/lib/pricing')
const proposal = await import('@/lib/proposal')
const invoice = await import('@/lib/invoice')
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
})
