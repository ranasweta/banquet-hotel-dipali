/**
 * One big wedding, end to end — the whole product exercised as a real proposal would be.
 *
 * Four functions, four menus with preferences and swapped-in dishes, increases across
 * several segments, a chef delicacy, 30 rooms in two lodges, an advance, confirmation,
 * the calendar advancing the event through its dates, all four sign-offs, the lock, and
 * the bill. Each step asserts the state the NEXT step depends on, so a break anywhere is
 * attributed rather than surfacing as a mystery at the end.
 *
 * It exists because the per-module suites each prove their own rule and none of them prove
 * the rules compose: a menu that saves, an increase that submits, an approval that applies
 * and a bill that adds up are four passing tests and still not a working booking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const menus = await import('@/lib/menus')
const rooms = await import('@/lib/rooms')
const approvals = await import('@/lib/approvals')
const confirmSvc = await import('@/lib/confirm')
const events = await import('@/lib/events')
const lock = await import('@/lib/lock')
const invoice = await import('@/lib/invoice')
const chef = await import('@/lib/chef')
const daysheet = await import('@/lib/daysheet')
const notifications = await import('@/lib/notifications')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping the end-to-end wedding\n')

const bm = { id: '', roleName: 'booking_manager' }
const ha = { id: '', roleName: 'higher_authority' }
const chefUser = { id: '', roleName: 'chef' }
const auditor = { id: '', roleName: 'auditor' }
const banquet = { id: '', roleName: 'banquet_manager' }
const lodge = { id: '', roleName: 'lodge_manager' }
const maint = { id: '', roleName: 'maintenance' }

// The wedding runs Thursday to Sunday; guests arrive the day the first function does.
const DAYS = ['2027-02-11', '2027-02-12', '2027-02-13', '2027-02-14'] as const
const FUNCTIONS = [
  { name: 'Haldi', date: DAYS[0], start: '10:00', end: '14:00', pax: 250 },
  { name: 'Sangeet', date: DAYS[1], start: '19:00', end: '23:30', pax: 400 },
  { name: 'Wedding', date: DAYS[2], start: '19:00', end: '23:59', pax: 600 },
  { name: 'Reception', date: DAYS[3], start: '19:00', end: '23:00', pax: 500 },
] as const

let eventId = ''
const subIds: string[] = []
let silverId = ''

async function userId(role: string): Promise<string> {
  const [u] = (await db.execute(sql`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ${role} LIMIT 1
  `)) as unknown as { id: string }[]
  return u!.id
}
async function unitId(name: string): Promise<string> {
  const [u] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = ${name}`)) as unknown as { id: string }[]
  return u!.id
}
async function statusOf(): Promise<string> {
  const [e] = await db.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1)
  return e!.status
}
/** A venue with a rate card for weddings, big enough not to trip the capacity note. */
async function weddingVenue(): Promise<string> {
  const [v] = (await db.execute(sql`
    SELECT v.id FROM venues v
    JOIN venue_rate_cards rc ON rc.venue_id = v.id AND rc.event_type = 'wedding'
    WHERE v.is_active AND v.capacity_max >= 600
    ORDER BY v.capacity_max
    LIMIT 1
  `)) as unknown as { id: string }[]
  if (!v) throw new Error('no wedding-rated venue big enough — seed problem, not a test problem')
  return v.id
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
  ha.id = await userId('higher_authority')
  chefUser.id = await userId('chef')
  auditor.id = await userId('auditor')
  banquet.id = await userId('banquet_manager')
  lodge.id = await userId('lodge_manager')
  maint.id = await userId('maintenance')
  const [t] = await db.select({ id: schema.menuTiers.id }).from(schema.menuTiers).where(eq(schema.menuTiers.name, 'Silver')).limit(1)
  silverId = t!.id
}, 120_000)

afterAll(async () => {
  if (!hasDb) return
  // The event finishes this run billed, and `forbid_locked_event_write` refuses to let its
  // children go — which is the guard working. Stand it down before clearing up.
  await db.update(schema.events).set({ status: 'enquiry' }).where(eq(schema.events.id, eventId))
  // `invoices` references events WITHOUT cascade — deliberately, since a bill outliving its
  // event would be a hole in the audit trail. The tear-down has to clear it explicitly.
  await db.delete(schema.invoices)
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
})

d('a whole wedding, start to finish', () => {
  it('1 · opens the enquiry with three contacts and both Aadhaar sides', async () => {
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [ev] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Sharma / Verma', eventType: 'wedding', createdBy: bm.id })
      .returning({ id: schema.events.id })
    eventId = ev!.id

    // FR-1.11: a wedding needs three contacts, and confirm re-checks it.
    await db.insert(schema.eventContacts).values([
      { eventId, phone: '9810000001', label: 'primary' },
      { eventId, phone: '9810000002', label: 'father' },
      { eventId, phone: '9810000003', label: 'coordinator' },
    ])
    await db.insert(schema.guestDocuments).values([
      { eventId, kind: 'aadhaar_front', fileKey: 'e2e/front.enc', uploadedBy: bm.id },
      { eventId, kind: 'aadhaar_back', fileKey: 'e2e/back.enc', uploadedBy: bm.id },
    ])
    expect(await statusOf()).toBe('enquiry')
  }, 120_000)

  it('2 · books four functions into one venue on consecutive days', async () => {
    const venueId = await weddingVenue()
    for (const f of FUNCTIONS) {
      const [se] = await db
        .insert(schema.subEvents)
        .values({ eventId, name: f.name, eventDate: f.date, startTime: f.start, endTime: f.end, venueId, pax: f.pax })
        .returning({ id: schema.subEvents.id })
      subIds.push(se!.id)
    }
    expect(subIds).toHaveLength(4)
  }, 120_000)

  it('3 · saves a COMPLETE menu on every function, with preferences on the dishes', async () => {
    // A real wedding menu is filled, not sampled: the lock checklist blocks on any function
    // whose menu is incomplete, so a partial menu here would stop the whole thing at step 13.
    // The preference is what the kitchen acts on and what the Chef and Banquet Manager must
    // be able to read — asserted on the board in step 11.
    const catalog = await menus.getTierCatalog()
    const silver = catalog.find((t) => t.name === 'Silver')!
    const fullSelections: Record<string, string[]> = {}
    for (const c of silver.categories) {
      if (c.pickCount == null) continue // all-included: the server fills these itself
      fullSelections[c.name] = c.items.slice(0, c.pickCount)
    }
    // Every choosable category must actually have enough dishes to fill.
    for (const c of silver.categories) {
      if (c.pickCount == null) continue
      expect(fullSelections[c.name]!.length).toBe(c.pickCount)
    }

    const notes = {
      Soup: { [fullSelections.Soup![0]!]: 'extra spicy, no cornflour' },
      'Paneer Main Course': { [fullSelections['Paneer Main Course']![0]!]: 'less oil' },
    }

    for (const subId of subIds) {
      const res = await menus.saveSubEventMenu(bm, subId, { tierId: silverId, selections: fullSelections, notes })
      expect(res.isComplete).toBe(true)
    }

    const snap = await menus.getSubEventMenu(subIds[0]!)
    expect(snap.menu!.tierName).toBe('Silver')
    // BR-M5: weddings carry the Rs. 50 surcharge, applied server-side.
    expect(snap.menu!.surchargePaise).toBe(5000)
    expect(snap.menu!.perPlatePaise).toBe(70000)
    expect(snap.menu!.isComplete).toBe(true)
    const soup = snap.menu!.categories.find((c) => c.categoryName === 'Soup')!
    expect(Object.values(soup.notes)).toContain('extra spicy, no cornflour')
  }, 240_000)

  it('4 · unlocks segments and takes extras — two free per function, the rest to the GM', async () => {
    const haldi = subIds[0]!
    const catalog = await menus.getTierCatalog()
    const silver = catalog.find((t) => t.name === 'Silver')!
    const base: Record<string, string[]> = {}
    for (const c of silver.categories) {
      if (c.pickCount == null) continue
      base[c.name] = c.items.slice(0, c.pickCount)
    }

    await menus.increaseCategory(bm, haldi, 'Soup')
    await menus.increaseCategory(bm, haldi, 'Paneer Main Course')

    // Two more soups and two more paneers: four extras, of which two are free.
    const soupCat = silver.categories.find((c) => c.name === 'Soup')!
    const paneerCat = silver.categories.find((c) => c.name === 'Paneer Main Course')!
    const withExtras = {
      ...base,
      Soup: soupCat.items.slice(0, soupCat.pickCount! + 2),
      'Paneer Main Course': paneerCat.items.slice(0, paneerCat.pickCount! + 2),
    }
    // A save replaces the whole snapshot, notes included — the picker always sends the full
    // map, so the test must too or the preferences from step 3 are dropped.
    await menus.saveSubEventMenu(bm, haldi, {
      tierId: silverId,
      selections: withExtras,
      notes: {
        Soup: { [soupCat.items[0]!]: 'extra spicy, no cornflour' },
        'Paneer Main Course': { [paneerCat.items[0]!]: 'less oil' },
      },
    })

    const summary = (await menus.getIncreaseSummary(haldi))!
    expect(summary.totalExtras).toBe(4)
    expect(summary.freeCovered).toBe(2)
    expect(summary.awaitingSubmission).toBe(2)
    // The allowance is per function, so the other three are untouched by Haldi spending it.
    expect((await menus.getIncreaseSummary(subIds[1]!))!.totalExtras).toBe(0)
  }, 240_000)

  it('5 · sends Haldi\'s extras to the GM, who grants one of the two', async () => {
    const haldi = subIds[0]!
    const { exceptionId, submitted } = await menus.submitIncreases(bm, haldi)
    expect(submitted).toBe(2)

    const [exc] = await db.select().from(schema.exceptions).where(eq(schema.exceptions.id, exceptionId!))
    const payload = exc!.payload as { subEventName: string; items: { categoryName: string; dishes: string[] }[] }
    expect(payload.subEventName).toBe('Haldi')
    // The Authority decides on dishes, not on a number.
    expect(payload.items.flatMap((i) => i.dishes).length).toBeGreaterThan(0)

    await approvals.decideException(ha, exceptionId!, {
      action: 'approve_modified',
      remark: 'One extra per segment only',
      modified: { extraPicks: 1 },
    })

    // Nothing is left pending, which is what the lock will insist on.
    const pending = await db.select().from(schema.exceptions).where(eq(schema.exceptions.eventId, eventId))
    expect(pending.filter((p) => p.status === 'pending')).toHaveLength(0)
  }, 180_000)

  it('6 · prices a chef delicacy per plate, and it reaches the proposal total', async () => {
    const wedding = subIds[2]!
    const before = (await db.select({ t: schema.events.proposalTotalPaise }).from(schema.events).where(eq(schema.events.id, eventId)))[0]!.t
    const { id } = await chef.requestDelicacy(bm, wedding, 'Live sushi counter')
    await chef.priceDelicacy(chefUser, id, { chargePaise: 15_000 })
    const after = (await db.select({ t: schema.events.proposalTotalPaise }).from(schema.events).where(eq(schema.events.id, eventId)))[0]!.t
    // Per plate × the wedding's 600 guests.
    expect(after - before).toBe(15_000 * 600)
  }, 180_000)

  it('7 · books 30 rooms across two lodges, inside the event dates', async () => {
    const palace = await unitId('Palace')
    const regency = await unitId('Regency')
    const res = await rooms.saveRoomRequirements(bm, eventId, [
      { unitId: palace, roomType: 'deluxe', count: 20, checkIn: DAYS[0], checkOut: '2027-02-15' },
      { unitId: regency, roomType: 'deluxe', count: 10, checkIn: DAYS[1], checkOut: '2027-02-15' },
    ])
    expect(res).toMatchObject({ lines: 2, totalRooms: 30, deferred: false }) // under the 35 gate

    // Everything promised is deliverable — nothing else holds these nights.
    const rec = await rooms.getReconciliation(eventId)
    expect(rec.deliverable).toBe(true)
    expect(rec.totals).toEqual({ promised: 30, shortfall: 0 })
  }, 180_000)

  it('8 · refuses more rooms than exist, and dates outside the event', async () => {
    const palace = await unitId('Palace')
    const good = { unitId: palace, roomType: 'deluxe', count: 20, checkIn: DAYS[0], checkOut: '2027-02-15' }

    await expect(
      rooms.saveRoomRequirements(bm, eventId, [{ ...good, count: 40 }]),
    ).rejects.toMatchObject({ status: 409 })

    await expect(
      rooms.saveRoomRequirements(bm, eventId, [{ ...good, checkIn: '2027-02-09' }]),
    ).rejects.toThrow(/before the event starts/)

    // The failed attempts left the good booking alone.
    const rec = await rooms.getReconciliation(eventId)
    expect(rec.totals.promised).toBe(30)
  }, 180_000)

  it('9 · confirms on a 25% advance, taking the venue for all four nights', async () => {
    const pricing = await import('@/lib/pricing')
    const money = await import('@/lib/money')
    const subs = await pricing.loadSubEventsForPricing(eventId)
    const priced = await pricing.priceProposal('wedding', subs)
    expect(priced.missing).toHaveLength(0) // BR-R1: every venue is rated

    // The same base the confirm gate uses: the proposal plus rooms and their 5% tax
    // (client, 20 Jul 2026 — see SEED_ASSUMPTIONS §F10). The 18% added on 4 Aug 2026 is
    // printed and collected from nobody, so it is deliberately absent from this figure.
    const schedule = await import('@/lib/payment-schedule')
    const bill = await schedule.payableBreakdown(eventId)
    const [extras, roomEst] = await Promise.all([
      pricing.foodAndAddonTotal(eventId),
      pricing.roomEstimatePaise(eventId),
    ])
    const base =
      priced.totalPaise + extras.foodPaise + extras.addonPaise + roomEst.roomsPaise + roomEst.roomsTaxPaise
    // The shared module and the hand-rolled sum must be the same number, or the figure quoted
    // on the wizard and the figure enforced at confirm could drift apart.
    expect(bill.payablePaise).toBe(base)

    const advance = money.percentOfPaise(base, 25)
    const res = await confirmSvc.confirmEvent(bm, eventId, {
      amountPaise: advance,
      mode: 'bank',
      receiptNo: `E2E-${Date.now()}`,
      receivedOn: '2027-01-05',
    })
    expect(res.advanceShortfallPaise).toBe(0) // paid in full, so nothing carried

    expect(await statusOf()).toBe('confirmed')
    // BR-C1: one venue_bookings row per function, inserted only after the money landed.
    const [{ n }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM venue_bookings WHERE event_id = ${eventId}`,
    )) as unknown as { n: number }[]
    expect(n).toBe(4)
  }, 180_000)

  it('10 · refuses a second booking of the same venue and window', async () => {
    const venueId = await weddingVenue()
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [clash] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Clash Test', eventType: 'wedding', createdBy: bm.id })
      .returning({ id: schema.events.id })
    await db.insert(schema.subEvents).values({
      eventId: clash!.id, name: 'Wedding', eventDate: DAYS[2], startTime: '20:00', endTime: '23:00', venueId, pax: 100,
    })
    const avail = await (await import('@/lib/availability')).checkAvailability({
      venueId, date: DAYS[2], startTime: '20:00', endTime: '23:00',
    })
    expect(avail.available).toBe(false) // the GiST exclusion has the slot
    await db.delete(schema.events).where(eq(schema.events.id, clash!.id))
  }, 180_000)

  it('11 · shows the Chef and Banquet Manager the full menu, with descriptions and no money', async () => {
    const board = await daysheet.getOperationsHorizon(DAYS[0], 4, DAYS[0])
    const haldi = board.days[0]!.functions.find((f) => f.name === 'Haldi')!
    expect(board.days[0]!.isToday).toBe(true)
    expect(haldi.pax).toBe(250)
    expect(haldi.tierName).toBe('Silver')

    // The preference rides along with the dish — this is the thing the kitchen cooks to,
    // and the whole point of showing the Chef and Banquet Manager the menu at all.
    const soup = haldi.segments.find((s) => s.name === 'Soup')!
    const noted = soup.dishes.filter((x) => x.note)
    expect(noted).toHaveLength(1)
    expect(noted[0]!.note).toBe('extra spicy, no cornflour')

    // And on a second segment, so it is not a one-off.
    const paneer = haldi.segments.find((s) => s.name === 'Paneer Main Course')!
    expect(paneer.dishes.filter((x) => x.note).map((x) => x.note)).toEqual(['less oil'])

    // Extras are distinguishable from base picks.
    expect(soup.dishes.some((x) => x.isExtra)).toBe(true)

    // The priced chef delicacy is part of what the kitchen makes.
    const wedding = board.days[2]!.functions.find((f) => f.name === 'Wedding')!
    expect(wedding.chefDishes).toContainEqual({ description: 'Live sushi counter', pending: false })

    // Not one rupee anywhere in the payload.
    expect(JSON.stringify(board)).not.toMatch(/[Pp]aise|ratePaise|perPlate/)
  }, 180_000)

  it('12 · advances through its dates as the calendar turns', async () => {
    await events.advanceEventStatuses(auditor, DAYS[0])
    expect(await statusOf()).toBe('in_progress')

    await events.advanceEventStatuses(auditor, DAYS[3]) // last function is today
    expect(await statusOf()).toBe('in_progress')

    await events.advanceEventStatuses(auditor, '2027-02-15')
    expect(await statusOf()).toBe('completed')
  }, 180_000)

  it('13 · collects maintenance, then all four sign-offs', async () => {
    const maintenance = await import('@/lib/maintenance')
    await maintenance.addEntry(maint, eventId, {
      item: 'Generator (extra hours)', qty: 6, unit: 'hrs', ratePaise: 250_000, remarks: 'power cut on the 13th',
    })
    await maintenance.closeMaintenance(maint, eventId) // also records the maintenance sign-off

    await lock.signoff(banquet, eventId, 'banquet_manager')
    await lock.signoff(lodge, eventId, 'lodge_manager')

    const checklist = await lock.lockChecklist(eventId)
    const blockers = checklist.items.filter((i) => i.blocking && !i.done)
    expect(blockers.map((b) => b.key)).toEqual([]) // everything green
    expect(checklist.canLock).toBe(true)
  }, 180_000)

  it('14 · locks, and the record goes immutable', async () => {
    await lock.lockEvent(auditor, eventId)
    expect(await statusOf()).toBe('locked')

    // CLAUDE.md rule 6 — the service blocks first, the trigger backs it.
    await expect(
      menus.saveSubEventMenu(bm, subIds[0]!, { tierId: silverId, selections: { Soup: ['Hot & Sour Soup'] } }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      rooms.saveRoomRequirements(bm, eventId, [
        { unitId: await unitId('Palace'), roomType: 'deluxe', count: 1, checkIn: DAYS[0], checkOut: '2027-02-15' },
      ]),
    ).rejects.toMatchObject({ status: 409 })
  }, 180_000)

  it('15 · bills it: grouped by function, rooms taxed at 5%, and the arithmetic closes', async () => {
    const inv = (await invoice.getInvoice(eventId))!
    expect(inv.lines.length).toBeGreaterThan(0)

    // Every venue and food line names the function it belongs to; rooms and maintenance
    // are event-level and carry none (they span the whole stay).
    const venueLines = inv.lines.filter((l) => l.section === 'venue')
    expect(venueLines).toHaveLength(4)
    expect(new Set(venueLines.map((l) => l.functionLabel))).toEqual(
      new Set(FUNCTIONS.map((f) => f.name)),
    )
    expect(inv.lines.filter((l) => l.section === 'rooms').every((l) => l.functionLabel === null)).toBe(true)

    // Rooms 5%, everything else 18% (client's lead, 4 Aug 2026). The Auditor's own adjustment
    // lines keep whatever rate they were given, so they are excluded from this rule.
    for (const l of inv.lines.filter((x) => x.section !== 'adjustment')) {
      expect(l.gstRateBp).toBe(l.section === 'rooms' ? 500 : 1800)
    }

    // The totals are the lines, to the paise — and the two taxes land in different places.
    // Only the rooms 5% is collected, so only it reaches netPaise and therefore the balance;
    // the 18% moves the printed Total alone. A booking could never be settled otherwise.
    const gross = inv.lines.reduce((n, l) => n + l.amountPaise, 0)
    const collected = inv.lines.filter((l) => l.section === 'rooms').reduce((n, l) => n + l.taxPaise, 0)
    const shown = inv.lines.filter((l) => l.section !== 'rooms').reduce((n, l) => n + l.taxPaise, 0)
    expect(shown).toBeGreaterThan(0) // the 18% is genuinely on the document
    expect(inv.grossPaise).toBe(gross)
    expect(inv.taxPaise).toBe(collected)
    expect(inv.shownTaxPaise).toBe(shown)
    expect(inv.netPaise).toBe(gross - inv.discountPaise + collected)
    expect(inv.displayTotalPaise).toBe(inv.netPaise + shown)
    expect(inv.balancePaise).toBe(inv.netPaise - inv.advancesPaise)
    expect(inv.advancesPaise).toBeGreaterThan(0) // the advance from step 9

    await invoice.finaliseInvoice(auditor, eventId)
    expect(await statusOf()).toBe('billed')
    const final = (await invoice.getInvoice(eventId))!
    expect(final.invoiceNo).toMatch(/^D2-2026-\d{4}$/)
  }, 180_000)

  it('16 · leaves no stray notification behind', async () => {
    // A settled booking is nobody's queue. Rooms are locked, nothing is pending, and the
    // shortfall feed reads live, so a billed event must be silent.
    expect(await rooms.listRoomShortfalls({})).toHaveLength(0)
    const feed = await notifications.notificationsFor({ ...ha, lodgingUnitId: null })
    expect(feed.filter((n) => n.message.includes('Sharma / Verma'))).toHaveLength(0)
  }, 180_000)
})
