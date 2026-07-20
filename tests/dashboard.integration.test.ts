/**
 * Role home dashboards (lib/dashboard). Verifies each board selects the right rows for a fixed
 * as-of date:
 *   - Booking: today (confirmed-and-beyond, never enquiries/tomorrow), next-7-days, open
 *     enquiries, approvals (exceptions + change requests), 30-day balances;
 *   - Banquet: agenda carries menu state, menuGaps flags functions with no/draft menu;
 *   - Lodge: today's arrivals, live occupancy, promised-but-unallocated, 35+ approvals;
 *   - Maintenance: In Progress / Completed events with running totals;
 *   - getDashboardForRole dispatches each role to the right board.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const { getBookingDashboard, getBanquetDashboard, getLodgeDashboard, getMaintenanceDashboard, getDashboardForRole } =
  await import('@/lib/dashboard')
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
async function tierId(name: string): Promise<string> {
  const [t] = await db.select({ id: schema.menuTiers.id }).from(schema.menuTiers).where(eq(schema.menuTiers.name, name)).limit(1)
  return t!.id
}
async function anyRoomId(): Promise<string> {
  const [r] = (await db.execute(sql`SELECT id FROM rooms WHERE is_active LIMIT 1`)) as unknown as { id: string }[]
  return r!.id
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

d('getBanquetDashboard', () => {
  it('carries menu state on the agenda and flags menu gaps', async () => {
    const withMenu = await makeConfirmedSub('Crystal', ASOF, '19:00', '23:00') // today, complete menu
    await db.insert(schema.subEventMenus).values({
      subEventId: withMenu.subId,
      tierId: await tierId('Silver'),
      tierName: 'Silver',
      baseRatePaise: 65_000,
      surchargePaise: 0,
      isComplete: true,
    })
    const noMenu = await makeConfirmedSub('Kohinoor', '2027-03-18', '18:00', '22:00') // +3, no menu
    await db.insert(schema.changeRequests).values({
      eventId: withMenu.eventId,
      subEventId: withMenu.subId,
      payload: { eventDate: '2027-03-16' },
      summary: 'Move to 2027-03-16',
      requestedBy: bm.id,
    })

    const b = await getBanquetDashboard(ASOF)

    // Today's function carries its (complete) menu; the +3 has none.
    expect(b.today.find((f) => f.subEventId === withMenu.subId)?.tierName).toBe('Silver')
    expect(b.today.find((f) => f.subEventId === withMenu.subId)?.menuComplete).toBe(true)
    expect(b.upcoming.find((f) => f.subEventId === noMenu.subId)?.tierName).toBeNull()

    // Menu gaps: the menuless function is flagged; the complete one is not.
    expect(b.menuGaps.map((g) => g.subEventId)).toContain(noMenu.subId)
    expect(b.menuGaps.map((g) => g.subEventId)).not.toContain(withMenu.subId)

    expect(b.changeRequests.some((c) => c.eventId === withMenu.eventId)).toBe(true)
  })
})

d('getLodgeDashboard', () => {
  it('reports arrivals, occupancy, unallocated promises, and 35+ approvals', async () => {
    const stay = await makeEvent('confirmed')
    const room = await anyRoomId()
    // A stay that starts today and spans it: an arrival today, and occupied now.
    await db.execute(sql`
      INSERT INTO room_allocations (event_id, room_id, stay, rate_paise, allocated_by)
      VALUES (${stay}, ${room}, daterange(${ASOF}::date, ${ASOF}::date + 2, '[)'), 500000, ${bm.id})
    `)
    // A confirmed event promising rooms it hasn't been allocated, plus a 35+ approval in flight.
    const gap = await makeEvent('confirmed')
    await db.insert(schema.roomRequirements).values({ eventId: gap, roomType: 'deluxe', count: 5, checkIn: ASOF, checkOut: '2027-03-20' })
    await db.insert(schema.exceptions).values({
      eventId: gap,
      kind: 'room_allocation_35plus',
      payload: { requestedCount: 35, existingCount: 0 },
      raisedBy: bm.id,
    })

    const l = await getLodgeDashboard(ASOF)

    expect(l.arrivals.some((a) => a.eventId === stay)).toBe(true)
    expect(l.departures.some((a) => a.eventId === stay)).toBe(false) // check-out is +2, not today
    expect(l.occupancy.reduce((s, u) => s + u.occupied, 0)).toBeGreaterThanOrEqual(1)
    expect(l.occupancy.every((u) => u.available === u.total - u.occupied)).toBe(true)
    expect(l.awaitingAllocation.find((g) => g.eventId === gap)?.shortfall).toBe(5)
    expect(l.pendingRoomApprovals.some((x) => x.eventId === gap)).toBe(true)
  })
})

d('getMaintenanceDashboard', () => {
  it('lists In Progress and Completed events with running totals', async () => {
    const inprog = await makeEvent('in_progress')
    const done = await makeEvent('completed')
    await db.insert(schema.maintenanceEntries).values({
      eventId: done,
      item: 'Generator (extra hours)',
      qty: '2',
      unit: 'hrs',
      ratePaise: 150_000,
      amountPaise: 300_000,
      createdBy: bm.id,
    })

    const m = await getMaintenanceDashboard(ASOF)

    expect(m.events.some((e) => e.id === inprog && e.status === 'in_progress')).toBe(true)
    const row = m.events.find((e) => e.id === done)
    expect(row?.entryCount).toBe(1)
    expect(row?.totalPaise).toBe(300_000)
    expect(row?.closed).toBe(false)
  })
})

d('getDashboardForRole', () => {
  it('gives every role its own board — none shared', async () => {
    const kinds = await Promise.all(
      ['booking_manager', 'banquet_manager', 'lodge_manager', 'maintenance', 'chef', 'higher_authority', 'auditor'].map(
        async (role) => (await getDashboardForRole(role, ASOF)).kind,
      ),
    )
    expect(kinds).toEqual(['booking', 'banquet', 'lodge', 'maintenance', 'chef', 'authority', 'auditor'])
    // The point of the exercise: no two roles land on the same board.
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('covers every seeded role, so a new one cannot silently inherit another board', async () => {
    const roles = (await db.execute(sql`SELECT name FROM roles ORDER BY name`)) as unknown as { name: string }[]
    const kinds = await Promise.all(roles.map(async (r) => (await getDashboardForRole(r.name, ASOF)).kind))
    expect(new Set(kinds).size).toBe(roles.length)
  })
})

d('approval queues are scoped to whoever settles them', () => {
  it('shows a non-decider only what they raised, never another role’s queue', async () => {
    const { listExceptions } = await import('@/lib/approvals')
    const gm = await userId('higher_authority')
    const banquet = await userId('banquet_manager')

    const fx = await makeConfirmedSub('Crystal', ASOF, '19:00', '23:00')
    // Two menu increases sitting with the GM: one raised by the Booking Manager, one by Banquet.
    await db.insert(schema.exceptions).values([
      { eventId: fx.eventId, kind: 'menu_increase', payload: { categoryName: 'Soup' }, raisedBy: bm.id },
      { eventId: fx.eventId, kind: 'menu_increase', payload: { categoryName: 'Dessert' }, raisedBy: banquet },
    ])

    // The decider (GM) sees the whole queue.
    const forGm = await listExceptions({ status: 'pending' })
    expect(forGm.length).toBeGreaterThanOrEqual(2)

    // A non-decider sees only their own — not the one the GM is holding for someone else.
    const forBanquet = await listExceptions({ status: 'pending', mineId: banquet })
    expect(forBanquet).toHaveLength(1)
    expect(forBanquet[0]!.raisedByName).toBeTruthy()
    const forBooking = await listExceptions({ status: 'pending', mineId: bm.id })
    expect(forBooking).toHaveLength(1)
    // The two views are disjoint: neither can read the other's request.
    expect(forBanquet[0]!.id).not.toBe(forBooking[0]!.id)
    expect(gm).toBeTruthy()
  })
})
