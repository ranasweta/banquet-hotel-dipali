/**
 * Searching and filtering the proposals list (client, 22 Aug 2026: "add a search bar in the past
 * proposal such that we can type name of the client and search, also give a filter too for
 * events and also from-to dates to get which are the events in the given timeline").
 *
 * Three things are worth pinning, and one of them is a bug the feature would otherwise inherit:
 *
 *   - THE DATE FILTER MUST NOT READ `first_date`. That column is a cache written at confirm and
 *     is routinely NULL on an enquiry that plainly has functions, so a range filter built on it
 *     silently drops exactly the old proposals someone is hunting for. The functions' own dates
 *     decide, with the declared run answering for a proposal that has none yet.
 *   - THE RANGE OVERLAPS, it does not contain: a wedding running 28–30 Jan is found by a search
 *     for the 29th, which is how a person actually looks for "what is on that day".
 *   - SEARCH RUNS ON THE SERVER, so it reaches past the 200-row cap the list is drawn from.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'

const { sessionState } = vi.hoisted(() => ({ sessionState: { userId: undefined as string | undefined } }))
vi.mock('@/lib/session', () => ({
  getSession: async () => ({
    get userId() { return sessionState.userId },
    set userId(v: string | undefined) { sessionState.userId = v },
    save: async () => {},
    destroy: () => { sessionState.userId = undefined },
  }),
}))

const { GET: listEvents } = await import('@/app/api/v1/events/route')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping bookings-search tests\n')

const bm = { id: '' }

type Row = { id: string; code: string; guestName: string; startDate: string | null; endDate: string | null }

/** Calls GET /events with a query string, as the Booking Manager. */
async function list(qs: string): Promise<{ events: Row[]; eventTypes: { code: string }[] }> {
  sessionState.userId = bm.id
  const res = await listEvents(new NextRequest(`http://test/api/v1/events${qs}`))
  return (await res.json()) as { events: Row[]; eventTypes: { code: string }[] }
}

/**
 * A proposal with one function. `cacheFirstDate: false` leaves `first_date` NULL, which is what
 * an unconfirmed booking normally looks like and what the old filter choked on.
 */
async function makeProposal(opts: {
  guest: string
  eventType?: string
  dates: string[]
  cacheFirstDate?: boolean
}): Promise<string> {
  const { guest, eventType = 'wedding', dates, cacheFirstDate = false } = opts
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({
      code,
      guestName: guest,
      eventType,
      plannedFrom: dates[0]!,
      plannedTo: dates[dates.length - 1]!,
      firstDate: cacheFirstDate ? dates[0]! : null,
      lastDate: cacheFirstDate ? dates[dates.length - 1]! : null,
      createdBy: bm.id,
    })
    .returning({ id: schema.events.id })
  const [venue] = await db.select({ id: schema.venues.id }).from(schema.venues).limit(1)
  for (const date of dates) {
    await db.insert(schema.subEvents).values({
      eventId: e!.id, name: 'Function', eventDate: date, startTime: '19:00', endTime: '23:00',
      venueId: venue!.id, pax: 100,
    })
  }
  return e!.id
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
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, 'booking_manager'))
    .limit(1)
  bm.id = u!.id
}, 90_000)

afterEach(async () => { if (hasDb) await db.delete(schema.events) })
afterAll(async () => { if (hasDb) await db.delete(schema.events) })

d('searching the proposals list', () => {
  it('finds a guest by part of their name, in any case', async () => {
    await makeProposal({ guest: 'MR. DEVENDRA SINGH THAKUR JI', dates: ['2027-01-26'] })
    await makeProposal({ guest: 'Sharma family', dates: ['2027-02-10'] })

    const hit = await list('?q=devendra')
    expect(hit.events).toHaveLength(1)
    expect(hit.events[0]!.guestName).toContain('DEVENDRA')

    expect((await list('?q=SHARMA')).events).toHaveLength(1)
    expect((await list('?q=nobody')).events).toHaveLength(0)
  }, 120_000)

  it('finds a proposal by its code, which is what staff quote to each other', async () => {
    const id = await makeProposal({ guest: 'Verma', dates: ['2027-03-01'] })
    const [ev] = await db.select({ code: schema.events.code }).from(schema.events).where(eq(schema.events.id, id))
    const found = await list(`?q=${encodeURIComponent(ev!.code)}`)
    expect(found.events.map((e) => e.code)).toEqual([ev!.code])
  }, 120_000)

  it('treats % and _ as characters a guest typed, not as wildcards', async () => {
    await makeProposal({ guest: 'Gupta', dates: ['2027-03-05'] })
    // Unescaped, '%' would match every proposal in the database.
    expect((await list('?q=%25')).events).toHaveLength(0)
  }, 120_000)

  it('filters by event type', async () => {
    await makeProposal({ guest: 'A wedding', eventType: 'wedding', dates: ['2027-04-01'] })
    await makeProposal({ guest: 'An engagement', eventType: 'engagement', dates: ['2027-04-02'] })

    expect((await list('?type=wedding')).events.map((e) => e.guestName)).toEqual(['A wedding'])
    expect((await list('?type=engagement')).events.map((e) => e.guestName)).toEqual(['An engagement'])
    // And the screen is handed every configured type, not just the ones on this page.
    expect((await list('')).eventTypes.length).toBeGreaterThan(1)
  }, 120_000)

  it('finds a booking by date even though first_date is NULL', async () => {
    // The whole point: an enquiry's `first_date` cache is empty, and the old filter read it.
    await makeProposal({ guest: 'Uncached', dates: ['2027-05-10'], cacheFirstDate: false })
    const found = await list('?from=2027-05-01&to=2027-05-31')
    expect(found.events.map((e) => e.guestName)).toEqual(['Uncached'])
    expect(found.events[0]!.startDate).toBe('2027-05-10') // and it can show the dates that found it
  }, 120_000)

  it('overlaps the range rather than containing it', async () => {
    await makeProposal({ guest: 'Three-day wedding', dates: ['2027-06-28', '2027-06-29', '2027-06-30'] })

    // A single day inside the run finds it...
    expect((await list('?from=2027-06-29&to=2027-06-29')).events).toHaveLength(1)
    // ...as does a range that only clips the start or the end.
    expect((await list('?from=2027-06-25&to=2027-06-28')).events).toHaveLength(1)
    expect((await list('?from=2027-06-30&to=2027-07-05')).events).toHaveLength(1)
    // A window that misses it entirely does not.
    expect((await list('?from=2027-07-01&to=2027-07-31')).events).toHaveLength(0)
  }, 120_000)

  it('leaves either end of the range open', async () => {
    await makeProposal({ guest: 'Early', dates: ['2027-08-01'] })
    await makeProposal({ guest: 'Late', dates: ['2027-09-01'] })

    expect((await list('?from=2027-08-15')).events.map((e) => e.guestName)).toEqual(['Late'])
    expect((await list('?to=2027-08-15')).events.map((e) => e.guestName)).toEqual(['Early'])
  }, 120_000)

  it('narrows on name, type and dates together', async () => {
    await makeProposal({ guest: 'Sharma', eventType: 'wedding', dates: ['2027-10-05'] })
    await makeProposal({ guest: 'Sharma', eventType: 'engagement', dates: ['2027-10-06'] })
    await makeProposal({ guest: 'Sharma', eventType: 'wedding', dates: ['2027-12-25'] })

    const found = await list('?q=sharma&type=wedding&from=2027-10-01&to=2027-10-31')
    expect(found.events).toHaveLength(1)
    expect(found.events[0]!.startDate).toBe('2027-10-05')
  }, 120_000)
})
