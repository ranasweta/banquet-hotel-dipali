/**
 * M7 acceptance (discounts, payments, reminders — FR-11.x, FR-7.7, BR-D2, BR-P2, FR-1.8):
 *
 *   - mixed discounts totalling 9.9% pass (effective); 10.1% raises a discount_over_cap
 *     exception and does not count until approved (BR-D2);
 *   - reminder rows are generated correctly for a wedding 45 days out (time-travel).
 *
 * Plus: the payment ledger's running balance, unique receipt numbers, refunds, reminders
 * skipping a paid-off wedding, and stale-enquiry flagging. Drives the M7 services directly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const discounts = await import('@/lib/discounts')
const payments = await import('@/lib/payments')
const reminders = await import('@/lib/reminders')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping billing tests\n')

const actor = { id: '', roleName: 'auditor' }
const ha = { id: '', roleName: 'higher_authority' }
let rc = 0
const receipt = () => `RCPT-${Date.now() % 1_000_000}-${++rc}`

async function userId(role: string): Promise<string> {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(eq(schema.roles.name, role)).limit(1)
  return u!.id
}
/** A confirmed event with a fixed proposal total, so the 10% cap math is exact. */
async function makeEvent(opts: { eventType?: string; proposalPaise?: number; firstDate?: string } = {}): Promise<string> {
  const { eventType = 'engagement', proposalPaise = 10_000_000, firstDate = null } = opts
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Billing Test', eventType, status: 'confirmed', proposalTotalPaise: proposalPaise, firstDate: firstDate as unknown as string, createdBy: actor.id })
    .returning({ id: schema.events.id })
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
  ha.id = await userId('higher_authority')
}, 90_000)

async function cleanup() {
  await db.delete(schema.paymentReminders)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('discount cap (BR-D2)', () => {
  it('lets mixed discounts up to 9.9% through and escalates the one that crosses 10%', async () => {
    const e = await makeEvent({ proposalPaise: 10_000_000 }) // cap = 1,000,000 paise
    const r1 = await discounts.addDiscount(actor, e, { head: 'venue', amountPaise: 500_000, remark: '5% venue' })
    expect(r1.deferred).toBe(false)
    const r2 = await discounts.addDiscount(actor, e, { head: 'menu', amountPaise: 490_000, remark: '4.9% menu' })
    expect(r2.deferred).toBe(false) // combined 9.9% ≤ cap
    expect(await discounts.effectiveDiscountPaise(e)).toBe(990_000)

    const r3 = await discounts.addDiscount(actor, e, { head: 'overall', amountPaise: 20_000, remark: 'push over' })
    expect(r3.deferred).toBe(true) // combined 10.1% > cap
    // The over-cap discount does NOT count until approved.
    expect(await discounts.effectiveDiscountPaise(e)).toBe(990_000)
    const [exc] = await db.select().from(schema.exceptions).where(eq(schema.exceptions.eventId, e))
    expect(exc!.kind).toBe('discount_over_cap')
    expect(exc!.status).toBe('pending')
  })

  it('counts an over-cap discount once its exception is approved', async () => {
    const e = await makeEvent({ proposalPaise: 10_000_000 })
    const over = await discounts.addDiscount(actor, e, { head: 'overall', amountPaise: 1_500_000, remark: '15%' })
    expect(over.deferred).toBe(true)
    expect(await discounts.effectiveDiscountPaise(e)).toBe(0)

    const approvals = await import('@/lib/approvals')
    await approvals.decideException(ha, (over as { exceptionId: string }).exceptionId, { action: 'approve' })
    expect(await discounts.effectiveDiscountPaise(e)).toBe(1_500_000)
  })

  it('requires a remark; room is a valid head now (client, 25 Jul 2026)', async () => {
    const e = await makeEvent()
    await expect(discounts.addDiscount(actor, e, { head: 'venue', amountPaise: 1000, remark: '' })).rejects.toThrow(/remark/)
    // Rooms are bulk-booked now, so a room discount is a normal head (it used to be refused).
    const r = await discounts.addDiscount(actor, e, { head: 'room', amountPaise: 1000, remark: 'room disc' })
    expect(r.deferred).toBe(false)
  })

  it('takes a percentage of a head and recomputes live as the bill changes (client, 25 Jul 2026)', async () => {
    const e = await makeEvent({ proposalPaise: 10_000_000 })
    const [venue] = await db.select({ id: schema.venues.id }).from(schema.venues).limit(1)
    await db.insert(schema.subEvents).values({ eventId: e, name: 'Fn', eventDate: '2026-09-01', startTime: '11:00', endTime: '15:00', venueId: venue!.id, pax: 100, venueRatePaise: 2_000_000 })
    // 20% of the ₹20,000 venue subtotal = ₹4,000.
    const r = await discounts.addDiscount(actor, e, { head: 'venue', percentBp: 2000, remark: '20% venue' })
    expect(r.deferred).toBe(false)
    expect(await discounts.effectiveDiscountPaise(e)).toBe(400_000)
    // Live: raise the venue rate and the same 20% now takes more (₹30,000 → ₹6,000).
    await db.update(schema.subEvents).set({ venueRatePaise: 3_000_000 }).where(eq(schema.subEvents.eventId, e))
    expect(await discounts.effectiveDiscountPaise(e)).toBe(600_000)
  })
})

d('payment ledger (FR-7.7)', () => {
  it('tracks running paid-vs-balance and rejects a duplicate receipt', async () => {
    const e = await makeEvent({ proposalPaise: 10_000_000 })
    await discounts.addDiscount(actor, e, { head: 'venue', amountPaise: 1_000_000, remark: '10%' })

    let led = await payments.getLedger(e)
    expect(led.netBillPaise).toBe(9_000_000) // proposal − 10% discount
    expect(led.balancePaise).toBe(9_000_000)

    const rno = receipt()
    await payments.recordPayment(actor, e, { kind: 'part_payment', amountPaise: 2_500_000, mode: 'upi', receiptNo: rno, receivedOn: '2026-08-01' })
    led = await payments.getLedger(e)
    expect(led.paidPaise).toBe(2_500_000)
    expect(led.balancePaise).toBe(6_500_000)

    // duplicate receipt → conflict
    await expect(
      payments.recordPayment(actor, e, { kind: 'part_payment', amountPaise: 100, mode: 'cash', receiptNo: rno, receivedOn: '2026-08-02' }),
    ).rejects.toMatchObject({ status: 409 })

    // a refund reduces paid
    await payments.recordPayment(actor, e, { kind: 'refund', amountPaise: 500_000, mode: 'bank', receiptNo: receipt(), receivedOn: '2026-08-03' })
    led = await payments.getLedger(e)
    expect(led.paidPaise).toBe(2_000_000)
    expect(led.balancePaise).toBe(7_000_000)
  })
})

d('wedding reminders (BR-P2, time-travel)', () => {
  it('generates BM D-30..D-21 and HA D-20..D-1 rows for a wedding 45 days out', async () => {
    const asOf = '2026-07-18'
    const first = '2026-09-01' // asOf + 45 days
    const e = await makeEvent({ eventType: 'wedding', proposalPaise: 10_000_000, firstDate: first })
    await payments.recordPayment(actor, e, { kind: 'part_payment', amountPaise: 2_500_000, mode: 'upi', receiptNo: receipt(), receivedOn: '2026-07-18' })

    const gen = await reminders.generateWeddingReminders(asOf)
    expect(gen.weddings).toBe(1)
    expect(gen.reminders).toBe(30) // 10 BM + 20 HA

    const rows = await db.select({ audience: schema.paymentReminders.audience, remindOn: schema.paymentReminders.remindOn }).from(schema.paymentReminders).where(eq(schema.paymentReminders.eventId, e))
    const bm = rows.filter((r) => r.audience === 'booking_manager').map((r) => r.remindOn).sort()
    const haRows = rows.filter((r) => r.audience === 'higher_authority').map((r) => r.remindOn).sort()
    expect(bm.length).toBe(10)
    expect(haRows.length).toBe(20)
    expect(bm[0]).toBe('2026-08-02') // D-30
    expect(bm[bm.length - 1]).toBe('2026-08-11') // D-21
    expect(haRows[0]).toBe('2026-08-12') // D-20
    expect(haRows[haRows.length - 1]).toBe('2026-08-31') // D-1

    // Idempotent: a second run creates nothing new.
    const again = await reminders.generateWeddingReminders(asOf)
    expect(again.reminders).toBe(0)
  })

  it('generates no reminders for a fully-paid wedding', async () => {
    const e = await makeEvent({ eventType: 'wedding', proposalPaise: 5_000_000, firstDate: '2026-09-01' })
    await payments.recordPayment(actor, e, { kind: 'settlement', amountPaise: 5_000_000, mode: 'bank', receiptNo: receipt(), receivedOn: '2026-07-18' })
    const gen = await reminders.generateWeddingReminders('2026-07-18')
    expect(gen.weddings).toBe(0)
    expect(gen.reminders).toBe(0)
  })
})

d('stale enquiries (FR-1.8)', () => {
  it('flags an enquiry untouched beyond the stale window', async () => {
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [old] = await db.insert(schema.events).values({ code, guestName: 'Old Enquiry', eventType: 'engagement', status: 'enquiry', createdBy: actor.id }).returning({ id: schema.events.id })
    await db.execute(sql`UPDATE events SET updated_at = '2026-07-05'::timestamptz WHERE id = ${old!.id}`)
    const [{ code: c2 }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    await db.insert(schema.events).values({ code: c2, guestName: 'Fresh Enquiry', eventType: 'engagement', status: 'enquiry', createdBy: actor.id })

    const stale = await reminders.listStaleEnquiries('2026-07-18') // 13 days after the old one
    expect(stale.some((s) => s.id === old!.id)).toBe(true)
    expect(stale.some((s) => s.guestName === 'Fresh Enquiry')).toBe(false)
  })
})
