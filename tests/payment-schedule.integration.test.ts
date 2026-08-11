/**
 * The payable amount and the milestones (client's lead, 4 Aug 2026) — `lib/payment-schedule.ts`.
 *
 * This module is the single definition of what a guest owes, read by confirm, the quote, the
 * ledger, the wedding reminders and the calendar's Downpayment-due marker. Three things are
 * worth pinning down by hand, because every one of them was got wrong somewhere before:
 *
 *   - payable = venue + food + add-ons + rooms + the 5% room GST, less discounts. The 18%
 *     introduced on 4 Aug is printed and collected from nobody, so it is in none of it.
 *   - room tax is rounded PER LINE and summed, identically to `roomEstimatePaise`, so the
 *     wizard's live estimate and the confirm gate cannot differ by a paisa.
 *   - milestones are floors on the CUMULATIVE total received, not instalments: 60% paid up
 *     front meets the wedding's 50% and leaves nothing due at D-30.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const schedule = await import('@/lib/payment-schedule')
const pricing = await import('@/lib/pricing')
const discounts = await import('@/lib/discounts')
const payments = await import('@/lib/payments')
const invoice = await import('@/lib/invoice')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping payment-schedule tests\n')

const actor = { id: '', roleName: 'auditor' }
const bm = { id: '', roleName: 'booking_manager' }
let rc = 0
const receipt = () => `PS-${Date.now() % 1_000_000}-${++rc}`

async function userId(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}

/** A confirmed booking with one function at a known venue rate, and optionally some rooms. */
async function makeBooking(opts: {
  eventType?: string
  venueRatePaise?: number
  eventDate?: string
  rooms?: { roomType: string; count: number; checkIn: string; checkOut: string }[]
} = {}): Promise<string> {
  const { eventType = 'engagement', venueRatePaise = 10_000_000, eventDate = '2026-10-01', rooms = [] } = opts
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Schedule Test', eventType, status: 'confirmed', proposalTotalPaise: venueRatePaise, createdBy: actor.id })
    .returning({ id: schema.events.id })
  const [venue] = await db.select({ id: schema.venues.id }).from(schema.venues).limit(1)
  await db.insert(schema.subEvents).values({
    eventId: e!.id, name: 'Function', eventDate, startTime: '11:00', endTime: '15:00',
    venueId: venue!.id, pax: 100, venueRatePaise,
  })
  if (rooms.length > 0) {
    const [unit] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = 'Palace'`)) as unknown as { id: string }[]
    await db.insert(schema.roomRequirements).values(
      rooms.map((r) => ({ eventId: e!.id, unitId: unit!.id, roomType: r.roomType, count: r.count, checkIn: r.checkIn, checkOut: r.checkOut })),
    )
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
  actor.id = await userId('auditor')
  bm.id = await userId('booking_manager')
}, 90_000)

async function cleanup() {
  await db.delete(schema.paymentReminders)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('the payable amount', () => {
  it('is venue + food + rooms + the 5%, less discounts — and never the 18%', async () => {
    const e = await makeBooking({
      venueRatePaise: 10_000_000,
      rooms: [{ roomType: 'deluxe', count: 2, checkIn: '2026-10-01', checkOut: '2026-10-03' }],
    })
    // Palace deluxe is Rs. 5,000/night: 2 rooms × 2 nights × 5,00,000 paise = 20,00,000.
    const roomEst = await pricing.roomEstimatePaise(e)
    expect(roomEst.roomsPaise).toBe(2_000_000)
    expect(roomEst.roomsTaxPaise).toBe(100_000) // 5%

    const bill = await schedule.payableBreakdown(e)
    expect(bill.proposalPaise).toBe(10_000_000)
    expect(bill.roomsPaise).toBe(roomEst.roomsPaise)
    // Rounded per line and summed, exactly as roomEstimatePaise does it — the wizard's live
    // estimate and the confirm gate read the same figure or the guest is quoted one and
    // charged another.
    expect(bill.roomsTaxPaise).toBe(roomEst.roomsTaxPaise)
    expect(bill.payablePaise).toBe(12_100_000)

    // The 18% exists, is large, and is in none of the above.
    const shown = await invoice.shownTaxPaise(e)
    expect(shown).toBe(1_800_000) // 18% of the 1,00,000-rupee venue line
    expect(bill.payablePaise).toBe(12_100_000)
  })

  /**
   * Maintenance (client, 11 Aug 2026). The bill has always charged closed maintenance while
   * this module ignored it, so the Billing panel said "settled" over a Draft that still asked
   * for money. It counts now — but only against the balance and the settlement, because the
   * 25% and the 50% fell due before the generator ever ran.
   */
  it('counts CLOSED maintenance in the payable, and open maintenance in nothing', async () => {
    const e = await makeBooking({ venueRatePaise: 10_000_000 })
    const base = await schedule.payableBreakdown(e)
    expect(base.maintenancePaise).toBe(0)
    expect(base.payablePaise).toBe(base.preEventPayablePaise)

    // Open: being typed by the Maintenance team, and in no figure at all.
    await db.insert(schema.maintenanceEntries).values({
      eventId: e, item: 'Generator (extra hours)', qty: '4', ratePaise: 50_000,
      amountPaise: 200_000, createdBy: actor.id, isClosed: false,
    })
    const open = await schedule.payableBreakdown(e)
    expect(open.maintenancePaise).toBe(0)
    expect(open.payablePaise).toBe(base.payablePaise)

    // Closed: in the payable and in the balance.
    await db.execute(sql`UPDATE maintenance_entries SET is_closed = true WHERE event_id = ${e}::uuid`)
    const closed = await schedule.payableBreakdown(e)
    expect(closed.maintenancePaise).toBe(200_000)
    expect(closed.payablePaise).toBe(base.preEventPayablePaise + 200_000)
    expect(closed.balancePaise).toBe(closed.payablePaise - closed.paidPaise)
  })

  it('never lets maintenance reach back and re-open a met advance', async () => {
    const e = await makeBooking({ eventType: 'wedding', venueRatePaise: 10_000_000 })
    const before = await schedule.paymentSchedule(e, '2026-09-01')
    const advanceBefore = before.milestones.find((m) => m.key === 'advance')!.requiredPaise
    const weddingBefore = before.milestones.find((m) => m.key === 'wedding_balance')!.requiredPaise

    await db.insert(schema.maintenanceEntries).values({
      eventId: e, item: 'Damages', qty: '1', ratePaise: 400_000,
      amountPaise: 400_000, createdBy: actor.id, isClosed: true,
    })

    const after = await schedule.paymentSchedule(e, '2026-09-01')
    // The two pre-event milestones are measured on the pre-event base and do not move.
    expect(after.milestones.find((m) => m.key === 'advance')!.requiredPaise).toBe(advanceBefore)
    expect(after.milestones.find((m) => m.key === 'wedding_balance')!.requiredPaise).toBe(weddingBefore)
    // The settlement is measured on the full payable and does.
    expect(after.milestones.find((m) => m.key === 'settlement')!.requiredPaise).toBe(
      before.milestones.find((m) => m.key === 'settlement')!.requiredPaise + 400_000,
    )
  })

  it('drops with a discount, and the discount is the money that was typed', async () => {
    const e = await makeBooking({ venueRatePaise: 10_000_000 })
    await discounts.addDiscount(bm, e, { head: 'venue', amountPaise: 500_000, remark: 'goodwill' })
    const bill = await schedule.payableBreakdown(e)
    expect(bill.discountPaise).toBe(500_000)
    expect(bill.payablePaise).toBe(9_500_000)

    // A rupee discount is frozen: the bill moving does not move it (4 Aug 2026). Under the
    // 25 Jul percentage rule this figure would have followed the venue up to 7,50,000.
    await db.update(schema.subEvents).set({ venueRatePaise: 15_000_000 }).where(eq(schema.subEvents.eventId, e))
    expect((await schedule.payableBreakdown(e)).discountPaise).toBe(500_000)
  })
})

d('milestones', () => {
  it('are floors on the cumulative total, not instalments', async () => {
    const e = await makeBooking({ eventType: 'wedding', venueRatePaise: 10_000_000, eventDate: '2026-10-01' })
    const before = await schedule.paymentSchedule(e, '2026-08-04')
    expect(before.milestones.map((m) => m.key)).toEqual(['advance', 'wedding_balance', 'settlement'])
    expect(before.milestones[0]!.requiredPaise).toBe(2_500_000) // 25%
    expect(before.milestones[1]!.requiredPaise).toBe(5_000_000) // 50%, not the old 75%
    expect(before.milestones[1]!.dueOn).toBe('2026-09-01') // D-30 from the first function
    expect(before.milestones[2]!.requiredPaise).toBe(10_000_000)

    // 60% up front clears the advance AND the wedding milestone — one payment, not two.
    await payments.recordPayment(actor, e, { kind: 'part_payment', amountPaise: 6_000_000, mode: 'bank', receiptNo: receipt(), receivedOn: '2026-08-04' })
    const after = await schedule.paymentSchedule(e, '2026-08-04')
    expect(after.milestones[0]!.shortfallPaise).toBe(0)
    expect(after.milestones[1]!.shortfallPaise).toBe(0)
    expect(after.milestones[2]!.shortfallPaise).toBe(4_000_000)
    expect(after.balancePaise).toBe(4_000_000)
  })

  it('gives a non-wedding no D-30 milestone at all', async () => {
    const e = await makeBooking({ eventType: 'engagement' })
    const s = await schedule.paymentSchedule(e, '2026-08-04')
    expect(s.milestones.map((m) => m.key)).toEqual(['advance', 'settlement'])
  })

  it('marks the wedding milestone overdue once its date has passed', async () => {
    const e = await makeBooking({ eventType: 'wedding', venueRatePaise: 10_000_000, eventDate: '2026-10-01' })
    expect((await schedule.paymentSchedule(e, '2026-08-04')).milestones[1]!.overdue).toBe(false)
    expect((await schedule.paymentSchedule(e, '2026-09-15')).milestones[1]!.overdue).toBe(true)
  })
})

d('the ledger reads the same arithmetic', () => {
  it('counts rooms in the balance — the bug that hid an entire lodging charge', async () => {
    // getLedger measured `proposal_total_paise` (venue + food) and nothing else, so a booking
    // with rooms was reported square while the rooms were still owed.
    const e = await makeBooking({
      venueRatePaise: 10_000_000,
      rooms: [{ roomType: 'deluxe', count: 2, checkIn: '2026-10-01', checkOut: '2026-10-03' }],
    })
    await payments.recordPayment(actor, e, { kind: 'part_payment', amountPaise: 10_000_000, mode: 'bank', receiptNo: receipt(), receivedOn: '2026-08-04' })
    const led = await payments.getLedger(e)
    expect(led.payablePaise).toBe(12_100_000)
    expect(led.balancePaise).toBe(2_100_000) // the rooms and their 5%, still owed
    expect(led.milestones).toHaveLength(2) // engagement: advance + settlement
  })
})
