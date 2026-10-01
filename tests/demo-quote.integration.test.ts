/**
 * The demo proposal (client's lead, 1 Oct 2026) prices with the real rules and writes nothing.
 *
 * Pinned: one hall-hire per venue-day, the wedding surcharge on the plate, room GST by the
 * nightly rate, payable/total/advance arithmetic — and that no event or hold is created.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

const { demoQuote } = await import('@/lib/demo-quote')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping demo-quote tests\n')

let hall = { id: '', rate: 0 }
let tier = { id: '', base: 0, surcharge: 0 }
let room = { unitId: '', roomType: '', rate: 0 }

beforeAll(async () => {
  if (!hasDb) return
  const setup = createClient('TEST_DATABASE_URL')
  try {
    await migrate(setup, () => {})
    await seed(setup, { reset: true, force: true, password: 'test-only' }, () => {})
  } finally {
    await setup.end()
  }
  const [h] = (await db.execute(sql`
    SELECT v.id, rc.rate_paise AS rate FROM venues v
    JOIN venue_rate_cards rc ON rc.venue_id = v.id AND rc.event_type = 'wedding'
    WHERE v.is_active AND rc.rate_paise > 0 ORDER BY v.name LIMIT 1
  `)) as unknown as { id: string; rate: number }[]
  hall = { id: h!.id, rate: Number(h!.rate) }
  const [t] = (await db.execute(sql`
    SELECT tier_id AS id, base_rate_paise AS base, wedding_surcharge_paise AS surcharge
    FROM menu_tier_prices WHERE effective_from <= CURRENT_DATE AND wedding_surcharge_paise > 0
    ORDER BY effective_from DESC LIMIT 1
  `)) as unknown as { id: string; base: number; surcharge: number }[]
  tier = { id: t!.id, base: Number(t!.base), surcharge: Number(t!.surcharge) }
  const [r] = (await db.execute(sql`
    SELECT unit_id AS "unitId", room_type AS "roomType", min(rack_rate_paise) AS rate
    FROM rooms WHERE is_active AND room_type NOT ILIKE '%dorm%'
    GROUP BY unit_id, room_type HAVING min(rack_rate_paise) <= 750000 LIMIT 1
  `)) as unknown as { unitId: string; roomType: string; rate: number }[]
  room = { unitId: r!.unitId, roomType: r!.roomType, rate: Number(r!.rate) }
}, 120_000)

d('demoQuote', () => {
  it('prices like a proposal and saves nothing', async () => {
    const [{ n: before }] = (await db.execute(sql`SELECT count(*)::int AS n FROM events`)) as unknown as { n: number }[]
    const fn = (name: string, start: string, end: string, pax: number) => ({
      name, eventDate: '2027-02-02', startTime: start, endTime: end, venueId: hall.id, bundleId: null, pax, tierId: tier.id,
    })
    const q = await demoQuote({
      eventType: 'wedding',
      functions: [fn('Lunch', '12:00', '16:00', 100), fn('Dinner', '19:00', '23:00', 200)],
      rooms: [{ unitId: room.unitId, roomType: room.roomType, count: 3, nights: 2 }],
    })

    const plate = tier.base + tier.surcharge
    // The hall once for the day, carried by the earlier function.
    expect(q.functions.map((f) => f.venuePaise)).toEqual([hall.rate, 0])
    expect(q.functions.map((f) => f.perPlatePaise)).toEqual([plate, plate])
    expect(q.functionsPaise).toBe(hall.rate + plate * 300)
    expect(q.roomsPaise).toBe(room.rate * 6)
    expect(q.roomTaxPaise).toBe(Math.round((room.rate * 6 * 500) / 10000))
    expect(q.payablePaise).toBe(q.functionsPaise + q.roomsPaise + q.roomTaxPaise)
    expect(q.displayTotalPaise).toBe(q.payablePaise + q.shownGstPaise)
    expect(q.advancePaise).toBe(Math.round(q.payablePaise * 0.25))
    expect(q.missingVenueRates).toEqual([])

    const [{ n: after }] = (await db.execute(sql`SELECT count(*)::int AS n FROM events`)) as unknown as { n: number }[]
    expect(after).toBe(before)
  })
})
