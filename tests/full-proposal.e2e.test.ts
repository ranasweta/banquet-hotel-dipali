/**
 * A whole wedding, priced end to end, with every figure hand-computed first.
 *
 * This is the test that would have caught the two ledger bugs found on 4 Aug 2026, because it
 * is the only one that puts ROOMS and MULTIPLE FUNCTIONS and a DISCOUNT on the same booking and
 * then asks what is owed. Each figure below is worked out in rupees in the comments before the
 * code sees it, so a wrong answer means the code is wrong, not that the expectation was copied
 * from a previous run.
 *
 * THE BOOKING — Sharma / Kapoor, Regency + Palace, 27–30 Nov 2026, event type `wedding`.
 *
 *   FUNCTIONS                venue                     rate       pax   tier      per plate
 *   27 Nov  Mehndi           Kohinoor                  55,000     150   Silver    650 + 50
 *   28 Nov  Sangeet          Imperial                  75,000     250   Gold      750 + 50
 *   29 Nov  Wedding          Imperial + Kohinoor     1,51,000     400   Platinum  850 + 50
 *   30 Nov  Reception        Crystal                 1,51,000     300   Diamond   950 + 50
 *
 *   venue    55,000 + 75,000 + 1,51,000 + 1,51,000                        =   4,32,000
 *   food     150×700 + 250×800 + 400×900 + 300×1000
 *            = 1,05,000 + 2,00,000 + 3,60,000 + 3,00,000                  =   9,65,000
 *   add-ons  DJ 25,000 (Sangeet) + décor 40,000 (Wedding)                 =      65,000
 *   ---------------------------------------------------------------------------------------
 *   proposal_total_paise                                                  =  14,62,000
 *
 *   ROOMS, two lodges, 27 → 30 Nov (3 nights). 34 rooms — deliberately one under the 35 that
 *   would send it to the Authority (BR-L2), so confirm stays about money and not approvals.
 *   Palace deluxe   20 × 3 × 5,000                                        =   3,00,000
 *   Regency deluxe  14 × 3 × 4,500                                        =   1,89,000
 *   rooms                                                                 =   4,89,000
 *   room GST 5%, rounded PER LINE: 15,000 + 9,450                         =      24,450
 *
 *   DISCOUNT  ₹1,00,000 off overall. The cap is 10% of (proposal + rooms) = 10% of 19,51,000
 *   = 1,95,100, so this is comfortably inside it and takes effect at once (BR-D2).
 *
 *   AMOUNT PAYABLE  14,62,000 + 4,89,000 + 24,450 − 1,00,000              =  18,75,450
 *
 *   GST 18% — shown, collected from nobody — rounded PER LINE:
 *     venue    9,900 + 13,500 + 27,180 + 27,180                           =      77,760
 *     food    18,900 + 36,000 + 64,800 + 54,000                           =   1,73,700
 *     add-ons  4,500 + 7,200                                              =      11,700
 *   shown GST                                                             =   2,63,160
 *   PRINTED TOTAL  18,75,450 + 2,63,160                                   =  21,38,610
 *
 *   MILESTONES on the payable amount: 25% = 4,68,862.50 · 50% = 9,37,725 · 100% = 18,75,450.
 *   The guest brings ₹3,00,000 — short of the advance, which is the whole point: the dates are
 *   held anyway and ₹1,68,862.50 is carried as Downpayment due.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const menus = await import('@/lib/menus')
const rooms = await import('@/lib/rooms')
const discounts = await import('@/lib/discounts')
const payments = await import('@/lib/payments')
const invoice = await import('@/lib/invoice')
const schedule = await import('@/lib/payment-schedule')
const confirmSvc = await import('@/lib/confirm')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping full-proposal test\n')

const R = (rupees: number) => rupees * 100 // rupees -> paise, the unit everything is stored in

const bm = { id: '', roleName: 'booking_manager' }
let eventId = ''
const subIds: Record<string, string> = {}

const FUNCTIONS = [
  { name: 'Mehndi', date: '2026-11-27', venue: 'Kohinoor', bundle: null, pax: 150, tier: 'Silver', start: '11:00', end: '15:00' },
  { name: 'Sangeet', date: '2026-11-28', venue: 'Imperial', bundle: null, pax: 250, tier: 'Gold', start: '19:00', end: '23:00' },
  { name: 'Wedding', date: '2026-11-29', venue: null, bundle: 'Imperial + Kohinoor', pax: 400, tier: 'Platinum', start: '19:00', end: '23:30' },
  { name: 'Reception', date: '2026-11-30', venue: null, bundle: null, pax: 300, tier: 'Diamond', start: '19:00', end: '23:00' },
] as const

const BY_NAME = {
  venues: sql`SELECT id FROM venues WHERE name =`,
  venue_bundles: sql`SELECT id FROM venue_bundles WHERE name =`,
  menu_tiers: sql`SELECT id FROM menu_tiers WHERE name =`,
  lodging_units: sql`SELECT id FROM lodging_units WHERE name =`,
} as const

async function idOf(table: keyof typeof BY_NAME, name: string): Promise<string> {
  const [r] = (await db.execute(
    sql`${BY_NAME[table]} ${name} LIMIT 1`,
  )) as unknown as { id: string }[]
  if (!r) throw new Error(`${table}: no row named ${name}`)
  return r.id
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

  // ── the enquiry, with its declared run (rooms must fall inside it) ──────────
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({
      code, guestName: 'Sharma / Kapoor', eventType: 'wedding', createdBy: bm.id,
      plannedFrom: '2026-11-27', plannedTo: '2026-11-30',
    })
    .returning({ id: schema.events.id })
  eventId = ev!.id

  // Weddings need three contacts to confirm (FR-1.11).
  await db.insert(schema.eventContacts).values([
    { eventId, phone: '9000000001', label: 'primary' },
    { eventId, phone: '9000000002', label: 'father' },
    { eventId, phone: '9000000003', label: 'coordinator' },
  ])

  // ── four functions, each with its venue and its menu tier ───────────────────
  for (const f of FUNCTIONS) {
    const [sub] = await db
      .insert(schema.subEvents)
      .values({
        eventId, name: f.name, eventDate: f.date, startTime: f.start, endTime: f.end,
        venueId: f.venue ? await idOf('venues', f.venue) : f.name === 'Reception' ? await idOf('venues', 'Crystal') : null,
        bundleId: f.bundle ? await idOf('venue_bundles', f.bundle) : null,
        pax: f.pax,
      })
      .returning({ id: schema.subEvents.id })
    subIds[f.name] = sub!.id
    // Dishes can be deferred (FR-3.2); the per-plate rate is snapshotted from the tier either
    // way, and it is the price this test is about.
    await menus.saveSubEventMenu(bm, sub!.id, { tierId: await idOf('menu_tiers', f.tier), selections: {} })
  }

  // ── add-ons, on the functions that ordered them ─────────────────────────────
  await menus.addAddon(bm, subIds.Sangeet!, { description: 'DJ & sound', ratePaise: R(25_000), qty: 1 })
  await menus.addAddon(bm, subIds.Wedding!, { description: 'Stage décor', ratePaise: R(40_000), qty: 1 })

  // ── 34 rooms across two lodges, three nights ────────────────────────────────
  await rooms.saveRoomRequirements(bm, eventId, [
    { unitId: await idOf('lodging_units', 'Palace'), roomType: 'deluxe', count: 20, checkIn: '2026-11-27', checkOut: '2026-11-30' },
    { unitId: await idOf('lodging_units', 'Regency'), roomType: 'deluxe', count: 14, checkIn: '2026-11-27', checkOut: '2026-11-30' },
  ])
}, 180_000)

afterAll(async () => {
  if (!hasDb) return
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
})

d('a four-function wedding with rooms', () => {
  it('1 · prices venue, food and add-ons into the proposal total', async () => {
    const bill = await schedule.payableBreakdown(eventId)
    // 4,32,000 venue + 9,65,000 food + 65,000 add-ons
    expect(bill.proposalPaise).toBe(R(14_62_000))
  }, 120_000)

  it('2 · prices 34 rooms over three nights, with the 5% rounded per line', async () => {
    const bill = await schedule.payableBreakdown(eventId)
    expect(bill.roomsPaise).toBe(R(4_89_000))          // 3,00,000 + 1,89,000
    expect(bill.roomsTaxPaise).toBe(R(24_450))         // 15,000 + 9,450, per line then summed
    // The wizard's own live estimate must agree to the paise, or the guest is quoted one
    // number and charged another.
    const pricing = await import('@/lib/pricing')
    const est = await pricing.roomEstimatePaise(eventId)
    expect(est.roomsPaise).toBe(bill.roomsPaise)
    expect(est.roomsTaxPaise).toBe(bill.roomsTaxPaise)
  }, 120_000)

  it('3 · takes a rupee discount inside the 10% cap and lands on the payable amount', async () => {
    const cap = await discounts.discountCap(eventId)
    expect(cap.capBasePaise).toBe(R(19_51_000))        // proposal + rooms, no tax of either kind
    expect(cap.capPaise).toBe(R(1_95_100))             // 10% of it
    expect(cap.headroomPaise).toBe(R(1_95_100))        // nothing given yet

    const res = await discounts.addDiscount(bm, eventId, {
      head: 'overall', amountPaise: R(1_00_000), remark: 'Repeat family — owner’s goodwill',
    })
    expect(res.deferred).toBe(false)                   // inside the cap, effective at once

    const bill = await schedule.payableBreakdown(eventId)
    expect(bill.discountPaise).toBe(R(1_00_000))
    // 14,62,000 + 4,89,000 + 24,450 − 1,00,000
    expect(bill.payablePaise).toBe(R(18_75_450))
  }, 120_000)

  it('4 · shows 18% GST that is in the printed total and in nothing else', async () => {
    const shown = await invoice.shownTaxPaise(eventId)
    // 77,760 venue + 1,73,700 food + 11,700 add-ons, rounded per line
    expect(shown).toBe(R(2_63_160))

    const bill = await schedule.payableBreakdown(eventId)
    expect(bill.payablePaise + shown).toBe(R(21_38_610))   // what the document prints as Total
    // …and the payable amount is untouched by it. This is the assertion that matters: if the
    // 18% ever leaks into a threshold or a balance, it fails here first.
    expect(bill.payablePaise).toBe(R(18_75_450))
  }, 120_000)

  it('5 · sets milestones at 25 / 50 / 100% of the payable amount', async () => {
    const s = await schedule.paymentSchedule(eventId, '2026-08-05')
    const by = Object.fromEntries(s.milestones.map((m) => [m.key, m]))
    expect(by.advance!.requiredPaise).toBe(46_886_250)      // ₹4,68,862.50
    expect(by.wedding_balance!.requiredPaise).toBe(R(9_37_725))
    expect(by.wedding_balance!.dueOn).toBe('2026-10-28')    // 30 days before 27 Nov
    expect(by.settlement!.requiredPaise).toBe(R(18_75_450))
  }, 120_000)

  it('6 · confirms on a part advance, holds all five venue windows, carries the rest as due', async () => {
    const res = await confirmSvc.confirmEvent(bm, eventId, {
      amountPaise: R(3_00_000), mode: 'bank', receiptNo: `FP-${Date.now()}`, receivedOn: '2026-08-05',
    })
    expect(res.advanceRequiredPaise).toBe(46_886_250)
    expect(res.advanceShortfallPaise).toBe(16_886_250)      // ₹1,68,862.50 still due

    // Five rows, not four: the Wedding is a bundle and books BOTH member venues (BR-C1).
    const [{ n }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM venue_bookings WHERE event_id = ${eventId}`,
    )) as unknown as { n: number }[]
    expect(n).toBe(5)

    // And the shortfall is what the calendar will mark Downpayment due.
    const short = await schedule.advanceShortfallByEvent([eventId])
    expect(short.get(eventId)).toBe(16_886_250)
  }, 180_000)

  it('7 · reports a ledger that counts the rooms it used to forget', async () => {
    const led = await payments.getLedger(eventId)
    expect(led.proposalTotalPaise).toBe(R(14_62_000))
    expect(led.roomsPaise).toBe(R(4_89_000))
    expect(led.payablePaise).toBe(R(18_75_450))
    expect(led.paidPaise).toBe(R(3_00_000))
    // The old ledger measured proposal_total alone and would have said 11,62,000 here —
    // understating the balance by the entire lodging charge plus its tax.
    expect(led.balancePaise).toBe(R(15_75_450))
    expect(led.shownGstPaise).toBe(R(2_63_160))
    expect(led.displayTotalPaise).toBe(R(21_38_610))
  }, 120_000)

  it('8 · tops up to the 25% and the marker clears', async () => {
    await payments.recordPayment(bm, eventId, {
      kind: 'part_payment', amountPaise: 16_886_250, mode: 'upi',
      receiptNo: `FP-TOP-${Date.now()}`, receivedOn: '2026-08-05',
    })
    const short = await schedule.advanceShortfallByEvent([eventId])
    expect(short.has(eventId)).toBe(false)

    // The wedding's 50% is still ahead of them: 9,37,725 needed, 4,68,862.50 in.
    const s = await schedule.paymentSchedule(eventId, '2026-08-05')
    const wb = s.milestones.find((m) => m.key === 'wedding_balance')!
    expect(wb.shortfallPaise).toBe(R(9_37_725) - 46_886_250)
    expect(wb.overdue).toBe(false)                          // D-30 is 28 Oct, still to come
  }, 120_000)
})
