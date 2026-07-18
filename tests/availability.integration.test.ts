/**
 * M2 acceptance: the venue time-overlap engine (BR-C1, amended). Drives checkAvailability
 * against the test database loaded with the demo bookings, at a fixed base date so the
 * demo's day offsets are deterministic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// checkAvailability is server-only; the stub in vitest.config lets it import under node.
const { checkAvailability, listVenueAvailability } = await import('@/lib/availability')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { loadDemo } = await import('@/db/demo')
const { db, schema } = await import('@/db/drizzle')
const { eq } = await import('drizzle-orm')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping availability tests\n')

// Fixed so demo offsets are stable: Crystal Haldi 07-20 10-13 & Sangeet 07-20 19-23,
// Wedding 07-21 11-15, Reception 07-21 20:00 → 07-22 01:00; Imperial+Kohinoor bundle
// 07-23 18:00-23:30; Signature 07-17 09-17; Gulmohar 07-22 19-23.
const BASE = '2026-07-17'

let crystalId: string
let signatureId: string
let imperialId: string
let bundleId: string

beforeAll(async () => {
  if (!hasDb) return
  const setup = createClient('TEST_DATABASE_URL')
  try {
    await migrate(setup, () => {})
    await seed(setup, { reset: true, force: true, password: 'test-only' }, () => {})
    await loadDemo(setup, BASE, () => {})
  } finally {
    await setup.end()
  }
  const venueId = async (name: string) =>
    (await db.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.name, name)).limit(1))[0]!.id
  crystalId = await venueId('Crystal')
  signatureId = await venueId('Signature')
  imperialId = await venueId('Imperial')
  bundleId = (
    await db
      .select({ id: schema.venueBundles.id })
      .from(schema.venueBundles)
      .where(eq(schema.venueBundles.name, 'Imperial + Kohinoor'))
      .limit(1)
  )[0]!.id
}, 90_000)

afterAll(async () => {
  if (!hasDb) return
  // venue_bookings.event_id is NOT ON DELETE CASCADE, so clear bookings before events.
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
})

d('same venue, same day, multiple functions', () => {
  it('accepts a window that fits between two existing bookings', async () => {
    // Between Haldi (10-13) and Sangeet (19-23) on Crystal, 2026-07-20.
    const r = await checkAvailability({ venueId: crystalId, date: '2026-07-20', startTime: '14:00', endTime: '18:00' })
    expect(r.available).toBe(true)
    expect(r.conflicts).toHaveLength(0)
  })

  it('rejects a window overlapping an existing booking, naming the clash', async () => {
    const r = await checkAvailability({ venueId: crystalId, date: '2026-07-20', startTime: '12:00', endTime: '14:00' })
    expect(r.available).toBe(false)
    expect(r.conflicts.map((c) => c.subEventName)).toContain('Haldi')
  })

  it('accepts back-to-back — a window starting exactly when another ends', async () => {
    // Haldi ends 13:00; a booking 13:00-16:00 does not overlap (half-open ranges).
    const r = await checkAvailability({ venueId: crystalId, date: '2026-07-20', startTime: '13:00', endTime: '16:00' })
    expect(r.available).toBe(true)
  })
})

d('venue availability list (the wizard "free venues only" filter)', () => {
  it('marks a venue booked for an overlapping window and free otherwise', async () => {
    // 2026-07-20 12:00-14:00 overlaps Crystal's Haldi (10-13).
    const overlap = await listVenueAvailability('2026-07-20', '12:00', '14:00')
    expect(overlap.venues.find((v) => v.id === crystalId)?.available).toBe(false)
    // Signature has no booking then → still offered.
    expect(overlap.venues.find((v) => v.id === signatureId)?.available).toBe(true)

    // A gap that fits (14:00-18:00) → Crystal is free again.
    const gap = await listVenueAvailability('2026-07-20', '14:00', '18:00')
    expect(gap.venues.find((v) => v.id === crystalId)?.available).toBe(true)
  })

  it('marks a bundle unavailable when any member is booked', async () => {
    // Imperial+Kohinoor bundle is booked 07-23 18:00-23:30.
    const r = await listVenueAvailability('2026-07-23', '20:00', '22:00')
    expect(r.bundles.find((b) => b.id === bundleId)?.available).toBe(false)
  })
})

d('past-midnight windows', () => {
  it('blocks the next morning behind a booking that ran past midnight', async () => {
    // Reception 07-21 20:00 → 07-22 01:00. A 07-22 00:30 start clashes with the tail.
    const r = await checkAvailability({ venueId: crystalId, date: '2026-07-22', startTime: '00:30', endTime: '02:00' })
    expect(r.available).toBe(false)
    expect(r.conflicts.map((c) => c.subEventName)).toContain('Reception')
  })

  it('is free again after the tail ends', async () => {
    const r = await checkAvailability({ venueId: crystalId, date: '2026-07-22', startTime: '01:00', endTime: '03:00' })
    expect(r.available).toBe(true)
  })
})

d('bundles (FR-2.3)', () => {
  it('blocks a member venue when the bundle is booked', async () => {
    // Imperial + Kohinoor bundle booked 07-23 18:00-23:30; Imperial alone clashes.
    const r = await checkAvailability({ venueId: imperialId, date: '2026-07-23', startTime: '19:00', endTime: '21:00' })
    expect(r.available).toBe(false)
  })

  it('blocks the bundle when a member window is taken', async () => {
    const r = await checkAvailability({ bundleId, date: '2026-07-23', startTime: '20:00', endTime: '22:00' })
    expect(r.available).toBe(false)
    expect(r.venueIds.length).toBeGreaterThanOrEqual(2) // expanded to members
  })

  it('leaves the bundle free on a clear night', async () => {
    const r = await checkAvailability({ bundleId, date: '2026-07-28', startTime: '18:00', endTime: '23:00' })
    expect(r.available).toBe(true)
  })
})

d('venue isolation', () => {
  it('does not report a clash from a different venue at the same time', async () => {
    // Crystal is busy 07-20 evening; Signature is not.
    const r = await checkAvailability({ venueId: signatureId, date: '2026-07-20', startTime: '19:00', endTime: '23:00' })
    expect(r.available).toBe(true)
  })

  it('reports unavailable for an unknown target (no venue resolved)', async () => {
    const r = await checkAvailability({ date: '2026-07-20', startTime: '10:00', endTime: '12:00' })
    expect(r.available).toBe(false)
    expect(r.venueIds).toHaveLength(0)
  })
})
