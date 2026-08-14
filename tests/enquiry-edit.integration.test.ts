/**
 * Everything on a proposal is editable until it is confirmed (client, 15 Aug 2026).
 *
 * `PUT /sub-events/:id` has existed since M3 and NOTHING EVER CALLED IT — the only way to change
 * a function's venue was to delete it and add it back, which threw the menu away with it. Now
 * that the booking page edits in place, the route's behaviour matters, and two things about it
 * are worth pinning:
 *
 *   - IT RECOMPUTES THE PROPOSAL TOTAL. Venue and pax are both priced, so an edit that did not
 *     recompute left the quoted figure stale until something else happened to save a menu.
 *     That was invisible while nothing called it; it would not be now.
 *   - IT REFUSES A CONFIRMED BOOKING. An enquiry holds no venue_bookings, so moving its date or
 *     venue moves nothing. A confirmed function is a held slot and belongs to the change-request
 *     flow — the boundary the client drew ("unless it is confirmed").
 *
 * And the menu must survive the edit, since losing it is the whole reason this exists.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'

// The route handlers read the caller from the iron-session cookie; the same mock the user-admin
// suite uses swaps that for a plain variable, so a test can act as a given user.
const { sessionState } = vi.hoisted(() => ({ sessionState: { userId: undefined as string | undefined } }))
vi.mock('@/lib/session', () => ({
  getSession: async () => ({
    get userId() { return sessionState.userId },
    set userId(v: string | undefined) { sessionState.userId = v },
    save: async () => {},
    destroy: () => { sessionState.userId = undefined },
  }),
}))

const { PUT: putSubEvent } = await import('@/app/api/v1/sub-events/[id]/route')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping enquiry-edit tests\n')

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

function req(body: unknown): NextRequest {
  return new NextRequest('http://test/api/v1/sub-events/x', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Calls the route as the Booking Manager. */
function edit(subId: string, body: unknown) {
  sessionState.userId = bm.id
  return putSubEvent(req(body), { params: Promise.resolve({ id: subId }) })
}

async function makeEnquiry(): Promise<{ eventId: string; subId: string; venueA: string; venueB: string }> {
  const [{ code }] = (await db.execute(
    sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
  )) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Edit Test', eventType: 'engagement', status: 'enquiry', createdBy: bm.id })
    .returning({ id: schema.events.id })

  // Two venues with different rate cards, so a venue change is visible in the total.
  const venues = (await db.execute(sql`
    SELECT v.id, v.name, rc.rate_paise AS rate
    FROM venues v JOIN venue_rate_cards rc ON rc.venue_id = v.id
    WHERE rc.event_type = 'engagement' AND rc.rate_paise > 0
    ORDER BY rc.rate_paise LIMIT 2
  `)) as unknown as { id: string; name: string; rate: number }[]

  const [sub] = await db
    .insert(schema.subEvents)
    .values({
      eventId: e!.id, name: 'Function', eventDate: '2026-11-01',
      startTime: '11:00', endTime: '15:00', venueId: venues[0]!.id, pax: 100,
    })
    .returning({ id: schema.subEvents.id })
  return { eventId: e!.id, subId: sub!.id, venueA: venues[0]!.id, venueB: venues[1]!.id }
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
  bm.id = await userId('booking_manager')
}, 90_000)

async function cleanup() {
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('editing a function on an enquiry', () => {
  it('changes date, time, venue and pax, and re-prices the proposal', async () => {
    const { eventId, subId, venueB } = await makeEnquiry()
    const before = (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!

    const res = await edit(subId, {
      name: 'Reception', event_date: '2026-11-03', start_time: '18:00', end_time: '23:00',
      venue_id: venueB, pax: 250,
    })
    expect(res.status).toBe(200)

    const [sub] = await db.select().from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    expect(sub!.name).toBe('Reception')
    expect(sub!.eventDate).toBe('2026-11-03')
    expect(String(sub!.startTime).slice(0, 5)).toBe('18:00')
    expect(sub!.venueId).toBe(venueB)
    expect(sub!.pax).toBe(250)

    // The quoted figure moved with the venue — the thing the old route did not do.
    const after = (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!
    expect(after.proposalTotalPaise).toBeGreaterThan(Number(before.proposalTotalPaise))
  })

  it('keeps the menu — the reason delete-and-re-add was not good enough', async () => {
    const { subId } = await makeEnquiry()
    const [tier] = await db.select().from(schema.menuTiers).where(eq(schema.menuTiers.name, 'Silver')).limit(1)
    await db.insert(schema.subEventMenus).values({
      subEventId: subId, tierId: tier!.id, tierName: 'Silver', baseRatePaise: 65_000, surchargePaise: 0,
    })

    const [cur] = await db.select().from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    await edit(subId, {
      name: 'Moved', event_date: '2026-11-05', start_time: '12:00', end_time: '16:00',
      pax: 120, venue_id: cur!.venueId!,
    })

    const menus = await db.select().from(schema.subEventMenus).where(eq(schema.subEventMenus.subEventId, subId))
    expect(menus).toHaveLength(1)
    expect(menus[0]!.tierName).toBe('Silver')
  })

  it('records what actually moved, field by field', async () => {
    const { eventId, subId, venueA } = await makeEnquiry()
    await edit(subId, {
      name: 'Function', event_date: '2026-11-01', start_time: '11:00', end_time: '15:00',
      venue_id: venueA, pax: 175,
    })
    const trail = (await db.execute(sql`
      SELECT field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log
      WHERE event_id = ${eventId} AND entity = 'sub_events' ORDER BY seq
    `)) as unknown as { field: string; oldValue: string | null; newValue: string }[]
    // Only pax changed, so only pax is in the trail — not "the function changed".
    expect(trail.map((t) => t.field)).toEqual(['pax'])
    expect(trail[0]!.oldValue).toBe('100')
    expect(trail[0]!.newValue).toBe('175')
  })

  it('refuses once the booking is confirmed — that is the change-request flow', async () => {
    const { eventId, subId, venueB } = await makeEnquiry()
    await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, eventId))

    const res = await edit(subId, {
      name: 'Function', event_date: '2026-11-01', start_time: '11:00', end_time: '15:00',
      venue_id: venueB, pax: 100,
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.message).toMatch(/change request/i)
  })
})
