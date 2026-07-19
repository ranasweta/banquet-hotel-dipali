/**
 * Booking-manager home dashboard (lib/dashboard.getBookingDashboard).
 *
 * Verifies each panel selects the right rows for a fixed as-of date:
 *   - today  = confirmed-and-beyond functions on the day (never enquiries, never tomorrow);
 *   - upcoming = the next seven days only (excludes today and anything past +7);
 *   - openEnquiries = events still in 'enquiry';
 *   - approvals = pending exceptions + pending change requests;
 *   - paymentsDue = confirmed events with a positive balance whose date is within 30 days,
 *     and nothing outside that window.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const { getBookingDashboard } = await import('@/lib/dashboard')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping dashboard tests\n')

const bm = { id: '' }
const ASOF = '2027-03-15'

async function userId(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}
async function venueId(name: string): Promise<string> {
  const [v] = await db.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.name, name)).limit(1)
  return v!.id
}
async function makeEvent(status: string, proposalPaise = 0): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({
      code,
      guestName: 'Dash Test',
      eventType: 'engagement',
      status: status as 'confirmed',
      proposalTotalPaise: proposalPaise,
      createdBy: bm.id,
    })
    .returning({ id: schema.events.id })
  return e!.id
}
/** A confirmed event with one sub-event + its venue booking, on `date`. */
async function makeConfirmedSub(
  venue: string,
  date: string,
  start: string,
  end: string,
  proposalPaise = 0,
): Promise<{ eventId: string; subId: string }> {
  const eventId = await makeEvent('confirmed', proposalPaise)
  await db.update(schema.events).set({ firstDate: date, lastDate: date }).where(eq(schema.events.id, eventId))
  const vId = await venueId(venue)
  const [sub] = await db
    .insert(schema.subEvents)
    .values({ eventId, name: 'Function', eventDate: date, startTime: start, endTime: end, venueId: vId, pax: 200 })
    .returning({ id: schema.subEvents.id })
  await db.execute(sql`
    INSERT INTO venue_bookings (venue_id, sub_event_id, event_id, occupancy)
    VALUES (${vId}, ${sub!.id}, ${eventId}, tsrange((${date}::date + ${start}::time), (${date}::date + ${end}::time), '[)'))
  `)
  return { eventId, subId: sub!.id }
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
  await db.delete(schema.venueBookings)
  await db.delete(schema.events) // cascades sub_events, change_requests, exceptions
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('getBookingDashboard', () => {
  it('sorts each fixture into the right panel for the as-of date', async () => {
    const todayFx = await makeConfirmedSub('Crystal', ASOF, '19:00', '23:00') // today
    const soonFx = await makeConfirmedSub('Kohinoor', '2027-03-18', '18:00', '22:00') // +3, in window
    const payFx = await makeConfirmedSub('Signature', '2027-03-25', '10:00', '14:00', 1_000_000) // +10, balance due
    const farFx = await makeConfirmedSub('Gulmohar Lawn', '2027-05-01', '10:00', '14:00', 500_000) // +47, out of both windows
    const enquiryId = await makeEvent('enquiry')

    // One pending exception and one pending change request → the approvals panel.
    await db.insert(schema.exceptions).values({
      eventId: payFx.eventId,
      kind: 'menu_increase',
      payload: { categoryName: 'Soup', currentPick: 1, requestedPick: 2 },
      raisedBy: bm.id,
    })
    await db.insert(schema.changeRequests).values({
      eventId: todayFx.eventId,
      subEventId: todayFx.subId,
      payload: { eventDate: '2027-03-16' },
      summary: 'Move to 2027-03-16',
      requestedBy: bm.id,
    })

    const dash = await getBookingDashboard(ASOF)

    // Today: the today function, with its venue; tomorrow's is not here.
    expect(dash.today.map((f) => f.subEventId)).toContain(todayFx.subId)
    expect(dash.today.find((f) => f.subEventId === todayFx.subId)?.venueName).toBe('Crystal')
    expect(dash.today.map((f) => f.subEventId)).not.toContain(soonFx.subId)

    // Next seven days: the +3 only. Not today, not +10, not +47.
    const upIds = dash.upcoming.map((f) => f.subEventId)
    expect(upIds).toContain(soonFx.subId)
    expect(upIds).not.toContain(todayFx.subId)
    expect(upIds).not.toContain(payFx.subId)
    expect(upIds).not.toContain(farFx.subId)

    // Open enquiries.
    expect(dash.openEnquiries.map((e) => e.id)).toContain(enquiryId)

    // Approvals: both kinds surface.
    expect(dash.approvals.total).toBeGreaterThanOrEqual(2)
    expect(dash.approvals.exceptions.some((x) => x.eventId === payFx.eventId)).toBe(true)
    expect(dash.approvals.changeRequests.some((c) => c.eventId === todayFx.eventId)).toBe(true)

    // Payments due: the +10 balance, exact outstanding & day count; the +47 is out of window,
    // and the zero-balance confirmed events never appear.
    const due = dash.paymentsDue.find((p) => p.eventId === payFx.eventId)
    expect(due).toBeTruthy()
    expect(due!.outstandingPaise).toBe(1_000_000)
    expect(due!.daysToEvent).toBe(10)
    expect(dash.paymentsDue.map((p) => p.eventId)).not.toContain(farFx.eventId)
    expect(dash.paymentsDue.map((p) => p.eventId)).not.toContain(todayFx.eventId)
  })

  it('shows an empty today with a clean pipeline when nothing is scheduled', async () => {
    const dash = await getBookingDashboard(ASOF)
    expect(dash.today).toEqual([])
    expect(dash.upcoming).toEqual([])
    expect(dash.paymentsDue).toEqual([])
  })
})
