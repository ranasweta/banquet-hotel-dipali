/**
 * The guest-facing proposal document (`lib/proposal.ts`) — the payload behind the approved
 * template `Hotel-Dipali-Proposal-TEMPLATE_1.html`.
 *
 * The template is the spec, so the assertions here are about FIDELITY as much as arithmetic:
 * every function keeps its own venue, food, add-ons and menu snapshot; rooms group by lodge
 * with their stay dates; extras stay empty until the app has some; the pax on the overview is
 * the sum while each function keeps its own; and the 25% advance is computed on the base
 * `confirmEvent` actually enforces, so the document never quotes a figure the system refuses.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const proposal = await import('@/lib/proposal')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping proposal tests\n')

const bm = { id: '' }

async function userId(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}
async function idOf(table: 'venues' | 'menuTiers', name: string): Promise<string> {
  const t = table === 'venues' ? schema.venues : schema.menuTiers
  const [r] = await db.select({ id: t.id }).from(t).where(eq(t.name, name)).limit(1)
  return r!.id
}
async function newEventCode(): Promise<string> {
  const [{ code }] = (await db.execute(
    sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
  )) as unknown as { code: string }[]
  return code
}
/** The cheapest active rack rate for a lodge's category — what the document prices rooms at. */
async function rackRate(lodge: string, roomType: string): Promise<number> {
  const [r] = (await db.execute(sql`
    SELECT min(r.rack_rate_paise)::bigint AS rate FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
    WHERE u.name = ${lodge} AND r.room_type = ${roomType} AND r.is_active
  `)) as unknown as { rate: number }[]
  return Number(r!.rate)
}

/**
 * A two-function wedding with rooms in two lodges, a menu carrying one extra dish and one
 * all-included segment, a complimentary add-on and a fixed discount.
 *
 *   Sangeet   — venue 15,000 · Silver 650 + 50 surcharge = 700 × 100 pax · décor 2,000
 *               · welcome garland complimentary          →   87,000
 *   Reception — venue 20,000 · Silver 700 × 200 pax, overnight window → 1,60,000
 *   Rooms     — Palace deluxe 2 rooms × 2 nights · Regency deluxe 1 room × 1 night
 *   Discount  — a flat 1,000 off the overall head
 */
async function buildProposal(): Promise<{ eventId: string }> {
  const [ev] = await db
    .insert(schema.events)
    .values({
      code: await newEventCode(),
      guestName: 'Proposal Test',
      eventType: 'wedding',
      status: 'confirmed',
      plannedFrom: '2026-08-31',
      plannedTo: '2026-09-03',
      firstDate: '2026-09-01',
      lastDate: '2026-09-02',
      createdBy: bm.id,
    })
    .returning({ id: schema.events.id })
  const eventId = ev!.id

  await db.execute(sql`
    INSERT INTO event_contacts (event_id, phone, label) VALUES
      (${eventId}, '+919000000002', 'father'),
      (${eventId}, '+919000000001', 'primary'),
      (${eventId}, '+919000000003', 'coordinator')
  `)

  const silver = await idOf('menuTiers', 'Silver')
  const crystal = await idOf('venues', 'Crystal')

  // ── Sangeet ──
  const [a] = await db
    .insert(schema.subEvents)
    .values({
      eventId, name: 'Sangeet', eventDate: '2026-09-01', startTime: '19:00', endTime: '23:00',
      venueId: crystal, pax: 100, venueRatePaise: 1_500_000,
    })
    .returning({ id: schema.subEvents.id })
  const [menuA] = await db
    .insert(schema.subEventMenus)
    .values({ subEventId: a!.id, tierId: silver, tierName: 'Silver', baseRatePaise: 65_000, surchargePaise: 5_000, isComplete: true })
    .returning({ id: schema.subEventMenus.id })
  // One segment picked one over its base (the extra), one segment all-included (base_pick NULL).
  await db.execute(sql`
    INSERT INTO sub_event_menu_categories (menu_id, category_name, base_pick, extra_picks) VALUES
      (${menuA!.id}, 'Veg Starters', 4, 1),
      (${menuA!.id}, 'Breads', NULL, 0)
  `)
  await db.execute(sql`
    INSERT INTO sub_event_menu_selections (menu_id, category_name, item_name, is_extra) VALUES
      (${menuA!.id}, 'Veg Starters', 'Paneer Tikka', false),
      (${menuA!.id}, 'Veg Starters', 'Hara Bhara Kebab', false),
      (${menuA!.id}, 'Veg Starters', 'Corn Roll', false),
      (${menuA!.id}, 'Veg Starters', 'Veg Seekh', false),
      (${menuA!.id}, 'Veg Starters', 'Mushroom Duplex', true),
      (${menuA!.id}, 'Breads', 'Tandoori Roti', false),
      (${menuA!.id}, 'Breads', 'Butter Naan', false)
  `)
  await db.insert(schema.subEventAddons).values([
    { subEventId: a!.id, description: 'Décor', qty: 1, ratePaise: 200_000 },
    { subEventId: a!.id, description: 'Welcome garland', qty: 1, ratePaise: 0 },
  ])

  // ── Reception, running past midnight ──
  const [b] = await db
    .insert(schema.subEvents)
    .values({
      eventId, name: 'Reception', eventDate: '2026-09-02', startTime: '22:00', endTime: '02:00',
      venueId: crystal, pax: 200, venueRatePaise: 2_000_000,
    })
    .returning({ id: schema.subEvents.id })
  await db
    .insert(schema.subEventMenus)
    .values({ subEventId: b!.id, tierId: silver, tierName: 'Silver', baseRatePaise: 65_000, surchargePaise: 5_000, isComplete: true })

  // ── Rooms, in two lodges ──
  await db.execute(sql`
    INSERT INTO room_requirements (event_id, unit_id, room_type, count, check_in, check_out) VALUES
      (${eventId}, (SELECT id FROM lodging_units WHERE name = 'Palace'),  'deluxe', 2, '2026-09-01', '2026-09-03'),
      (${eventId}, (SELECT id FROM lodging_units WHERE name = 'Regency'), 'deluxe', 1, '2026-09-01', '2026-09-02')
  `)

  await db.execute(sql`
    INSERT INTO discounts (event_id, head, amount_paise, remark, given_by)
    VALUES (${eventId}, 'overall', 100_000, 'Repeat guest', ${bm.id})
  `)

  return { eventId }
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
}, 120_000)

async function cleanup() {
  // invoices and venue_bookings reference events without cascade — clear them first.
  await db.delete(schema.venueBookings)
  await db.delete(schema.invoices)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('proposal document — structure', () => {
  it('keeps each function whole: its window, its pax, its venue, food and add-ons', async () => {
    const { eventId } = await buildProposal()
    const doc = await proposal.proposalDocument(eventId)

    expect(doc.functions.map((f) => f.name)).toEqual(['Sangeet', 'Reception'])

    const [sangeet, reception] = doc.functions
    expect(sangeet!.pax).toBe(100)
    expect(sangeet!.venueName).toBe('Crystal')
    expect(sangeet!.venueRatePaise).toBe(1_500_000)
    // 650 base + 50 wedding surcharge = 700 a plate (BR-M5).
    expect(sangeet!.menu!.perPlatePaise).toBe(70_000)
    expect(sangeet!.foodAmountPaise).toBe(7_000_000)
    expect(sangeet!.addons.map((x) => [x.description, x.amountPaise])).toEqual([
      ['Décor', 200_000],
      ['Welcome garland', 0],
    ])
    expect(sangeet!.subtotalPaise).toBe(8_700_000)

    // end_time <= start_time is the past-midnight window; the template chips it "[+1]".
    expect(reception!.overnight).toBe(true)
    expect(sangeet!.overnight).toBe(false)
    expect(reception!.subtotalPaise).toBe(16_000_000)
  })

  it('snapshots the menu segment by segment, flagging the picks beyond base as extras', async () => {
    const { eventId } = await buildProposal()
    const doc = await proposal.proposalDocument(eventId)
    const menu = doc.functions[0]!.menu!

    const starters = menu.segments.find((s) => s.name === 'Veg Starters')!
    expect(starters.basePick).toBe(4)
    expect(starters.picked).toBe(5)
    expect(starters.dishes.filter((x) => x.isExtra).map((x) => x.name)).toEqual(['Mushroom Duplex'])

    // pick_count NULL = every item included; the card reads "All included", never "2 of null".
    const breads = menu.segments.find((s) => s.name === 'Breads')!
    expect(breads.basePick).toBeNull()
    expect(breads.picked).toBe(2)
    expect(breads.dishes.every((x) => !x.isExtra)).toBe(true)
  })

  it('groups rooms under their lodge with the stay dates, and sums rooms vs room-nights', async () => {
    const { eventId } = await buildProposal()
    const doc = await proposal.proposalDocument(eventId)

    expect(doc.lodges.map((l) => l.name)).toEqual(['Palace', 'Regency'])
    const palace = doc.lodges[0]!
    expect(palace.lines[0]).toMatchObject({ roomType: 'deluxe', count: 2, nights: 2, checkIn: '2026-09-01', checkOut: '2026-09-03' })
    expect(palace.rooms).toBe(2)
    expect(palace.roomNights).toBe(4)

    expect(doc.counts.rooms).toBe(3)
    expect(doc.counts.roomNights).toBe(5)
  })

  it('sums pax across functions while each function keeps its own count', async () => {
    const { eventId } = await buildProposal()
    const doc = await proposal.proposalDocument(eventId)
    expect(doc.counts.functions).toBe(2)
    expect(doc.counts.pax).toBe(300)
    expect(doc.functions.map((f) => f.pax)).toEqual([100, 200])
  })

  it('orders the contacts the way the card reads them — primary, father, co-ordinator', async () => {
    const { eventId } = await buildProposal()
    const doc = await proposal.proposalDocument(eventId)
    expect(doc.contacts.map((c) => c.label)).toEqual(['primary', 'father', 'coordinator'])
  })

  it('leaves extras empty until the app has some, and carries the declared run', async () => {
    const { eventId } = await buildProposal()
    const doc = await proposal.proposalDocument(eventId)
    expect(doc.extras).toEqual([])
    expect(doc.totals.extrasPaise).toBe(0)
    // The From/To window picked when the proposal was started, not the functions' span.
    expect(doc.event.plannedFrom).toBe('2026-08-31')
    expect(doc.event.plannedTo).toBe('2026-09-03')
    expect(doc.event.eventTypeLabel).toBeTruthy()
  })
})

d('proposal document — money', () => {
  it('reconciles venue + food + rooms + 5% room tax − discount to the paise', async () => {
    const { eventId } = await buildProposal()
    const doc = await proposal.proposalDocument(eventId)

    const palaceRate = await rackRate('Palace', 'deluxe')
    const regencyRate = await rackRate('Regency', 'deluxe')
    const palace = 2 * 2 * palaceRate
    const regency = 1 * 1 * regencyRate
    // Tax is rounded PER LINE then summed — the same order lib/pricing.ts and lib/invoice.ts
    // use, so the estimate and the eventual Draft cannot differ by a rounding paisa.
    const expectedTax = Math.round((palace * 500) / 10000) + Math.round((regency * 500) / 10000)

    expect(doc.totals.proposalPaise).toBe(24_700_000)
    expect(doc.totals.roomsPaise).toBe(palace + regency)
    expect(doc.totals.roomsTaxPaise).toBe(expectedTax)
    expect(doc.totals.discountPaise).toBe(100_000)
    expect(doc.totals.subtotalPaise).toBe(24_700_000 + palace + regency - 100_000)
    expect(doc.totals.totalPaise).toBe(doc.totals.subtotalPaise + expectedTax)
  })

  it('computes the 25% advance on the base confirm enforces — rooms and room tax in, extras out', async () => {
    const { eventId } = await buildProposal()
    const doc = await proposal.proposalDocument(eventId)

    const base = doc.totals.proposalPaise + doc.totals.roomsPaise + doc.totals.roomsTaxPaise - doc.totals.discountPaise
    expect(doc.totals.advancePaise).toBe(Math.round(base * 0.25))
    expect(doc.totals.balancePaise).toBe(doc.totals.totalPaise - doc.totals.advancePaise)
  })

  it('is a Draft while an enquiry and a Draft 2 once confirmed', async () => {
    const { eventId } = await buildProposal()
    expect((await proposal.proposalDocument(eventId)).doc.isDraft2).toBe(true)
    await db.update(schema.events).set({ status: 'enquiry' }).where(eq(schema.events.id, eventId))
    expect((await proposal.proposalDocument(eventId)).doc.isDraft2).toBe(false)
  })
})

d('proposal document — BR-R1', () => {
  it('prices a venue with no rate card at NOTHING, never at zero', async () => {
    const [{ id: propertyId }] = (await db.execute(
      sql`SELECT id FROM properties LIMIT 1`,
    )) as unknown as { id: string }[]
    const [{ id: venueId }] = (await db.execute(sql`
      INSERT INTO venues (property_id, name, kind, capacity_min, capacity_max)
      VALUES (${propertyId}, 'Uncarded Hall', 'hall', 10, 200) RETURNING id
    `)) as unknown as { id: string }[]

    const [ev] = await db
      .insert(schema.events)
      .values({ code: await newEventCode(), guestName: 'No Rate Card', eventType: 'birthday', status: 'enquiry', createdBy: bm.id })
      .returning({ id: schema.events.id })
    await db.insert(schema.subEvents).values({
      eventId: ev!.id, name: 'Party', eventDate: '2026-10-01', startTime: '19:00', endTime: '23:00',
      venueId, pax: 50, venueRatePaise: 0,
    })

    const doc = await proposal.proposalDocument(ev!.id)
    // null, not 0 — the document prints "On approval" and the total does not silently absorb
    // a free venue (docs/SEED_ASSUMPTIONS.md: a missing rate card is a gate, never a zero).
    expect(doc.functions[0]!.venueRatePaise).toBeNull()
    expect(doc.totals.proposalPaise).toBe(0)
  })
})
