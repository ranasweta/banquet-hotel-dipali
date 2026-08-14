/**
 * Extra plates and the Utensil Manager (client, 15 Aug 2026) — `lib/utensils.ts`, migration 0035.
 *
 * The charge with no paperwork behind it: no booking, no rate card, no guest signature, only a
 * number somebody counted at the pass. So the things worth pinning down are the ones that stop
 * it becoming a licence to invent money:
 *
 *   - THE PHOTO IS THE ENTRY. No photo, no row — not a row with a warning on it.
 *   - THE RATE IS THE FUNCTION'S OWN, composed exactly as a booked plate's is, and frozen at
 *     entry. A Sangeet plate must not be charged at the Reception's rate.
 *   - NOTHING COUNTS UNTIL HE CLOSES, and even then only in the settlement — never in the 25%
 *     advance, which fell due months before anybody counted a plate.
 *   - THE ROLE EXISTS AND CAN REACH EXACTLY ONE THING, and the people who check the photo are
 *     the ones who can see it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const utensils = await import('@/lib/utensils')
const schedule = await import('@/lib/payment-schedule')
const invoice = await import('@/lib/invoice')
const proposal = await import('@/lib/proposal')
const lock = await import('@/lib/lock')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping utensils tests\n')

const auditor = { id: '', roleName: 'auditor' }
const ut = { id: '', roleName: 'utensil_manager' }

async function userId(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}

const SILVER = 65_000 // Rs 650/plate, the seeded Silver tier
const SURCHARGE = 5_000 // Rs 50, the wedding surcharge (BR-M5)

/**
 * A wedding in progress with TWO functions on different tiers, which is the whole reason an
 * entry names a function: the two plates must not cost the same.
 */
async function makeWedding(status = 'in_progress'): Promise<{ eventId: string; sangeet: string; reception: string }> {
  const [{ code }] = (await db.execute(
    sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
  )) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({
      code, guestName: 'Plates Test', eventType: 'wedding', status: status as 'in_progress',
      proposalTotalPaise: 10_000_000, createdBy: auditor.id,
    })
    .returning({ id: schema.events.id })
  const [venue] = await db.select({ id: schema.venues.id }).from(schema.venues).limit(1)

  const subs = await db
    .insert(schema.subEvents)
    .values([
      { eventId: e!.id, name: 'Sangeet', eventDate: '2026-10-01', startTime: '18:00', endTime: '23:00', venueId: venue!.id, pax: 100, venueRatePaise: 5_000_000 },
      { eventId: e!.id, name: 'Reception', eventDate: '2026-10-02', startTime: '18:00', endTime: '23:00', venueId: venue!.id, pax: 200, venueRatePaise: 5_000_000 },
    ])
    .returning({ id: schema.subEvents.id, name: schema.subEvents.name })
  const sangeet = subs.find((s) => s.name === 'Sangeet')!.id
  const reception = subs.find((s) => s.name === 'Reception')!.id

  // Menu snapshots: Silver on the Sangeet, Silver + Rs 100 on the Reception, so the two rates
  // differ by a known amount. The rates here are the SNAPSHOT's, deliberately independent of
  // whatever the tier costs in the master — that is what a snapshot is for.
  const tierId = async (name: string) => {
    const [t] = await db.select({ id: schema.menuTiers.id }).from(schema.menuTiers).where(eq(schema.menuTiers.name, name)).limit(1)
    return t!.id
  }
  await db.insert(schema.subEventMenus).values([
    { subEventId: sangeet, tierId: await tierId('Silver'), tierName: 'Silver', baseRatePaise: SILVER, surchargePaise: SURCHARGE },
    { subEventId: reception, tierId: await tierId('Gold'), tierName: 'Gold', baseRatePaise: SILVER + 10_000, surchargePaise: SURCHARGE },
  ])
  return { eventId: e!.id, sangeet, reception }
}

/** Every entry needs a photo; the tests do not care what is in it, only that it is stored. */
async function photoKey(): Promise<string> {
  const { storeEncrypted } = await import('@/lib/storage')
  const { fileKey } = await storeEncrypted(Buffer.from('fake-jpeg-bytes'), { contentType: 'image/jpeg' })
  return fileKey
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
  ut.id = await userId('utensil_manager')
}, 90_000)

async function cleanup() {
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('the Utensil Manager', () => {
  it('exists, is seeded as a user, and can reach utensils and nothing else', async () => {
    expect(ut.id).toBeTruthy()

    const [u] = (await db.execute(sql`
      SELECT u.login_id AS "loginId", r.name AS role FROM users u
      JOIN roles r ON r.id = u.role_id WHERE lower(u.login_id) = 'banq.ut'
    `)) as unknown as { loginId: string; role: string }[]
    expect(u?.role).toBe('utensil_manager')

    const perms = (await db.execute(sql`
      SELECT p.module_code AS module, p.action::text AS action
      FROM role_permissions p JOIN roles r ON r.id = p.role_id
      WHERE r.name = 'utensil_manager' ORDER BY p.module_code, p.action
    `)) as unknown as { module: string; action: string }[]
    // Exactly the one module — no bookings, no billing, no calendar.
    expect([...new Set(perms.map((p) => p.module))]).toEqual(['utensils'])
    expect(perms.map((p) => p.action).sort()).toEqual(['create_edit', 'view'])
  })

  it('lets the Authority and the Auditor see the photo, and gives nobody else the module', async () => {
    const rows = (await db.execute(sql`
      SELECT r.name AS role, p.action::text AS action
      FROM role_permissions p JOIN roles r ON r.id = p.role_id
      WHERE p.module_code = 'utensils' AND p.action = 'view'
      ORDER BY r.name
    `)) as unknown as { role: string; action: string }[]
    expect(rows.map((r) => r.role)).toEqual(['auditor', 'higher_authority', 'utensil_manager'])
  })
})

d('logging plates', () => {
  it('prices at the function’s own per-plate rate, and freezes it', async () => {
    const { sangeet, reception } = await makeWedding()

    const a = await utensils.addPlates(ut, { subEventId: sangeet, plates: 100, fileKey: await photoKey() })
    const b = await utensils.addPlates(ut, { subEventId: reception, plates: 100, fileKey: await photoKey() })
    // The point of naming a function: the same 100 plates cost different money.
    expect(a.amountPaise).toBe(100 * (SILVER + SURCHARGE))
    expect(b.amountPaise).toBe(100 * (SILVER + 10_000 + SURCHARGE))
    expect(b.amountPaise).toBeGreaterThan(a.amountPaise)

    // Re-pricing the snapshot afterwards moves nothing already served.
    await db.execute(sql`UPDATE sub_event_menus SET base_rate_paise = base_rate_paise * 2`)
    const view = await utensils.getUtensilExtras(a.eventId)
    expect(view.entries.find((e) => e.functionName === 'Sangeet')!.ratePaise).toBe(SILVER + SURCHARGE)
  })

  it('refuses a function with no saved menu rather than pricing it at zero', async () => {
    const { eventId } = await makeWedding()
    const [venue] = await db.select({ id: schema.venues.id }).from(schema.venues).limit(1)
    const [bare] = await db
      .insert(schema.subEvents)
      .values({ eventId, name: 'Haldi', eventDate: '2026-09-30', startTime: '10:00', endTime: '13:00', venueId: venue!.id, pax: 50 })
      .returning({ id: schema.subEvents.id })

    await expect(
      utensils.addPlates(ut, { subEventId: bare!.id, plates: 10, fileKey: await photoKey() }),
    ).rejects.toThrow(/no saved menu/i)

    // And the panel offers it as unpriced rather than hiding it, so the screen can say why.
    const view = await utensils.getUtensilExtras(eventId)
    expect(view.functions.find((f) => f.name === 'Haldi')!.ratePaise).toBeNull()
  })

  it('cannot be written without a photo', async () => {
    const { sangeet } = await makeWedding()
    await expect(utensils.addPlates(ut, { subEventId: sangeet, plates: 10, fileKey: '' })).rejects.toThrow(/photo/i)

    // And the column agrees, so no other code path can slip one past either.
    const [col] = (await db.execute(sql`
      SELECT is_nullable AS "isNullable" FROM information_schema.columns
      WHERE table_name = 'extra_plate_entries' AND column_name = 'file_key'
    `)) as unknown as { isNullable: string }[]
    expect(col!.isNullable).toBe('NO')
  })

  it('refuses before the event starts and after the log is closed', async () => {
    const confirmed = await makeWedding('confirmed')
    await expect(
      utensils.addPlates(ut, { subEventId: confirmed.sangeet, plates: 10, fileKey: await photoKey() }),
    ).rejects.toThrow(/In Progress or Completed/i)

    const live = await makeWedding()
    await utensils.addPlates(ut, { subEventId: live.sangeet, plates: 10, fileKey: await photoKey() })
    await utensils.closeUtensilExtras(ut, live.eventId)
    await expect(
      utensils.addPlates(ut, { subEventId: live.sangeet, plates: 10, fileKey: await photoKey() }),
    ).rejects.toThrow(/closed/i)
  })
})

d('the close', () => {
  it('is what puts plates on the payable, the bill and the proposal — and never on the advance', async () => {
    const { eventId, reception } = await makeWedding()
    const { amountPaise } = await utensils.addPlates(ut, {
      subEventId: reception, plates: 100, fileKey: await photoKey(), remarks: 'guests over count',
    })

    const before = await schedule.payableBreakdown(eventId)
    expect(before.extraPlatesPaise).toBe(0)
    expect((await invoice.computeBillLines(db, eventId)).some((l) => l.description.startsWith('Extra plates'))).toBe(false)

    await utensils.closeUtensilExtras(ut, eventId)

    const after = await schedule.payableBreakdown(eventId)
    expect(after.extraPlatesPaise).toBe(amountPaise)
    // Counted in the settlement, and in neither threshold that fell due before the night.
    expect(after.preEventPayablePaise).toBe(before.preEventPayablePaise)
    expect(after.payablePaise).toBe(before.payablePaise + amountPaise)

    // Food, so 18% shown and collected from nobody — and tagged to the function it was served at.
    const line = (await invoice.computeBillLines(db, eventId)).find((l) => l.description.startsWith('Extra plates'))!
    expect(line.section).toBe('food')
    expect(line.gstRateBp).toBe(1800)
    expect(line.amountPaise).toBe(amountPaise)
    expect(line.functionLabel).toBe('Reception')

    const doc = await proposal.proposalDocument(eventId)
    expect(doc.extras.some((x) => x.description.includes('Extra plates'))).toBe(true)
    expect(doc.totals.totalPaise).toBe(after.payablePaise)
  })

  it('is a lock-checklist item, green when there is nothing to close', async () => {
    const quiet = await makeWedding()
    const item = (c: { items: { key: string; done: boolean; blocking: boolean }[] }) =>
      c.items.find((i) => i.key === 'utensils')!
    expect(item(await lock.lockChecklist(quiet.eventId)).done).toBe(true)
    expect(item(await lock.lockChecklist(quiet.eventId)).blocking).toBe(false)

    const busy = await makeWedding()
    await utensils.addPlates(ut, { subEventId: busy.sangeet, plates: 5, fileKey: await photoKey() })
    expect(item(await lock.lockChecklist(busy.eventId)).done).toBe(false)
    await utensils.closeUtensilExtras(ut, busy.eventId)
    expect(item(await lock.lockChecklist(busy.eventId)).done).toBe(true)
  })
})
