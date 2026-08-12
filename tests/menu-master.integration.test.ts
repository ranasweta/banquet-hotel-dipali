/**
 * The menu master (module `menu_master`, built 21 Jul 2026).
 *
 * The rule this file exists to defend is BR-M1: **re-pricing the catalog must never
 * re-price a booked event.** Two mechanisms carry it — effective-dated `menu_tier_prices`
 * and the rate snapshot taken at save — and both are exercised here directly, because a
 * silent break would surface as a wrong number on a guest's bill and nowhere earlier.
 *
 * Everything else is the surrounding CRUD: tiers, their dated prices, the segments on them
 * and the dishes on those, plus the constraints that stop a nonsensical card being built.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const master = await import('@/lib/menu-master')
const menus = await import('@/lib/menus')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping menu-master tests\n')

const auditor = { id: '', roleName: 'auditor' }
const bm = { id: '', roleName: 'booking_manager' }

/** Test tiers are prefixed so cleanup can find them without touching the seeded card. */
const PREFIX = 'ZZTest'
let venueId = ''

async function userId(role: string): Promise<string> {
  const [u] = (await db.execute(sql`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ${role} LIMIT 1
  `)) as unknown as { id: string }[]
  return u!.id
}

/** A tier with one pick-2 segment and four dishes — enough to save a real menu against. */
async function makeTier(
  name: string,
  ratePaise: number,
  effectiveFrom = '2020-01-01',
): Promise<{ tierId: string; categoryId: string }> {
  const { id: tierId } = await master.createTier(auditor, {
    name: `${PREFIX} ${name}`,
    effectiveFrom,
    baseRatePaise: ratePaise,
  })
  const { id: categoryId } = await master.createCategory(auditor, tierId, {
    name: 'Starters',
    pickCount: 2,
    freeIncreaseEligible: false,
    sortOrder: 0,
  })
  for (const dish of ['Alpha Tikka', 'Beta Kebab', 'Gamma Roll', 'Delta Chaat']) {
    await master.createItem(auditor, categoryId, dish)
  }
  return { tierId, categoryId }
}

/** An enquiry with one sub-event on `date`; returns the sub-event id. */
async function makeSubEvent(date: string): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Master Test', eventType: 'engagement', createdBy: bm.id })
    .returning({ id: schema.events.id })
  const [se] = await db
    .insert(schema.subEvents)
    .values({ eventId: ev!.id, name: 'Function', eventDate: date, startTime: '19:00', endTime: '23:00', venueId, pax: 100 })
    .returning({ id: schema.subEvents.id })
  return se!.id
}

async function tierByName(name: string) {
  return (await master.getMasterCatalog()).find((t) => t.name === `${PREFIX} ${name}`)!
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
  await db.delete(schema.events) // cascades to sub-events and their menu snapshots
  // sub_event_menus references menu_tiers without cascade, so tiers go after events.
  await db.execute(sql`DELETE FROM menu_tiers WHERE name LIKE ${PREFIX + '%'}`)
  // The cascade tests write onto the SEEDED card (the ladder is Silver→Crown by name), so
  // their dishes — and the one segment they add to Silver — go by name rather than by tier.
  await db.execute(sql`DELETE FROM menu_items WHERE name LIKE 'Cascade %'`)
  await db.execute(sql`DELETE FROM menu_categories WHERE name LIKE ${PREFIX + '%'}`)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('BR-M1 — the catalog moves, booked events do not', () => {
  it('leaves a saved menu on its own rate when the tier is re-priced', async () => {
    const { tierId } = await makeTier('Snapshot', 50_000) // Rs 500
    const sub = await makeSubEvent('2027-03-01')
    await menus.saveSubEventMenu(bm, sub, { tierId, selections: { Starters: ['Alpha Tikka', 'Beta Kebab'] } })

    const before = await menus.getSubEventMenu(sub)
    expect(before.menu!.baseRatePaise).toBe(50_000)

    // The hotel re-prices from January, well before this event's date.
    await master.setTierPrice(auditor, tierId, {
      effectiveFrom: '2027-01-01',
      baseRatePaise: 90_000,
      weddingSurchargePaise: 5_000,
    })

    const after = await menus.getSubEventMenu(sub)
    expect(after.menu!.baseRatePaise).toBe(50_000) // untouched
    expect(after.menu!.perPlatePaise).toBe(50_000)
  }, 120_000)

  it('applies the new rate to the next menu saved, by the event\'s own date', async () => {
    const { tierId } = await makeTier('Dated', 50_000)
    await master.setTierPrice(auditor, tierId, {
      effectiveFrom: '2027-01-01',
      baseRatePaise: 90_000,
      weddingSurchargePaise: 5_000,
    })

    // A function AFTER the new rate's date takes the new rate…
    const later = await makeSubEvent('2027-03-01')
    await menus.saveSubEventMenu(bm, later, { tierId, selections: {} })
    expect((await menus.getSubEventMenu(later)).menu!.baseRatePaise).toBe(90_000)

    // …and one BEFORE it still takes the old one, even though it is saved today.
    const earlier = await makeSubEvent('2026-11-01')
    await menus.saveSubEventMenu(bm, earlier, { tierId, selections: {} })
    expect((await menus.getSubEventMenu(earlier)).menu!.baseRatePaise).toBe(50_000)
  }, 120_000)

  it('keeps the old price on record rather than overwriting it', async () => {
    const { tierId } = await makeTier('History', 50_000, '2025-06-01')
    await master.setTierPrice(auditor, tierId, { effectiveFrom: '2026-06-01', baseRatePaise: 70_000, weddingSurchargePaise: 5_000 })
    await master.setTierPrice(auditor, tierId, { effectiveFrom: '2027-06-01', baseRatePaise: 90_000, weddingSurchargePaise: 6_000 })

    const t = await tierByName('History')
    expect(t.prices.map((p) => p.effectiveFrom)).toEqual(['2027-06-01', '2026-06-01', '2025-06-01'])
    // Exactly one row is in force, and it is the newest not dated in the future.
    const current = t.prices.filter((p) => p.current)
    expect(current).toHaveLength(1)
    expect(current[0]!.effectiveFrom).toBe('2026-06-01')
    expect(current[0]!.baseRatePaise).toBe(70_000)
  }, 120_000)

  it('corrects a row when the same date is sent again', async () => {
    const { tierId } = await makeTier('Correction', 50_000, '2027-05-01')
    await master.setTierPrice(auditor, tierId, { effectiveFrom: '2027-05-01', baseRatePaise: 55_000, weddingSurchargePaise: 5_000 })
    const t = await tierByName('Correction')
    expect(t.prices).toHaveLength(1) // corrected, not duplicated
    expect(t.prices[0]!.baseRatePaise).toBe(55_000)
  }, 120_000)

  it('reports what a re-price would touch, before it is made', async () => {
    const { tierId } = await makeTier('Impact', 50_000)
    const sub = await makeSubEvent('2027-03-01')
    await menus.saveSubEventMenu(bm, sub, { tierId, selections: {} })

    const impact = await master.priceChangeImpact(tierId, '2027-01-01')
    expect(impact.savedMenus).toBe(1)
    expect(impact.upcomingUnbilled).toBe(1) // the event is still an enquiry

    // Once it is billed it is nobody's concern — the bill is already struck.
    const [se] = await db.select({ eventId: schema.subEvents.eventId }).from(schema.subEvents).where(eq(schema.subEvents.id, sub)).limit(1)
    await db.update(schema.events).set({ status: 'billed' }).where(eq(schema.events.id, se!.eventId))
    const after = await master.priceChangeImpact(tierId, '2027-01-01')
    expect(after.savedMenus).toBe(1)
    expect(after.upcomingUnbilled).toBe(0)
  }, 120_000)

  it('does not rename a booked event\'s tier out from under it', async () => {
    const { tierId } = await makeTier('Rename', 50_000)
    const sub = await makeSubEvent('2027-03-01')
    await menus.saveSubEventMenu(bm, sub, { tierId, selections: {} })
    expect((await menus.getSubEventMenu(sub)).menu!.tierName).toBe(`${PREFIX} Rename`)

    await master.renameTier(auditor, tierId, `${PREFIX} Rename Deluxe`)

    // The snapshot carries its own tier_name, so the bill still says what was sold.
    expect((await menus.getSubEventMenu(sub)).menu!.tierName).toBe(`${PREFIX} Rename`)
  }, 120_000)
})

d('tiers', () => {
  it('creates a tier with its opening rate in one go', async () => {
    const { tierId } = await makeTier('Create', 65_000, '2026-01-01')
    const t = await tierByName('Create')
    expect(t.id).toBe(tierId)
    expect(t.prices).toHaveLength(1)
    expect(t.prices[0]!.baseRatePaise).toBe(65_000)
    expect(t.prices[0]!.weddingSurchargePaise).toBe(5_000) // the Rs 50 default
    // A tier without a rate cannot be booked at all, which is why the two are one step.
    expect(t.prices[0]!.current).toBe(true)
  }, 120_000)

  it('refuses a duplicate tier name', async () => {
    await makeTier('Dup', 50_000)
    await expect(
      master.createTier(auditor, { name: `${PREFIX} Dup`, effectiveFrom: '2026-01-01', baseRatePaise: 50_000 }),
    ).rejects.toMatchObject({ status: 409 })
  }, 120_000)

  it('refuses a zero or negative rate', async () => {
    await expect(
      master.createTier(auditor, { name: `${PREFIX} Free`, effectiveFrom: '2026-01-01', baseRatePaise: 0 }),
    ).rejects.toMatchObject({ status: 400 })
  }, 120_000)

  it('counts the menus saved against a tier', async () => {
    const { tierId } = await makeTier('Counted', 50_000)
    expect((await tierByName('Counted')).savedMenus).toBe(0)
    for (const date of ['2027-03-01', '2027-03-02']) {
      await menus.saveSubEventMenu(bm, await makeSubEvent(date), { tierId, selections: {} })
    }
    expect((await tierByName('Counted')).savedMenus).toBe(2)
  }, 120_000)
})

d('segments', () => {
  it('adds, edits and reorders a segment', async () => {
    const { tierId } = await makeTier('Segments', 50_000)
    const { id } = await master.createCategory(auditor, tierId, {
      name: 'Dessert', pickCount: 1, freeIncreaseEligible: true, sortOrder: 5,
    })
    let t = await tierByName('Segments')
    let dessert = t.categories.find((c) => c.id === id)!
    expect(dessert).toMatchObject({ name: 'Dessert', pickCount: 1, freeIncreaseEligible: true, sortOrder: 5 })

    await master.updateCategory(auditor, id, {
      name: 'Desserts', pickCount: 3, freeIncreaseEligible: false, sortOrder: 1,
    })
    t = await tierByName('Segments')
    dessert = t.categories.find((c) => c.id === id)!
    expect(dessert).toMatchObject({ name: 'Desserts', pickCount: 3, freeIncreaseEligible: false, sortOrder: 1 })
  }, 120_000)

  it('treats a blank pick count as "all included"', async () => {
    const { tierId } = await makeTier('AllIn', 50_000)
    const { id } = await master.createCategory(auditor, tierId, {
      name: 'Breads', pickCount: null, freeIncreaseEligible: false, sortOrder: 9,
    })
    const t = await tierByName('AllIn')
    expect(t.categories.find((c) => c.id === id)!.pickCount).toBeNull()
  }, 120_000)

  it('refuses an all-included segment that is also free-increase eligible', async () => {
    // Mirrors the DB CHECK: there is nothing to increase when everything is already on.
    const { tierId } = await makeTier('Contradiction', 50_000)
    await expect(
      master.createCategory(auditor, tierId, {
        name: 'Impossible', pickCount: null, freeIncreaseEligible: true, sortOrder: 0,
      }),
    ).rejects.toMatchObject({ status: 400 })
  }, 120_000)

  it('refuses a duplicate segment name within a tier', async () => {
    const { tierId } = await makeTier('DupSeg', 50_000)
    await expect(
      master.createCategory(auditor, tierId, { name: 'Starters', pickCount: 1, freeIncreaseEligible: false, sortOrder: 1 }),
    ).rejects.toMatchObject({ status: 409 })
  }, 120_000)

  it('deletes a segment and its dishes, leaving booked menus intact', async () => {
    const { tierId, categoryId } = await makeTier('DeleteSeg', 50_000)
    const sub = await makeSubEvent('2027-03-01')
    await menus.saveSubEventMenu(bm, sub, { tierId, selections: { Starters: ['Alpha Tikka', 'Beta Kebab'] } })

    await master.deleteCategory(auditor, categoryId)

    // The master is gone…
    expect((await tierByName('DeleteSeg')).categories).toHaveLength(0)
    const [{ n }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM menu_items WHERE category_id = ${categoryId}`,
    )) as unknown as { n: number }[]
    expect(n).toBe(0)

    // …and the booked menu still knows what it sold, because it snapshots by name.
    const snap = await menus.getSubEventMenu(sub)
    const starters = snap.menu!.categories.find((c) => c.categoryName === 'Starters')
    expect(starters?.selected).toEqual(expect.arrayContaining(['Alpha Tikka', 'Beta Kebab']))
  }, 120_000)
})

d('dishes', () => {
  it('adds a dish and refuses a duplicate on the same segment', async () => {
    const { categoryId } = await makeTier('Dishes', 50_000)
    await master.createItem(auditor, categoryId, 'Epsilon Fry')
    await expect(master.createItem(auditor, categoryId, 'Epsilon Fry')).rejects.toMatchObject({ status: 409 })
  }, 120_000)

  it('retires a dish from the picker without losing it', async () => {
    const { tierId, categoryId } = await makeTier('Retire', 50_000)
    const before = (await tierByName('Retire')).categories[0]!
    const alpha = before.items.find((i) => i.name === 'Alpha Tikka')!
    expect(alpha.isActive).toBe(true)

    await master.updateItem(auditor, alpha.id, { isActive: false })

    // Still on the master screen, struck through…
    const after = (await tierByName('Retire')).categories[0]!
    expect(after.items.find((i) => i.id === alpha.id)!.isActive).toBe(false)
    expect(after.items).toHaveLength(4)

    // …but gone from the picker, which only offers active dishes.
    const catalog = await menus.getTierCatalog()
    const picker = catalog.find((t) => t.id === tierId)!.categories.find((c) => c.id === categoryId)!
    expect(picker.items).not.toContain('Alpha Tikka')
    expect(picker.items).toHaveLength(3)

    // And it comes back.
    await master.updateItem(auditor, alpha.id, { isActive: true })
    const restored = await menus.getTierCatalog()
    expect(restored.find((t) => t.id === tierId)!.categories.find((c) => c.id === categoryId)!.items).toHaveLength(4)
  }, 120_000)

  it('carries a dish up the tier ladder, and only upwards', async () => {
    // The seeded card, not a ZZTest tier: the ladder is Silver→Crown by name.
    const catalog = await master.getMasterCatalog()
    const seg = (tier: string) => catalog.find((t) => t.name === tier)!.categories.find((c) => c.name === 'Dessert')!

    const r = await master.createItem(auditor, seg('Platinum').id, 'Cascade Kulfi')
    expect(r.cascadedTo).toEqual(['Diamond', 'Crown']) // ladder order
    expect(r.skippedTiers).toEqual([])

    const after = await master.getMasterCatalog()
    const dessert = (tier: string) =>
      after.find((t) => t.name === tier)!.categories.find((c) => c.name === 'Dessert')!.items.map((i) => i.name)
    for (const tier of ['Platinum', 'Diamond', 'Crown']) expect(dessert(tier)).toContain('Cascade Kulfi')
    // Cheaper cards are untouched — a Platinum dish is not a Silver one.
    for (const tier of ['Silver', 'Gold']) expect(dessert(tier)).not.toContain('Cascade Kulfi')
  }, 120_000)

  it('refuses a dish the segment already carries under another spelling', async () => {
    const { categoryId } = await makeTier('Spelling', 50_000)
    await master.createItem(auditor, categoryId, 'Ice Cream')
    // The UNIQUE index cannot see these two as one dish; menuItemKey can.
    await expect(master.createItem(auditor, categoryId, 'Ice-Cream')).rejects.toMatchObject({ status: 409 })
    // …and the message says which spelling is already there, or it reads as nonsense.
    await expect(master.createItem(auditor, categoryId, 'Ice-Cream')).rejects.toThrow(/spelled "Ice Cream"/)
  }, 120_000)

  it('does not cascade a second spelling onto a card that already has the dish', async () => {
    // The seeded card spells one dish several ways across tiers ("Jal Jeera" / "Jaljeera"),
    // so a cascade comparing raw strings would print it twice on the upper card.
    const catalog = await master.getMasterCatalog()
    const dessert = (tier: string) => catalog.find((t) => t.name === tier)!.categories.find((c) => c.name === 'Dessert')!

    await master.createItem(auditor, dessert('Crown').id, 'Cascade Ice-Cream')
    const r = await master.createItem(auditor, dessert('Silver').id, 'Cascade Ice Cream')

    expect(r.cascadedTo).toEqual(['Gold', 'Platinum', 'Diamond']) // Crown has it already
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM menu_items i
        JOIN menu_categories c ON c.id = i.category_id
       WHERE c.name = 'Dessert' AND i.name LIKE 'Cascade Ice%'
    `)) as unknown as { n: number }[]
    expect(n).toBe(5) // one per tier — not six, with Crown printing both spellings
  }, 120_000)

  it('adds the dish once — a tier that already has it is left alone', async () => {
    const catalog = await master.getMasterCatalog()
    const soup = (tier: string) => catalog.find((t) => t.name === tier)!.categories.find((c) => c.name === 'Soup')!

    // Crown gets it directly first, so the cascade from Silver meets a dish already there.
    await master.createItem(auditor, soup('Crown').id, 'Cascade Shorba')
    const r = await master.createItem(auditor, soup('Silver').id, 'Cascade Shorba')

    expect(r.cascadedTo).toEqual(['Gold', 'Platinum', 'Diamond']) // Crown had it — not re-added
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM menu_items i
        JOIN menu_categories c ON c.id = i.category_id
       WHERE i.name = 'Cascade Shorba' AND c.name = 'Soup'
    `)) as unknown as { n: number }[]
    expect(n).toBe(5) // one per tier, never two on the same card
  }, 120_000)

  // The hotel's card relabels three segments as it climbs. Aliasing carries the dish over
  // each boundary and onto the tier's OWN segment, whatever that card calls it — without
  // which a Silver salad would never reach Crown.
  it.each([
    ['Salad', 'Cascade Kachumber', ['Salad', 'Salad', 'Salad Bar', 'Salad Bar', 'Salad Bar']],
    ['Veg Appetizer', 'Cascade Tikki', ['Veg Appetizer', 'Veg Appetizer', 'Veg Appetizer', 'Veg Starters', 'Veg Starters']],
    ['Raita', 'Cascade Boondi', ['Raita', 'Raita', 'Raita', 'Raita', 'Raita Bar']],
  ])('carries a dish across the %s rename, onto each card by its own name', async (segment, dish, landsOn) => {
    const ladder = ['Silver', 'Gold', 'Platinum', 'Diamond', 'Crown']
    const before = await master.getMasterCatalog()
    const cat = before.find((t) => t.name === 'Silver')!.categories.find((c) => c.name === segment)!

    const r = await master.createItem(auditor, cat.id, dish)
    expect(r.cascadedTo).toEqual(['Gold', 'Platinum', 'Diamond', 'Crown'])
    expect(r.skippedTiers).toEqual([])

    // On every card, and in the segment that card actually prints.
    const after = await master.getMasterCatalog()
    for (const [i, tier] of ladder.entries()) {
      const seg = after.find((t) => t.name === tier)!.categories.find((c) => c.name === landsOn[i])!
      expect(seg.items.map((x) => x.name)).toContain(dish)
    }
    // …and not duplicated into the other half of the pair on a card carrying only one.
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM menu_items WHERE name = ${dish}
    `)) as unknown as { n: number }[]
    expect(n).toBe(5)
  }, 120_000)

  it('names a tier it genuinely could not reach instead of skipping it silently', async () => {
    // A segment with no counterpart anywhere above — the one case aliasing cannot rescue.
    const silver = (await master.getMasterCatalog()).find((t) => t.name === 'Silver')!
    const { id } = await master.createCategory(auditor, silver.id, {
      name: `${PREFIX} Amuse Bouche`,
      pickCount: 1,
      freeIncreaseEligible: false,
      sortOrder: 99,
    })
    const r = await master.createItem(auditor, id, 'Cascade Canape')
    expect(r.cascadedTo).toEqual([])
    expect(r.skippedTiers).toEqual(['Gold', 'Platinum', 'Diamond', 'Crown'])
  }, 120_000)

  it('leaves a tier that is off the ladder cascading nowhere', async () => {
    // A meal-time card is a different card, not a richer one — and "Breakfast Gold" is above
    // nothing. Same for any tier created later, which is why the ZZTest tiers above still pass.
    const catalog = await master.getMasterCatalog()
    const bf = catalog.find((t) => t.name === 'Breakfast Gold')!
    const r = await master.createItem(auditor, bf.categories[0]!.id, 'Cascade Paratha')
    expect(r).toMatchObject({ cascadedTo: [], skippedTiers: [] })

    const crown = (await master.getMasterCatalog()).find((t) => t.name === 'Crown')!
    expect(crown.categories.flatMap((c) => c.items.map((i) => i.name))).not.toContain('Cascade Paratha')
  }, 120_000)

  it('audits every card the dish landed on, not just the one it was typed into', async () => {
    const catalog = await master.getMasterCatalog()
    const cat = catalog.find((t) => t.name === 'Gold')!.categories.find((c) => c.name === 'Rice')!
    await master.createItem(auditor, cat.id, 'Cascade Pulao')

    const rows = (await db.execute(sql`
      SELECT new_value AS "newValue" FROM audit_log
       WHERE entity = 'menu_items' AND action = 'insert' AND new_value LIKE '%Cascade Pulao%'
       ORDER BY seq
    `)) as unknown as { newValue: string }[]
    expect(rows).toHaveLength(4) // the one typed in, plus the three it was carried onto
    expect(rows[0]!.newValue).toBe('Rice · Cascade Pulao')
    expect(rows.slice(1).map((r) => r.newValue)).toEqual([
      'Platinum · Rice · Cascade Pulao (cascaded from Gold)',
      'Diamond · Rice · Cascade Pulao (cascaded from Gold)',
      'Crown · Rice · Cascade Pulao (cascaded from Gold)',
    ])
  }, 120_000)

  it('renames a dish', async () => {
    const { categoryId } = await makeTier('RenameDish', 50_000)
    const cat = (await tierByName('RenameDish')).categories[0]!
    const gamma = cat.items.find((i) => i.name === 'Gamma Roll')!
    await master.updateItem(auditor, gamma.id, { name: 'Gamma Spring Roll' })
    const after = (await tierByName('RenameDish')).categories.find((c) => c.id === categoryId)!
    expect(after.items.map((i) => i.name)).toContain('Gamma Spring Roll')
    expect(after.items.map((i) => i.name)).not.toContain('Gamma Roll')
  }, 120_000)
})

d('audit trail (rule 5)', () => {
  it('records every catalog write against the actor', async () => {
    const { tierId, categoryId } = await makeTier('Audited', 50_000)
    await master.setTierPrice(auditor, tierId, { effectiveFrom: '2027-01-01', baseRatePaise: 60_000, weddingSurchargePaise: 5_000 })
    await master.renameTier(auditor, tierId, `${PREFIX} Audited II`)
    const cat = (await tierByName('Audited II')).categories[0]!
    await master.updateCategory(auditor, cat.id, { name: 'Starters', pickCount: 3, freeIncreaseEligible: false, sortOrder: 0 })
    await master.createItem(auditor, categoryId, 'Zeta Skewer')

    const rows = (await db.execute(sql`
      SELECT entity, action FROM audit_log
       WHERE user_id = ${auditor.id}
         AND entity IN ('menu_tiers','menu_tier_prices','menu_categories','menu_items')
       ORDER BY seq DESC LIMIT 20
    `)) as unknown as { entity: string; action: string }[]

    // Master data has no event_id, so these are the master-data rows the audit was built to
    // carry (audit_log.event_id is nullable precisely for this).
    expect(rows.map((r) => r.entity)).toEqual(
      expect.arrayContaining(['menu_tiers', 'menu_tier_prices', 'menu_categories', 'menu_items']),
    )
  }, 120_000)
})
