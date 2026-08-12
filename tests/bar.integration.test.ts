/**
 * The bar (client, 12 Aug 2026) — brands the Auditor prices, bottles a function orders.
 *
 * The rule this file exists to defend is the same one the menu master's does: **re-pricing the
 * catalogue must never re-price a booking**. A bar line snapshots the brand's name and its rate
 * when it is ordered, so a proposal quoted in August is still explicable in November. The rest
 * is the money path — a bottle has to reach `proposal_total_paise` and the bill on its own, or
 * the hotel pours alcohol it never charges for.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

const bar = await import('@/lib/bar')
const { foodAndAddonTotal } = await import('@/lib/pricing')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping bar tests\n')

const auditor = { id: '', roleName: 'auditor' }
const bm = { id: '', roleName: 'booking_manager' }
let venueId = ''

async function userId(role: string): Promise<string> {
  const [u] = (await db.execute(sql`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ${role} LIMIT 1
  `)) as unknown as { id: string }[]
  return u!.id
}

/** An enquiry with one function; returns both ids. */
async function makeSubEvent(date = '2027-05-01'): Promise<{ eventId: string; subEventId: string }> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Bar Test', eventType: 'engagement', createdBy: bm.id })
    .returning({ id: schema.events.id })
  const [se] = await db
    .insert(schema.subEvents)
    .values({ eventId: ev!.id, name: 'Reception', eventDate: date, startTime: '19:00', endTime: '23:00', venueId, pax: 100 })
    .returning({ id: schema.subEvents.id })
  return { eventId: ev!.id, subEventId: se!.id }
}

/**
 * The event's whole proposal figure — venue rent included, which is why every assertion below
 * measures a DELTA. What matters is that a bottle moves this number by exactly its own price.
 */
async function proposalTotal(eventId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT COALESCE(proposal_total_paise, 0)::bigint AS total FROM events WHERE id = ${eventId}
  `)) as unknown as { total: number }[]
  return Number(row!.total)
}

/** The bar's own contribution, isolated from venue and food. */
async function barTotal(eventId: string): Promise<number> {
  return (await foodAndAddonTotal(eventId)).barPaise
}

/** Postgres errors arrive wrapped by Drizzle; the trigger's message is down the cause chain. */
function causeChain(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('message' in cur) parts.push(String((cur as { message: unknown }).message))
    cur = (cur as { cause?: unknown }).cause
  }
  return parts.join(' | ')
}

async function maxAuditSeq(): Promise<number> {
  const [row] = (await db.execute(sql`SELECT COALESCE(max(seq), 0)::bigint AS seq FROM audit_log`)) as unknown as { seq: number }[]
  return Number(row!.seq)
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
  const [v] = (await db.execute(sql`SELECT id FROM venues WHERE is_active LIMIT 1`)) as unknown as { id: string }[]
  venueId = v!.id
}, 120_000)

async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events) // cascades to sub-events and their bar lines
  await db.execute(sql`DELETE FROM bar_brands`)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('the bar catalogue', () => {
  it('adds a brand and refuses the same one under different capitals', async () => {
    await bar.createBrand(auditor, { name: 'Blenders Pride', pricePerBottlePaise: 180_000 })
    // The index is on lower(name): two of these in the dropdown is how one gets picked at the
    // wrong price.
    await expect(
      bar.createBrand(auditor, { name: 'blenders pride', pricePerBottlePaise: 200_000 }),
    ).rejects.toMatchObject({ status: 409 })
  }, 120_000)

  it('refuses a bottle that costs nothing', async () => {
    await expect(bar.createBrand(auditor, { name: 'Free Whisky', pricePerBottlePaise: 0 })).rejects.toMatchObject({ status: 400 })
  }, 120_000)

  it('retires a brand and refuses to order it', async () => {
    const { id } = await bar.createBrand(auditor, { name: 'Old Monk', pricePerBottlePaise: 90_000 })
    const { subEventId } = await makeSubEvent()
    await bar.updateBrand(auditor, id, { isActive: false })

    expect((await bar.listActiveBrands()).map((b) => b.name)).not.toContain('Old Monk')
    // …and the server refuses even if a stale screen still offers it.
    await expect(bar.setBarLine(bm, subEventId, { brandId: id, bottles: 2 })).rejects.toMatchObject({ status: 400 })
  }, 120_000)
})

d('ordering bottles', () => {
  it('prices from the catalogue and reaches the proposal total', async () => {
    const { id } = await bar.createBrand(auditor, { name: 'Antiquity Blue', pricePerBottlePaise: 150_000 })
    const { eventId, subEventId } = await makeSubEvent()
    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 1 })
    const oneBottle = await proposalTotal(eventId)

    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 4 })

    const [line] = await bar.getSubEventBar(subEventId)
    expect(line).toMatchObject({ brandName: 'Antiquity Blue', ratePaise: 150_000, bottles: 4, totalPaise: 600_000 })
    expect(await barTotal(eventId)).toBe(600_000)
    // The money has to arrive on its own — nothing else charges for it. Three more bottles,
    // three more bottle-prices on the proposal, and nothing else moved.
    expect(await proposalTotal(eventId)).toBe(oneBottle + 450_000)
  }, 120_000)

  it('replaces the count rather than adding a second line of the same brand', async () => {
    const { id } = await bar.createBrand(auditor, { name: 'Royal Stag', pricePerBottlePaise: 100_000 })
    const { eventId, subEventId } = await makeSubEvent()

    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 3 })
    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 2 })

    const lines = await bar.getSubEventBar(subEventId)
    expect(lines).toHaveLength(1) // not "3 bottles" and "2 bottles" for a reader to add up
    expect(lines[0]!.bottles).toBe(2)
    expect(await barTotal(eventId)).toBe(200_000) // two bottles' worth, not five
  }, 120_000)

  it('takes the money back out when the line is removed', async () => {
    const { id } = await bar.createBrand(auditor, { name: 'Signature', pricePerBottlePaise: 120_000 })
    const { eventId, subEventId } = await makeSubEvent()
    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 5 })
    const withBottles = await proposalTotal(eventId)
    expect(await barTotal(eventId)).toBe(600_000)

    const [line] = await bar.getSubEventBar(subEventId)
    await bar.removeBarLine(bm, line!.id)

    expect(await bar.getSubEventBar(subEventId)).toEqual([])
    expect(await barTotal(eventId)).toBe(0)
    expect(await proposalTotal(eventId)).toBe(withBottles - 600_000)
  }, 120_000)

  it('refuses a fractional or empty order', async () => {
    const { id } = await bar.createBrand(auditor, { name: 'Teachers', pricePerBottlePaise: 200_000 })
    const { subEventId } = await makeSubEvent()
    await expect(bar.setBarLine(bm, subEventId, { brandId: id, bottles: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(bar.setBarLine(bm, subEventId, { brandId: id, bottles: 1.5 })).rejects.toMatchObject({ status: 400 })
  }, 120_000)
})

d('re-pricing the bar leaves a quoted booking alone (rule 4)', () => {
  it('keeps the rate the bottle was ordered at, and the total with it', async () => {
    const { id } = await bar.createBrand(auditor, { name: 'Black Dog', pricePerBottlePaise: 250_000 })
    const { eventId, subEventId } = await makeSubEvent()
    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 2 })
    const quoted = await proposalTotal(eventId)
    expect(await barTotal(eventId)).toBe(500_000)

    // The hotel puts the price up by half.
    await bar.updateBrand(auditor, id, { pricePerBottlePaise: 375_000 })

    const [line] = await bar.getSubEventBar(subEventId)
    expect(line!.ratePaise).toBe(250_000) // the snapshot, not the catalogue
    expect(await barTotal(eventId)).toBe(500_000)
    expect(await proposalTotal(eventId)).toBe(quoted)

    // A brand rename does not rewrite the line either — the bill says what was sold.
    await bar.updateBrand(auditor, id, { name: 'Black Dog Triple Gold' })
    expect((await bar.getSubEventBar(subEventId))[0]!.brandName).toBe('Black Dog')

    // …but the next order takes today's price and today's name.
    const { subEventId: other } = await makeSubEvent('2027-06-01')
    await bar.setBarLine(bm, other, { brandId: id, bottles: 1 })
    expect((await bar.getSubEventBar(other))[0]).toMatchObject({ ratePaise: 375_000, brandName: 'Black Dog Triple Gold' })
  }, 120_000)

  it('will not let a brand be deleted out from under a quoted bottle', async () => {
    const { id } = await bar.createBrand(auditor, { name: 'Jameson', pricePerBottlePaise: 300_000 })
    const { subEventId } = await makeSubEvent()
    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 1 })
    // ON DELETE RESTRICT: brands retire, they do not vanish.
    await expect(db.execute(sql`DELETE FROM bar_brands WHERE id = ${id}`)).rejects.toThrow()
    expect((await bar.brandUsage(id)).orderedOn).toBe(1)
  }, 120_000)
})

d('locked means locked (rule 6)', () => {
  it('refuses to change the bar on a locked booking', async () => {
    const { id } = await bar.createBrand(auditor, { name: 'Chivas', pricePerBottlePaise: 400_000 })
    const { eventId, subEventId } = await makeSubEvent()
    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 1 })
    const [line] = await bar.getSubEventBar(subEventId)

    await db.execute(sql`UPDATE events SET status = 'locked' WHERE id = ${eventId}`)

    await expect(bar.setBarLine(bm, subEventId, { brandId: id, bottles: 9 })).rejects.toMatchObject({ status: 409 })
    await expect(bar.removeBarLine(bm, line!.id)).rejects.toMatchObject({ status: 409 })
    // The DB trigger backs the service guard, so a direct write is refused too. Drizzle wraps
    // the driver error, so the trigger's own message is down the cause chain.
    const err = await db
      .execute(sql`UPDATE sub_event_bar_items SET bottles = 9 WHERE id = ${line!.id}`)
      .then(() => null, (e: unknown) => e)
    expect(causeChain(err)).toMatch(/locked/i)
  }, 120_000)
})

d('audit trail (rule 5)', () => {
  it('records the brand and every order against the actor', async () => {
    // audit_log is append-only and survives cleanup, so this reads only what THIS test wrote.
    const from = await maxAuditSeq()
    const { id } = await bar.createBrand(auditor, { name: 'Bacardi', pricePerBottlePaise: 110_000 })
    const { subEventId } = await makeSubEvent()
    await bar.setBarLine(bm, subEventId, { brandId: id, bottles: 2 })
    const [line] = await bar.getSubEventBar(subEventId)
    await bar.removeBarLine(bm, line!.id)

    const rows = (await db.execute(sql`
      SELECT entity, action FROM audit_log
       WHERE entity IN ('bar_brands','sub_event_bar_items') AND seq > ${from}
       ORDER BY seq
    `)) as unknown as { entity: string; action: string }[]
    expect(rows.map((r) => `${r.entity}:${r.action}`)).toEqual([
      'bar_brands:insert',
      'sub_event_bar_items:insert',
      'sub_event_bar_items:delete',
    ])
  }, 120_000)
})
