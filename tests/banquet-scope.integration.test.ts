/**
 * A Banquet Manager's 15-day board shows only their own venues (client, 22 Jul 2026).
 *
 * The ownership lives on `properties`, because one manager covers several — Regency owns
 * Dipali Grand too. The board query is what enforces it, so it is exercised directly with a
 * function planted at each property and the scope of each manager checked in turn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'

const daysheet = await import('@/lib/daysheet')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping banquet-scope tests\n')

const FROM = '2027-04-01'
const eventIds: string[] = []

async function bmId(lodge: string): Promise<string> {
  const [u] = (await db.execute(sql`
    SELECT id FROM users WHERE full_name = ${'Banquet Manager — ' + lodge}
  `)) as unknown as { id: string }[]
  return u!.id
}
async function venueInProperty(propertyName: string): Promise<{ id: string; name: string }> {
  const [v] = (await db.execute(sql`
    SELECT v.id, v.name FROM venues v JOIN properties p ON p.id = v.property_id
    WHERE p.name = ${propertyName} AND v.is_active ORDER BY v.name LIMIT 1
  `)) as unknown as { id: string; name: string }[]
  return v!
}
/** A confirmed function on FROM at the given venue; returns the venue name for matching. */
async function functionAt(venueId: string): Promise<void> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [u] = (await db.execute(sql`SELECT id FROM users LIMIT 1`)) as unknown as { id: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({ code, guestName: `Scope ${code}`, eventType: 'engagement', status: 'confirmed', createdBy: u!.id })
    .returning({ id: schema.events.id })
  eventIds.push(ev!.id)
  await db.insert(schema.subEvents).values({
    eventId: ev!.id, name: 'Function', eventDate: FROM, startTime: '19:00', endTime: '23:00', venueId, pax: 100,
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
}, 120_000)

afterEach(async () => {
  if (!hasDb) return
  if (eventIds.length) {
    await db.delete(schema.venueBookings).where(inArray(schema.venueBookings.eventId, eventIds))
    await db.delete(schema.events).where(inArray(schema.events.id, eventIds))
    eventIds.length = 0
  }
})
afterAll(async () => {
  if (!hasDb) return
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
})

d('the board is scoped to a manager\'s own venues', () => {
  it('shows each manager only their property, and Regency also Dipali Grand', async () => {
    const palaceV = await venueInProperty('Palace')
    const regencyV = await venueInProperty('Regency')
    const grandV = await venueInProperty('Dipali Grand')
    await functionAt(palaceV.id)
    await functionAt(regencyV.id)
    await functionAt(grandV.id)

    const names = (r: { days: { functions: { venueName: string | null }[] }[] }) =>
      r.days.flatMap((day) => day.functions.map((f) => f.venueName)).filter(Boolean).sort()

    // Palace manager: only the Palace venue.
    const palace = await daysheet.getOperationsHorizon(FROM, 3, FROM, await bmId('Palace'))
    expect(names(palace)).toEqual([palaceV.name])

    // Regency manager: Regency AND Dipali Grand ("regency is the dipali grand").
    const regency = await daysheet.getOperationsHorizon(FROM, 3, FROM, await bmId('Regency'))
    expect(names(regency)).toEqual([grandV.name, regencyV.name].sort())

    // Residency manager: no Residency venue exists, so nothing.
    const residency = await daysheet.getOperationsHorizon(FROM, 3, FROM, await bmId('Residency'))
    expect(names(residency)).toEqual([])

    // Unscoped (the Chef, the Auditor, anyone): every function.
    const all = await daysheet.getOperationsHorizon(FROM, 3, FROM, null)
    expect(names(all)).toEqual([palaceV.name, regencyV.name, grandV.name].sort())
  }, 120_000)

  it('shows a bundle to every manager who owns a piece of it', async () => {
    // A bundle can span venues in more than one property; each owner should see it. Build a
    // throwaway bundle from a Palace venue and a Regency venue.
    const palaceV = await venueInProperty('Palace')
    const regencyV = await venueInProperty('Regency')
    const [bundle] = await db.insert(schema.venueBundles).values({ name: `ZZScopeBundle ${FROM}` }).returning({ id: schema.venueBundles.id })
    await db.insert(schema.venueBundleMembers).values([
      { bundleId: bundle!.id, venueId: palaceV.id },
      { bundleId: bundle!.id, venueId: regencyV.id },
    ])
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [u] = (await db.execute(sql`SELECT id FROM users LIMIT 1`)) as unknown as { id: string }[]
    const [ev] = await db.insert(schema.events).values({ code, guestName: 'Bundle Scope', eventType: 'engagement', status: 'confirmed', createdBy: u!.id }).returning({ id: schema.events.id })
    eventIds.push(ev!.id)
    await db.insert(schema.subEvents).values({ eventId: ev!.id, name: 'Function', eventDate: FROM, startTime: '19:00', endTime: '23:00', bundleId: bundle!.id, pax: 100 })

    try {
      const seenBy = async (lodge: string) => {
        const r = await daysheet.getOperationsHorizon(FROM, 3, FROM, await bmId(lodge))
        return r.days.some((day) => day.functions.length > 0)
      }
      expect(await seenBy('Palace')).toBe(true)   // owns a member venue
      expect(await seenBy('Regency')).toBe(true)  // owns the other
      expect(await seenBy('Residency')).toBe(false) // owns neither
    } finally {
      await db.delete(schema.venueBundleMembers).where(eq(schema.venueBundleMembers.bundleId, bundle!.id))
      // event first (references bundle via sub_event), then the bundle
      await db.delete(schema.events).where(eq(schema.events.id, ev!.id))
      eventIds.length = 0
      await db.delete(schema.venueBundles).where(eq(schema.venueBundles.id, bundle!.id))
    }
  }, 120_000)
})
