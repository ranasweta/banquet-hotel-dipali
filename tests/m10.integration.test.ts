/**
 * M10 — the six management reports (PRD §7) and the derived notification feed (FR-9.1).
 * Builds a small mixed fixture and asserts each report reflects it; checks that a decider
 * sees the actionable items in their notification feed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const reports = await import('@/lib/reports')
const notifications = await import('@/lib/notifications')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping M10 tests\n')

let bmId = ''
let haId = ''

async function newEvent(status: string, eventType = 'engagement'): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [e] = await db.insert(schema.events).values({ code, guestName: `${status} guest`, eventType, status: status as 'confirmed', createdBy: bmId }).returning({ id: schema.events.id })
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
  const [bm] = await db.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(eq(schema.roles.name, 'booking_manager')).limit(1)
  const [ha] = await db.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(eq(schema.roles.name, 'higher_authority')).limit(1)
  bmId = bm!.id
  haId = ha!.id

  // Fixture: 2 enquiries, 1 confirmed (Crystal, Sep), 1 billed (finalised invoice).
  await newEvent('enquiry')
  await newEvent('enquiry')
  const confirmed = await newEvent('confirmed', 'wedding')
  const crystal = (await db.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.name, 'Crystal')).limit(1))[0]!.id
  await db.insert(schema.subEvents).values({ eventId: confirmed, name: 'Wedding', eventDate: '2026-09-15', startTime: '19:00', endTime: '23:00', venueId: crystal, pax: 300, venueRatePaise: 1_500_000 })
  await db.insert(schema.maintenanceEntries).values({ eventId: confirmed, item: 'Generator', qty: '3', unit: 'hrs', ratePaise: 100_000, amountPaise: 300_000, createdBy: bmId, isClosed: true })
  await db.insert(schema.exceptions).values({ eventId: confirmed, kind: 'menu_increase', status: 'pending', payload: { subEventId: 'x', categoryName: 'Soup', currentPick: 1, requestedPick: 2 }, raisedBy: bmId })

  // Build the billed event's children while it's still confirmed (the lock guard blocks
  // child writes once billed), then flip the status and attach the finalised invoice.
  const billed = await newEvent('confirmed')
  await db.insert(schema.subEvents).values({ eventId: billed, name: 'Party', eventDate: '2026-09-20', startTime: '19:00', endTime: '23:00', venueId: crystal, pax: 100, venueRatePaise: 1_500_000 })
  await db.update(schema.events).set({ status: 'billed' }).where(eq(schema.events.id, billed))
  await db.insert(schema.invoices).values({ eventId: billed, invoiceNo: 'INV-TEST-1', grossPaise: 900_000, discountPaise: 0, taxPaise: 100_000, netPaise: 1_000_000, advancesPaise: 400_000, balancePaise: 600_000, tncSnapshot: 'x', finalisedAt: new Date().toISOString(), finalisedBy: bmId })
}, 90_000)

afterAll(async () => {
  if (!hasDb) return
  await db.delete(schema.invoices)
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
})

d('reports (PRD §7)', () => {
  it('pipeline counts statuses and computes conversion', async () => {
    const r = (await reports.pipelineReport()) as { total: number; confirmedPlus: number; conversionRatePct: number; byStatus: { status: string; n: number }[] }
    expect(r.total).toBe(4)
    expect(r.byStatus.find((s) => s.status === 'enquiry')?.n).toBe(2)
    expect(r.confirmedPlus).toBe(2) // confirmed + billed
    expect(r.conversionRatePct).toBe(50)
  })

  it('occupancy buckets bookings by month and venue', async () => {
    const r = (await reports.occupancyReport()) as { byMonth: { month: string; hall: number }[]; byVenue: { venueName: string; bookings: number }[] }
    expect(r.byMonth.find((m) => m.month === '2026-09')?.hall).toBeGreaterThanOrEqual(2)
    expect(r.byVenue.find((v) => v.venueName === 'Crystal')?.bookings).toBeGreaterThanOrEqual(2)
  })

  it('revenue sums the finalised invoice into the tax summary', async () => {
    const r = (await reports.revenueReport()) as { taxSummary: { netPaise: number; taxPaise: number } }
    expect(Number(r.taxSummary.netPaise)).toBe(1_000_000)
    expect(Number(r.taxSummary.taxPaise)).toBe(100_000)
  })

  it('exceptions and maintenance aggregate correctly', async () => {
    const ex = (await reports.exceptionsReport()) as { pending: number }
    expect(ex.pending).toBeGreaterThanOrEqual(1)
    const mt = (await reports.maintenanceReport()) as { totalPaise: number; byEvent: unknown[] }
    expect(Number(mt.totalPaise)).toBe(300_000)
    expect(mt.byEvent.length).toBeGreaterThanOrEqual(1)
  })

  it('outstanding lists the billed balance and ages it', async () => {
    const r = (await reports.outstandingReport()) as { totalOutstanding: number; buckets: { d0_30: number }; rows: { balancePaise: number }[] }
    expect(Number(r.totalOutstanding)).toBe(600_000)
    expect(Number(r.buckets.d0_30)).toBe(600_000) // finalised today
    expect(r.rows.length).toBe(1)
  })
})

d('notifications (FR-9.1)', () => {
  it('surfaces pending approvals to a decider', async () => {
    const feed = await notifications.notificationsFor({ id: haId, roleName: 'higher_authority' })
    expect(feed.some((n) => n.kind === 'approval')).toBe(true)
  })

  it('shows nothing actionable to a maintenance user here', async () => {
    const feed = await notifications.notificationsFor({ id: bmId, roleName: 'maintenance' })
    expect(feed.length).toBe(0)
  })
})
