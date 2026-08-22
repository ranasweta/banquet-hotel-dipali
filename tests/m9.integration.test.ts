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
  // Rooms are booked in bulk on the proposal (21 Jul 2026): one Palace deluxe for two
  // nights at Rs. 5,000, which is what the bill reads. room_allocations is not used.
  await db.execute(sql`
    INSERT INTO room_requirements (event_id, unit_id, room_type, count, check_in, check_out)
    VALUES (${eventId}, (SELECT id FROM lodging_units WHERE name = 'Palace'),
            'deluxe', 1, '2026-09-01', '2026-09-03')
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
    // Client's lead, 4 Aug 2026: rooms 5%, everything else 18% — and only the rooms 5% is
    // money. Each line carries its own rate honestly; the ROLL-UP is what splits (§F8).
    expect(bySection('venue')[0]!.amountPaise).toBe(1_500_000)
    expect(bySection('venue')[0]!.taxPaise).toBe(270_000) // 18%
    expect(bySection('food')[0]!.amountPaise).toBe(6_500_000) // 100 × 65,000
    expect(bySection('food')[0]!.taxPaise).toBe(1_170_000) // 18%
    expect(bySection('rooms')[0]!.amountPaise).toBe(1_000_000) // 2 nights × 5,00,000
    expect(bySection('rooms')[0]!.taxPaise).toBe(50_000) // 5% — the only tax collected
    expect(bySection('maintenance')[0]!.amountPaise).toBe(300_000)
    expect(bySection('maintenance')[0]!.taxPaise).toBe(54_000) // 18%

    // gross 93,00,000 · collected tax 50,000 · payable 93,50,000 · advances 25,00,000 ·
    // balance 68,50,000. The 18% (14,94,000) is printed and taken from nobody, so it moves
    // the document's Total and nothing else — least of all the balance, which would never
    // reach zero if it did.
    expect(inv.grossPaise).toBe(9_300_000)
    expect(inv.taxPaise).toBe(50_000)
    expect(inv.shownTaxPaise).toBe(270_000 + 1_170_000 + 54_000)
    expect(inv.discountPaise).toBe(0)
    expect(inv.netPaise).toBe(9_350_000)
    expect(inv.displayTotalPaise).toBe(9_350_000 + 1_494_000)
    expect(inv.advancesPaise).toBe(2_500_000)
    expect(inv.balancePaise).toBe(6_850_000)
  })

  it('an adjustment line recomputes the totals, then finalisation assigns a number', async () => {
    const { eventId } = await buildLockable()
    await lock.lockEvent(auditor, eventId)
    await invoice.setAdjustments(auditor, eventId, [{ description: 'Goodwill discount', amountPaise: -500_000, remark: 'repeat guest' }])
    const inv = (await invoice.getInvoice(eventId))!
    expect(inv.grossPaise).toBe(8_800_000) // 93,00,000 − 5,00,000
    expect(inv.netPaise).toBe(8_850_000) // 88,00,000 + 50,000 room tax

    // The document number belongs to Draft 2; "INV" would put the banned word in front of
    // the guest (client: never "invoice", never "final").
    const fin = await invoice.finaliseInvoice(auditor, eventId)
    expect(fin.invoiceNo).toMatch(/^D2-2026-\d{4}$/)
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
    expect(pf.invoice.netPaise).toBe(9_350_000)
    expect(pf.invoice.balancePaise).toBe(6_850_000)
    // Nothing was persisted: the event is still Completed and no invoice was drafted.
    const [e] = await db.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, eventId))
    expect(e!.status).toBe('completed')
    expect(await invoice.getInvoice(eventId)).toBeNull()
  })
})

d('bill lines carry their function (FR-7.3)', () => {
  it('an add-on bills under the function it was ordered for, not loose at event level', async () => {
    const { eventId, subId } = await buildLockable()
    await db.insert(schema.subEventAddons).values({ subEventId: subId, description: 'Extra lighting', qty: 2, ratePaise: 50_000 })

    const lines = await invoice.computeBillLines(db, eventId)
    const addon = lines.find((l) => l.description === 'Add-on: Extra lighting')!
    // An add-on hangs off a sub-event, so it belongs beside that function's venue and food.
    expect(addon.functionLabel).toBe('Reception')
    expect(addon.amountPaise).toBe(100_000)
    expect(lines.find((l) => l.section === 'venue')!.functionLabel).toBe('Reception')

    // Rooms and maintenance stay event-level — they span the whole stay, not one function.
    expect(lines.filter((l) => l.section === 'rooms').every((l) => l.functionLabel == null)).toBe(true)
    expect(lines.filter((l) => l.section === 'maintenance').every((l) => l.functionLabel == null)).toBe(true)
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
