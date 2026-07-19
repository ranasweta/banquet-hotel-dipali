/**
 * M9 acceptance (lock, invoice, audit — FR-7.x, FR-10.x):
 *
 *   - lock is refused while an exception is pending;
 *   - post-lock edit attempts return 409;
 *   - the invoice totals reconcile to the paise against a hand-computed case.
 *
 * Plus: the checklist blocks an incomplete event, finalisation assigns a number and moves to
 * Billed, and the audit trail returns the event's entries. Drives the M9 services directly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const lock = await import('@/lib/lock')
const invoice = await import('@/lib/invoice')
const trail = await import('@/lib/audit-trail')
const menus = await import('@/lib/menus')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping M9 tests\n')

const auditor = { id: '', roleName: 'auditor' }
const bm = { id: '', roleName: 'booking_manager' }
let rc = 0
const receipt = () => `M9-${Date.now() % 1_000_000}-${++rc}`

async function userId(role: string): Promise<string> {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(eq(schema.roles.name, role)).limit(1)
  return u!.id
}
async function idOf(table: 'venues' | 'menuTiers', name: string): Promise<string> {
  const t = table === 'venues' ? schema.venues : schema.menuTiers
  const [r] = await db.select({ id: t.id }).from(t).where(eq(t.name, name)).limit(1)
  return r!.id
}
async function deluxeRoom(): Promise<string> {
  const [r] = (await db.execute(sql`SELECT r.id FROM rooms r JOIN lodging_units u ON u.id = r.unit_id WHERE u.name = 'Palace' AND r.room_type = 'deluxe' LIMIT 1`)) as unknown as { id: string }[]
  return r!.id
}

/**
 * A Completed event fully ready to lock, with exact numbers for the hand-computed invoice:
 *   venue 15,00,000 · food 100 × 65,000 = 65,00,000 · rooms 2 × 5,00,000 = 10,00,000 ·
 *   maintenance 3,00,000 · advance 25,00,000.
 */
async function buildLockable(): Promise<{ eventId: string; subId: string }> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db.insert(schema.events).values({ code, guestName: 'Lock Test', eventType: 'engagement', status: 'completed', firstDate: '2026-09-01', lastDate: '2026-09-01', createdBy: bm.id }).returning({ id: schema.events.id })
  const eventId = ev!.id
  const [sub] = await db.insert(schema.subEvents).values({ eventId, name: 'Reception', eventDate: '2026-09-01', startTime: '19:00', endTime: '23:00', venueId: await idOf('venues', 'Crystal'), pax: 100, venueRatePaise: 1_500_000 }).returning({ id: schema.subEvents.id })
  const subId = sub!.id
  await db.insert(schema.subEventMenus).values({ subEventId: subId, tierId: await idOf('menuTiers', 'Silver'), tierName: 'Silver', baseRatePaise: 65_000, surchargePaise: 0, isComplete: true })
  await db.execute(sql`
    INSERT INTO room_allocations (event_id, room_id, stay, rate_paise, discount_paise, allocated_by)
    VALUES (${eventId}, ${await deluxeRoom()}, daterange('2026-09-01','2026-09-03','[)'), 500000, 0, ${bm.id})
  `)
  await db.insert(schema.maintenanceEntries).values({ eventId, item: 'Generator', qty: '3', unit: 'hrs', ratePaise: 100_000, amountPaise: 300_000, createdBy: auditor.id, isClosed: true })
  await db.insert(schema.payments).values({ eventId, kind: 'advance_block', amountPaise: 2_500_000, mode: 'upi', receiptNo: receipt(), receivedOn: '2026-08-01', recordedBy: bm.id })
  await db.execute(sql`INSERT INTO lock_signoffs (event_id, designation, signed_by) VALUES
    (${eventId}, 'banquet_manager', ${bm.id}), (${eventId}, 'lodge_manager', ${bm.id}), (${eventId}, 'maintenance', ${bm.id})`)
  return { eventId, subId }
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
  auditor.id = await userId('auditor')
  bm.id = await userId('booking_manager')
}, 90_000)

async function cleanup() {
  // invoices reference events with NO cascade (invoices are protected in production, where
  // events are never deleted); venue_bookings likewise. Clear both before the event cascade.
  await db.delete(schema.venueBookings)
  await db.delete(schema.invoices)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('lock checklist + lock (FR-7.1/7.2)', () => {
  it('a fully-ready event can lock; a pending exception blocks it', async () => {
    const { eventId } = await buildLockable()
    expect((await lock.lockChecklist(eventId)).canLock).toBe(true)

    // Introduce a pending exception → lock refused.
    await db.insert(schema.exceptions).values({ eventId, kind: 'other', status: 'pending', payload: {}, raisedBy: bm.id })
    expect((await lock.lockChecklist(eventId)).canLock).toBe(false)
    await expect(lock.lockEvent(auditor, eventId)).rejects.toMatchObject({ status: 409 })

    // Resolve it → lock succeeds and drafts the invoice.
    await db.update(schema.exceptions).set({ status: 'approved' }).where(eq(schema.exceptions.eventId, eventId))
    const res = await lock.lockEvent(auditor, eventId)
    expect(res.locked).toBe(true)
    const [e] = await db.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, eventId))
    expect(e!.status).toBe('locked')
  })

  it('only the Auditor may lock', async () => {
    const { eventId } = await buildLockable()
    await expect(lock.lockEvent(bm, eventId)).rejects.toMatchObject({ status: 403 })
  })

  it('refuses to lock while a checklist item is unmet', async () => {
    const { eventId } = await buildLockable()
    await db.delete(schema.lockSignoffs).where(sql`event_id = ${eventId} AND designation = 'banquet_manager'`)
    expect((await lock.lockChecklist(eventId)).canLock).toBe(false)
    await expect(lock.lockEvent(auditor, eventId)).rejects.toThrow(/day-sheet sign-off/)
  })
})

d('invoice reconciliation (FR-7.3) — hand-computed to the paise', () => {
  it('drafts lines and totals that reconcile exactly', async () => {
    const { eventId } = await buildLockable()
    await lock.lockEvent(auditor, eventId)
    const inv = (await invoice.getInvoice(eventId))!

    const bySection = (s: string) => inv.lines.filter((l) => l.section === s)
    expect(bySection('venue')[0]!.amountPaise).toBe(1_500_000)
    expect(bySection('venue')[0]!.taxPaise).toBe(270_000) // 18%
    expect(bySection('food')[0]!.amountPaise).toBe(6_500_000) // 100 × 65,000
    expect(bySection('food')[0]!.taxPaise).toBe(325_000) // 5%
    expect(bySection('rooms')[0]!.amountPaise).toBe(1_000_000) // 2 nights × 5,00,000
    expect(bySection('rooms')[0]!.taxPaise).toBe(120_000) // 12%
    expect(bySection('maintenance')[0]!.amountPaise).toBe(300_000)
    expect(bySection('maintenance')[0]!.taxPaise).toBe(54_000) // 18%

    // gross 93,00,000 · tax 7,69,000 · net 1,00,69,000 · advances 25,00,000 · balance 75,69,000
    expect(inv.grossPaise).toBe(9_300_000)
    expect(inv.taxPaise).toBe(769_000)
    expect(inv.discountPaise).toBe(0)
    expect(inv.netPaise).toBe(10_069_000)
    expect(inv.advancesPaise).toBe(2_500_000)
    expect(inv.balancePaise).toBe(7_569_000)
  })

  it('an adjustment line recomputes the totals, then finalisation assigns a number', async () => {
    const { eventId } = await buildLockable()
    await lock.lockEvent(auditor, eventId)
    await invoice.setAdjustments(auditor, eventId, [{ description: 'Goodwill discount', amountPaise: -500_000, remark: 'repeat guest' }])
    const inv = (await invoice.getInvoice(eventId))!
    expect(inv.grossPaise).toBe(8_800_000) // 93,00,000 − 5,00,000
    expect(inv.netPaise).toBe(9_569_000) // 88,00,000 + 7,69,000

    const fin = await invoice.finaliseInvoice(auditor, eventId)
    expect(fin.invoiceNo).toMatch(/^INV-2026-\d{4}$/)
    const [e] = await db.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, eventId))
    expect(e!.status).toBe('billed')
    // No adjusting a finalised invoice.
    await expect(invoice.setAdjustments(auditor, eventId, [])).rejects.toMatchObject({ status: 409 })
  })
})

d('proforma estimate (pre-lock)', () => {
  it('computes the same bill live, without locking or issuing an invoice number', async () => {
    const { eventId } = await buildLockable()
    const pf = await invoice.proformaData(eventId)
    expect(pf.proforma).toBe(true)
    expect(pf.invoice.invoiceNo).toBeNull()
    // Same figures as the locked-invoice test — the estimate matches the eventual bill.
    expect(pf.invoice.grossPaise).toBe(9_300_000)
    expect(pf.invoice.netPaise).toBe(10_069_000)
    expect(pf.invoice.balancePaise).toBe(7_569_000)
    // Nothing was persisted: the event is still Completed and no invoice was drafted.
    const [e] = await db.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, eventId))
    expect(e!.status).toBe('completed')
    expect(await invoice.getInvoice(eventId)).toBeNull()
  })
})

d('post-lock immutability + audit (FR-10.x)', () => {
  it('post-lock edits return 409 and the trail records the lock', async () => {
    const { eventId, subId } = await buildLockable()
    await lock.lockEvent(auditor, eventId)
    await expect(menus.saveSubEventMenu(bm, subId, { tierId: await idOf('menuTiers', 'Silver'), selections: {} })).rejects.toMatchObject({ status: 409 })

    const rows = await trail.getTrail(eventId)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.action === 'status' && r.newValue === 'locked')).toBe(true)
    expect(trail.trailCsv(rows).split('\n')[0]).toContain('seq,at,action')
  })
})
