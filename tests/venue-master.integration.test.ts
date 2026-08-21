/**
 * The venue master (module `venue_master`, client 12 Aug 2026).
 *
 * The rule this file exists to defend is the difference between **a rate of zero** and **no
 * rate at all**. They look the same in a table and behave nothing alike: zero is a decision
 * (the venue is sold and costs nothing for that event type — how an "Other" booking gets its
 * hall free), while an absent rate is a gate that takes the venue off the standalone picker
 * and blocks confirmation until the Authority approves a manual rate (BR-R1). Blur them and
 * either a hall is given away by accident or a booking dead-ends for no reason.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

const master = await import('@/lib/venue-master')
const pricing = await import('@/lib/pricing')
const availability = await import('@/lib/availability')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping venue-master tests\n')

const auditor = { id: '', roleName: 'auditor' }
const PREFIX = 'ZZTest'
let palaceId = ''

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
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'auditor' LIMIT 1
  `)) as unknown as { id: string }[]
  auditor.id = u!.id
  const [p] = (await db.execute(sql`SELECT id FROM properties WHERE name = 'Palace'`)) as unknown as { id: string }[]
  palaceId = p!.id
}, 120_000)

async function cleanup() {
  await db.execute(sql`DELETE FROM venue_rate_cards WHERE venue_id IN (SELECT id FROM venues WHERE name LIKE ${PREFIX + '%'})`)
  await db.execute(sql`DELETE FROM venue_bundle_members WHERE bundle_id IN (SELECT id FROM venue_bundles WHERE name LIKE ${PREFIX + '%'})`)
  await db.execute(sql`DELETE FROM venue_rate_cards WHERE bundle_id IN (SELECT id FROM venue_bundles WHERE name LIKE ${PREFIX + '%'})`)
  await db.execute(sql`DELETE FROM venue_bundles WHERE name LIKE ${PREFIX + '%'}`)
  await db.execute(sql`DELETE FROM venue_bundle_members WHERE venue_id IN (SELECT id FROM venues WHERE name LIKE ${PREFIX + '%'})`)
  await db.execute(sql`DELETE FROM venues WHERE name LIKE ${PREFIX + '%'}`)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

async function makeVenue(name: string): Promise<string> {
  // No capacity: it gates nothing and is shown nowhere, so the form stopped asking for it
  // (client, 13 Aug 2026). A new venue records none rather than an invented range.
  const { id } = await master.createVenue(auditor, {
    propertyId: palaceId,
    name: `${PREFIX} ${name}`,
    kind: 'hall',
  })
  return id
}

d('zero is a price; absent is a gate', () => {
  it('creates a venue with NO rate, and that blocks pricing rather than costing nothing', async () => {
    const venueId = await makeVenue('Unpriced')
    // A new venue is deliberately unpriced: creating one at zero would put a free hall on the
    // board that nobody chose to give away.
    expect(await pricing.venueRatePaise({ venueId, bundleId: null }, 'wedding', '2027-01-01')).toBeNull()

    const priced = await pricing.priceProposal('wedding', [
      { id: 'sub-1', name: 'Function', eventDate: '2027-01-01', startTime: '19:00', venueId, bundleId: null },
    ])
    expect(priced.missing).toHaveLength(1) // BR-R1 gate, not a free hall
    expect(priced.totalPaise).toBe(0)
  }, 120_000)

  it('prices at zero and that is a charge of nothing, not a gate', async () => {
    const venueId = await makeVenue('Free')
    await master.setRate(auditor, { venueId }, { eventType: 'wedding', ratePaise: 0, effectiveFrom: '2026-01-01' })

    expect(await pricing.venueRatePaise({ venueId, bundleId: null }, 'wedding', '2027-01-01')).toBe(0)
    const priced = await pricing.priceProposal('wedding', [
      { id: 'sub-1', name: 'Function', eventDate: '2027-01-01', startTime: '19:00', venueId, bundleId: null },
    ])
    expect(priced.missing).toHaveLength(0) // confirm is NOT blocked
    expect(priced.totalPaise).toBe(0)
  }, 120_000)

  it('offers a zero-rated venue on the picker but hides an unpriced one', async () => {
    const free = await makeVenue('Offered')
    await master.setRate(auditor, { venueId: free }, { eventType: 'wedding', ratePaise: 0, effectiveFrom: '2026-01-01' })
    await makeVenue('Hidden') // no rate at all

    const avail = await availability.listVenueAvailability('2027-01-01', '18:00', '23:00')
    const names = avail.venues.map((v) => v.name)
    expect(names).toContain(`${PREFIX} Offered`)
    expect(names).not.toContain(`${PREFIX} Hidden`)
  }, 120_000)

  it('turns a priced venue back into a gate when the rate is removed', async () => {
    const venueId = await makeVenue('Withdrawn')
    await master.setRate(auditor, { venueId }, { eventType: 'wedding', ratePaise: 500_000, effectiveFrom: '2026-01-01' })
    expect(await pricing.venueRatePaise({ venueId, bundleId: null }, 'wedding', '2027-01-01')).toBe(500_000)

    await master.clearRate(auditor, { venueId }, 'wedding')
    expect(await pricing.venueRatePaise({ venueId, bundleId: null }, 'wedding', '2027-01-01')).toBeNull()
    await expect(master.clearRate(auditor, { venueId }, 'wedding')).rejects.toMatchObject({ status: 404 })
  }, 120_000)
})

d('rates are dated, so a re-price never moves an old booking', () => {
  it('keeps the older rate for a date before the new one takes effect', async () => {
    const venueId = await makeVenue('Dated')
    await master.setRate(auditor, { venueId }, { eventType: 'wedding', ratePaise: 100_000, effectiveFrom: '2026-01-01' })
    await master.setRate(auditor, { venueId }, { eventType: 'wedding', ratePaise: 250_000, effectiveFrom: '2027-06-01' })

    // Priced on the SUB-EVENT's date, so May's wedding keeps May's price.
    expect(await pricing.venueRatePaise({ venueId, bundleId: null }, 'wedding', '2027-05-31')).toBe(100_000)
    expect(await pricing.venueRatePaise({ venueId, bundleId: null }, 'wedding', '2027-06-01')).toBe(250_000)
  }, 120_000)

  it('corrects a rate in place when the same date is set twice', async () => {
    const venueId = await makeVenue('Corrected')
    await master.setRate(auditor, { venueId }, { eventType: 'wedding', ratePaise: 100_000, effectiveFrom: '2026-01-01' })
    await master.setRate(auditor, { venueId }, { eventType: 'wedding', ratePaise: 120_000, effectiveFrom: '2026-01-01' })

    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM venue_rate_cards WHERE venue_id = ${venueId} AND event_type = 'wedding'
    `)) as unknown as { n: number }[]
    expect(n).toBe(1) // corrected, not duplicated
    expect(await pricing.venueRatePaise({ venueId, bundleId: null }, 'wedding', '2027-01-01')).toBe(120_000)
  }, 120_000)
})

d('bundles', () => {
  it('refuses a bundle of fewer than two venues', async () => {
    const a = await makeVenue('Solo')
    await expect(
      master.createBundle(auditor, { name: `${PREFIX} Lonely`, venueIds: [a] }),
    ).rejects.toMatchObject({ status: 400 })
  }, 120_000)

  it('creates a bundle and prices it independently of its members', async () => {
    const a = await makeVenue('Alpha')
    const b = await makeVenue('Beta')
    const { id: bundleId } = await master.createBundle(auditor, { name: `${PREFIX} Pair`, venueIds: [a, b] })
    await master.setRate(auditor, { bundleId }, { eventType: 'other', ratePaise: 900_000, effectiveFrom: '2026-01-01' })

    // A bundle keeps its price for an "Other" booking — the catch in the client's rule.
    expect(await pricing.venueRatePaise({ venueId: null, bundleId }, 'other', '2027-01-01')).toBe(900_000)
    // Its members are still unpriced on their own: membership is not a price.
    expect(await pricing.venueRatePaise({ venueId: a, bundleId: null }, 'other', '2027-01-01')).toBeNull()
  }, 120_000)

  it('refuses to change the membership of a bundle that is already booked', async () => {
    const a = await makeVenue('Gamma')
    const b = await makeVenue('Delta')
    const c = await makeVenue('Epsilon')
    const { id: bundleId } = await master.createBundle(auditor, { name: `${PREFIX} Booked`, venueIds: [a, b] })

    const [bm] = (await db.execute(sql`
      SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'booking_manager' LIMIT 1
    `)) as unknown as { id: string }[]
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [ev] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Bundle Test', eventType: 'other', createdBy: bm!.id })
      .returning({ id: schema.events.id })
    await db.insert(schema.subEvents).values({
      eventId: ev!.id, name: 'Function', eventDate: '2027-01-01', startTime: '18:00', endTime: '23:00',
      bundleId, pax: 50,
    })

    // Membership decides which halls that booking HOLDS (FR-2.3) — changing it would silently
    // move what has already been sold.
    await expect(
      master.updateBundle(auditor, bundleId, { venueIds: [a, c] }),
    ).rejects.toMatchObject({ status: 409 })
    // A rename is still fine: it moves nothing.
    await master.updateBundle(auditor, bundleId, { name: `${PREFIX} Renamed` })

    await db.delete(schema.events)
  }, 120_000)
})

d('a venue records no capacity unless it came with one', () => {
  it('creates a venue with NULL capacity rather than an invented range', async () => {
    const venueId = await makeVenue('NoSeats')
    const [row] = (await db.execute(sql`
      SELECT capacity_min AS "min", capacity_max AS "max" FROM venues WHERE id = ${venueId}
    `)) as unknown as { min: number | null; max: number | null }[]
    // NULL, not 0 — "nobody wrote it down" is a different claim from "seats nobody".
    expect(row!.min).toBeNull()
    expect(row!.max).toBeNull()
  }, 120_000)

  it('leaves the seeded figures alone — they are real', async () => {
    const [row] = (await db.execute(sql`
      SELECT capacity_min AS "min", capacity_max AS "max" FROM venues WHERE name = 'Kohinoor'
    `)) as unknown as { min: number; max: number }[]
    expect(row!.min).toBe(150) // from the hotel's own proposal
    expect(row!.max).toBe(250)
  }, 120_000)
})

d('only the two bookable event types are offered', () => {
  it('prices Wedding and Others, and nothing a booking cannot be made as', async () => {
    const cat = await master.getVenueCatalog()
    // The table carries six rows; the wizard has only ever offered two, so a price for the
    // other four is four columns the Auditor reads past on every venue.
    expect(cat.eventTypes.map((t) => t.code)).toEqual(['wedding', 'other'])
    expect(cat.eventTypes.map((t) => t.displayName)).toEqual(['Wedding', 'Others'])
  }, 120_000)
})

d('the seeded card matches what the client priced', () => {
  it('gives every standalone hall a free "Other" rate and leaves bundles charged', async () => {
    const cat = await master.getVenueCatalog()
    const seeded = cat.venues.filter((v) => !v.name.startsWith(PREFIX) && v.rates.length > 0)
    expect(seeded.length).toBeGreaterThan(0)
    for (const v of seeded) {
      const other = v.rates.find((r) => r.eventType === 'other' && r.current)
      expect(other?.ratePaise, `${v.name} should be free for Other`).toBe(0)
    }
    for (const b of cat.bundles.filter((x) => !x.name.startsWith(PREFIX))) {
      const other = b.rates.find((r) => r.eventType === 'other' && r.current)
      expect(other?.ratePaise, `${b.name} should still be charged`).toBeGreaterThan(0)
    }
  }, 120_000)

  it('carries the prices the client gave on 12 Aug 2026', async () => {
    const cat = await master.getVenueCatalog()
    const wedding = (name: string) =>
      cat.venues.find((v) => v.name === name)?.rates.find((r) => r.eventType === 'wedding' && r.current)?.ratePaise
    expect(wedding('Signature')).toBe(20_000_000)
    expect(wedding('Crystal')).toBe(15_100_000)
    expect(wedding('Imperial')).toBe(7_500_000)
    expect(wedding('Kohinoor')).toBe(5_500_000)
    expect(wedding('Saffron Hall & Lawn')).toBe(3_500_000) // 35,000 — supersedes the PDF's 55,000
    expect(wedding('Ashoka Hall')).toBe(2_500_000)
    expect(wedding('Diamond Hall')).toBe(2_500_000)
    expect(wedding('Golden Hall')).toBe(2_500_000)
    expect(wedding('Pool Side Hall')).toBe(500_000)
  }, 120_000)
})
