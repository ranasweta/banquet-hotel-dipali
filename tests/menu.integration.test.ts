/**
 * M4 acceptance (the menu module, FR-3.x, BR-M1..M5):
 *
 *   - a master price change AFTER a save does not alter the saved snapshot (BR-M1);
 *   - a second increase attempt raises an Exception (202), while the first free one on an
 *     eligible category applies immediately (BR-M2/BR-M3);
 *   - the wedding surcharge is applied only for weddings (BR-M5).
 *
 * Plus the surrounding rules: incomplete saves allowed, over-pick rejected, all-included
 * categories auto-filled, ineligible-category increase → exception, add-ons in the
 * proposal, and the locked-event guard. Drives the lib/menus service against the test DB.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const menus = await import('@/lib/menus')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping menu tests\n')

const actor = { id: '', roleName: 'booking_manager' }

async function tierId(name: string): Promise<string> {
  const [t] = await db.select({ id: schema.menuTiers.id }).from(schema.menuTiers).where(eq(schema.menuTiers.name, name)).limit(1)
  return t!.id
}
async function venueId(name: string): Promise<string> {
  const [v] = await db.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.name, name)).limit(1)
  return v!.id
}

/** A bare enquiry with one sub-event; returns the sub-event id (all we need for menus). */
async function makeSubEvent(opts: { eventType?: string; pax?: number; date?: string } = {}): Promise<string> {
  const { eventType = 'engagement', pax = 300, date = '2026-09-01' } = opts
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [event] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Menu Test', eventType, createdBy: actor.id })
    .returning({ id: schema.events.id })
  const [sub] = await db
    .insert(schema.subEvents)
    .values({ eventId: event!.id, name: 'Function', eventDate: date, startTime: '19:00', endTime: '23:00', venueId: await venueId('Crystal'), pax })
    .returning({ id: schema.subEvents.id })
  return sub!.id
}

async function eventIdOf(subEventId: string): Promise<string> {
  const [se] = await db.select({ eventId: schema.subEvents.eventId }).from(schema.subEvents).where(eq(schema.subEvents.id, subEventId)).limit(1)
  return se!.eventId
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
  const [bm] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, 'booking_manager'))
    .limit(1)
  actor.id = bm!.id
}, 90_000)

// venue_bookings reference events with NO ACTION, so clear them first; deleting the
// events then cascades to sub-events, menus, categories, selections, add-ons and
// exceptions (semc's exception link is ON DELETE SET NULL, so no ordering hazard).
async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => {
  if (!hasDb) return
  await cleanup()
})
afterAll(async () => {
  if (!hasDb) return
  await cleanup()
})

d('save + snapshot (BR-M1)', () => {
  it('snapshots tier price and picks; a later master price change does not alter it', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: { Soup: ['Hot & Sour Soup'] } })

    const before = await menus.getSubEventMenu(sub)
    expect(before.menu!.baseRatePaise).toBe(65000)
    expect(before.menu!.perPlatePaise).toBe(65000)

    // Bump the master price, then re-read: the snapshot must be unchanged.
    const silver = await tierId('Silver')
    const [orig] = await db.select({ rate: schema.menuTierPrices.baseRatePaise }).from(schema.menuTierPrices).where(eq(schema.menuTierPrices.tierId, silver)).limit(1)
    try {
      await db.update(schema.menuTierPrices).set({ baseRatePaise: 99_999 }).where(eq(schema.menuTierPrices.tierId, silver))
      const after = await menus.getSubEventMenu(sub)
      expect(after.menu!.baseRatePaise).toBe(65000)
    } finally {
      await db.update(schema.menuTierPrices).set({ baseRatePaise: orig!.rate }).where(eq(schema.menuTierPrices.tierId, silver))
    }
  })

  it('allows an incomplete save and reports completion per category', async () => {
    const sub = await makeSubEvent()
    const res = await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: { Soup: ['Hot & Sour Soup'] } })
    expect(res.isComplete).toBe(false)

    const snap = await menus.getSubEventMenu(sub)
    const soup = snap.menu!.categories.find((c) => c.categoryName === 'Soup')!
    expect(soup.complete).toBe(true) // 1 of 1
    const dessert = snap.menu!.categories.find((c) => c.categoryName === 'Dessert')!
    expect(dessert.complete).toBe(false) // 0 of 2
  })

  it('auto-fills all-included categories and forbids increasing them', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: {} })
    const snap = await menus.getSubEventMenu(sub)
    const bread = snap.menu!.categories.find((c) => c.categoryName === 'Assorted Indian Bread')!
    expect(bread.effectivePick).toBeNull()
    // The whole list is copied in — compare against the master rather than a magic number,
    // which would drift every time a combined "A / B" line is split into separate dishes.
    const silverBread = (await menus.getTierCatalog())
      .find((t) => t.name === 'Silver')!
      .categories.find((c) => c.name === 'Assorted Indian Bread')!
    expect(bread.selected).toHaveLength(silverBread.items.length)
    expect(bread.complete).toBe(true)
    await expect(menus.increaseCategory(actor, sub, 'Assorted Indian Bread')).rejects.toThrow(/already included/)
  })

  it('rejects selecting more than the pick count', async () => {
    const sub = await makeSubEvent()
    await expect(
      menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: { Soup: ['Hot & Sour Soup', 'Cream of Tomato'] } }),
    ).rejects.toThrow(/at most 1 in Soup/)
  })
})

d('wedding surcharge (BR-M5)', () => {
  it('adds Rs. 50/plate for weddings and nothing for other event types', async () => {
    const nonWed = await makeSubEvent({ eventType: 'engagement' })
    await menus.saveSubEventMenu(actor, nonWed, { tierId: await tierId('Silver'), selections: {} })
    const a = await menus.getSubEventMenu(nonWed)
    expect(a.menu!.surchargePaise).toBe(0)
    expect(a.menu!.perPlatePaise).toBe(65000)

    const wed = await makeSubEvent({ eventType: 'wedding' })
    await menus.saveSubEventMenu(actor, wed, { tierId: await tierId('Silver'), selections: {} })
    const b = await menus.getSubEventMenu(wed)
    expect(b.menu!.surchargePaise).toBe(5000)
    expect(b.menu!.perPlatePaise).toBe(70000) // Silver 650 → 700
  })
})

d('increases — unlock, colour, and the per-function list (21 Jul 2026)', () => {
  const silver = async () => tierId('Silver')

  it('refuses picks beyond the base count until Increase is pressed', async () => {
    const sub = await makeSubEvent()
    await expect(
      menus.saveSubEventMenu(actor, sub, {
        tierId: await silver(),
        selections: { Soup: ['Hot & Sour Soup', 'Sweet Corn Soup'] }, // base is 1
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('unlocks a segment for unlimited picking, and marks the overflow as extra', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await silver(), selections: { Soup: ['Hot & Sour Soup'] } })

    const res = await menus.increaseCategory(actor, sub, 'Soup')
    expect(res).toMatchObject({ categoryName: 'Soup', basePick: 1, freeRemaining: 2 })

    // Four soups on a base of one: three extras, and no ceiling refused them.
    await menus.saveSubEventMenu(actor, sub, {
      tierId: await silver(),
      selections: { Soup: ['Hot & Sour Soup', 'Sweet Corn Soup', 'Cream of Tomato', 'Veg Manchow Soup'] },
    })

    const [row] = (await db.execute(sql`
      SELECT c.extra_picks AS "extra", c.increase_unlocked AS "unlocked",
             count(*) FILTER (WHERE s.is_extra)::int AS "flagged"
        FROM sub_event_menu_categories c
        JOIN sub_event_menus m ON m.id = c.menu_id
        LEFT JOIN sub_event_menu_selections s
          ON s.menu_id = c.menu_id AND s.category_name = c.category_name
       WHERE m.sub_event_id = ${sub} AND c.category_name = 'Soup'
       GROUP BY 1, 2
    `)) as unknown as { extra: number; unlocked: boolean; flagged: number }[]
    // The count and the flags agree — the picker colours exactly what the GM will see.
    expect(row).toEqual({ extra: 3, unlocked: true, flagged: 3 })
  })

  it('keeps the first two extras of a FUNCTION free, across segments', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, {
      tierId: await silver(),
      selections: { Soup: ['Hot & Sour Soup'], Salad: ['Green Salad', 'Russian Salad', 'Kachumber Salad'] },
    })
    await menus.increaseCategory(actor, sub, 'Soup')
    await menus.increaseCategory(actor, sub, 'Salad')

    // One extra soup, one extra salad — two in the function, both free.
    await menus.saveSubEventMenu(actor, sub, {
      tierId: await silver(),
      selections: {
        Soup: ['Hot & Sour Soup', 'Sweet Corn Soup'],
        Salad: ['Green Salad', 'Russian Salad', 'Kachumber Salad', 'Pasta Salad'],
      },
    })

    const summary = (await menus.getIncreaseSummary(sub))!
    expect(summary.totalExtras).toBe(2)
    expect(summary.freeCovered).toBe(2)
    expect(summary.awaitingSubmission).toBe(0)

    // Nothing to send while the guest is inside the allowance.
    const sent = await menus.submitIncreases(actor, sub)
    expect(sent).toEqual({ exceptionId: null, submitted: 0 })
  }, 120_000)

  it('sends only what is beyond the free two, itemised by dish', async () => {
    const sub = await makeSubEvent()
    const eid = await eventIdOf(sub)
    await menus.saveSubEventMenu(actor, sub, { tierId: await silver(), selections: { Soup: ['Hot & Sour Soup'] } })
    await menus.increaseCategory(actor, sub, 'Soup')
    await menus.saveSubEventMenu(actor, sub, {
      tierId: await silver(),
      selections: { Soup: ['Hot & Sour Soup', 'Sweet Corn Soup', 'Cream of Tomato', 'Veg Manchow Soup'] },
    })

    const summary = (await menus.getIncreaseSummary(sub))!
    expect(summary.totalExtras).toBe(3)
    expect(summary.awaitingSubmission).toBe(1) // 3 extras − 2 free

    const { exceptionId, submitted } = await menus.submitIncreases(actor, sub)
    expect(submitted).toBe(1)

    const [exc] = await db.select().from(schema.exceptions).where(eq(schema.exceptions.id, exceptionId!))
    const payload = exc!.payload as { subEventName: string; items: { categoryName: string; requesting: number; dishes: string[] }[] }
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]!.categoryName).toBe('Soup')
    expect(payload.items[0]!.requesting).toBe(1)
    // The GM decides on a dish, not on a number.
    expect(payload.items[0]!.dishes).toHaveLength(1)

    // It is one request per function, and pressing again sends nothing new.
    const again = await menus.submitIncreases(actor, sub)
    expect(again.submitted).toBe(0)
    const all = await db.select().from(schema.exceptions).where(eq(schema.exceptions.eventId, eid))
    expect(all.filter((e) => e.kind === 'menu_increase')).toHaveLength(1)
  }, 120_000)

  it('does not un-approve sanctioned picks when the menu is next saved', async () => {
    // The picker autosaves, so a snapshot rewrite used to wipe approved_extra_picks and
    // re-ask the Authority for a decision it had already made.
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await silver(), selections: { Soup: ['Hot & Sour Soup'] } })
    await menus.increaseCategory(actor, sub, 'Soup')
    await menus.saveSubEventMenu(actor, sub, {
      tierId: await silver(),
      selections: { Soup: ['Hot & Sour Soup', 'Sweet Corn Soup', 'Cream of Tomato', 'Veg Manchow Soup'] },
    })
    await menus.submitIncreases(actor, sub)

    const read = async () => {
      const [r] = (await db.execute(sql`
        SELECT c.submitted_extra_picks AS "submitted"
          FROM sub_event_menu_categories c
          JOIN sub_event_menus m ON m.id = c.menu_id
         WHERE m.sub_event_id = ${sub} AND c.category_name = 'Soup'
      `)) as unknown as { submitted: number }[]
      return r!.submitted
    }
    expect(await read()).toBe(1)

    // An unrelated autosave must not disturb it.
    await menus.saveSubEventMenu(actor, sub, {
      tierId: await silver(),
      selections: { Soup: ['Hot & Sour Soup', 'Sweet Corn Soup', 'Cream of Tomato', 'Veg Manchow Soup'] },
    })
    expect(await read()).toBe(1)
  }, 120_000)

  it('hands the allowance back when an extra is removed', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await silver(), selections: { Soup: ['Hot & Sour Soup'] } })
    await menus.increaseCategory(actor, sub, 'Soup')
    await menus.saveSubEventMenu(actor, sub, {
      tierId: await silver(),
      selections: { Soup: ['Hot & Sour Soup', 'Sweet Corn Soup', 'Cream of Tomato', 'Veg Manchow Soup'] },
    })
    await menus.submitIncreases(actor, sub)

    // The guest drops back to one extra: inside the free two, nothing outstanding.
    await menus.saveSubEventMenu(actor, sub, {
      tierId: await silver(),
      selections: { Soup: ['Hot & Sour Soup', 'Sweet Corn Soup'] },
    })
    const summary = (await menus.getIncreaseSummary(sub))!
    expect(summary.totalExtras).toBe(1)
    expect(summary.awaitingSubmission).toBe(0)
  }, 120_000)

  it('still refuses to increase an all-included segment', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await silver(), selections: {} })
    const allIncluded = (await menus.getSubEventMenu(sub)).menu!.categories.find((c) => c.basePick == null)
    if (allIncluded) {
      await expect(
        menus.increaseCategory(actor, sub, allIncluded.categoryName),
      ).rejects.toMatchObject({ status: 400 })
    }
  })
})

d('add-ons (FR-3.6) and the running proposal', () => {
  it('adds and removes add-ons, moving the proposal total', async () => {
    const sub = await makeSubEvent()
    const eid = await eventIdOf(sub)
    await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: {} })

    const readTotal = async () => {
      const [e] = await db.select({ t: schema.events.proposalTotalPaise }).from(schema.events).where(eq(schema.events.id, eid))
      return e!.t
    }
    const beforeAddon = await readTotal()
    const { id } = await menus.addAddon(actor, sub, { description: 'Paan counter', ratePaise: 10_000, qty: 2 })
    expect(await readTotal()).toBe(beforeAddon + 20_000)

    await menus.deleteAddon(actor, id)
    expect(await readTotal()).toBe(beforeAddon)
  })
})

d('locked-event guard (rule 6)', () => {
  it('refuses a menu save once the event is locked (clean 409)', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: {} })
    const eid = await eventIdOf(sub)
    await db.update(schema.events).set({ status: 'locked' }).where(eq(schema.events.id, eid))
    try {
      await expect(
        menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: { Soup: ['Hot & Sour Soup'] } }),
      ).rejects.toMatchObject({ status: 409 })
    } finally {
      await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, eid))
    }
  })

  it('the DB trigger backs the guard even on a raw add-on insert', async () => {
    const sub = await makeSubEvent()
    const eid = await eventIdOf(sub)
    await db.update(schema.events).set({ status: 'locked' }).where(eq(schema.events.id, eid))
    try {
      // Drizzle wraps the pg error; the trigger's "…is locked…" text is on the cause.
      let msg = ''
      try {
        await db.insert(schema.subEventAddons).values({ subEventId: sub, description: 'x', ratePaise: 1, qty: 1 })
      } catch (e) {
        msg = String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error).message)
      }
      expect(msg).toMatch(/locked/)
    } finally {
      await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, eid))
    }
  })
})

d('swap from the pooled master menu', () => {
  it('accepts an item from another tier in the same sub-heading, and still caps the picks', async () => {
    const sub = await makeSubEvent()
    const silver = await tierId('Silver')

    // A Dessert that exists on some tier's list but NOT on Silver's — the swap case.
    const [outsider] = (await db.execute(sql`
      SELECT i.name FROM menu_items i
      JOIN menu_categories c ON c.id = i.category_id
      WHERE i.is_active AND c.name = 'Dessert'
        AND i.name NOT IN (
          SELECT i2.name FROM menu_items i2
          JOIN menu_categories c2 ON c2.id = i2.category_id
          WHERE c2.tier_id = ${silver} AND c2.name = 'Dessert' AND i2.is_active
        )
      LIMIT 1
    `)) as unknown as { name: string }[]
    expect(outsider, 'expected a Dessert on another tier only').toBeTruthy()

    // Swapping it in is allowed — it just spends a Dessert pick.
    await menus.saveSubEventMenu(actor, sub, { tierId: silver, selections: { Dessert: [outsider!.name] } })
    const saved = await menus.getSubEventMenu(sub)
    const dessert = saved.menu!.categories.find((c) => c.categoryName === 'Dessert')!
    expect(dessert.selected).toContain(outsider!.name)

    // The pick count still caps it: base pick + 1 more than allowed is refused.
    const cap = dessert.effectivePick ?? 1
    const pool = (await db.execute(sql`
      SELECT DISTINCT i.name FROM menu_items i
      JOIN menu_categories c ON c.id = i.category_id
      WHERE i.is_active AND c.name = 'Dessert' LIMIT ${cap + 1}
    `)) as unknown as { name: string }[]
    await expect(
      menus.saveSubEventMenu(actor, sub, { tierId: silver, selections: { Dessert: pool.map((p) => p.name) } }),
    ).rejects.toThrow(/at most/i)

    // A name that is on no Dessert list anywhere is still refused.
    await expect(
      menus.saveSubEventMenu(actor, sub, { tierId: silver, selections: { Dessert: ['Definitely Not A Dessert'] } }),
    ).rejects.toThrow(/not on any/i)
  })

  it('pools across a sub-heading the card renames higher up', async () => {
    // Silver prints "Salad"; Platinum up prints "Salad Bar". Same course, so Swap has to
    // offer the whole of it — otherwise a Crown salad cannot go on a Silver plate even
    // though both cards are the same hotel's.
    const sub = await makeSubEvent()
    const silver = await tierId('Silver')

    const [outsider] = (await db.execute(sql`
      SELECT i.name FROM menu_items i
      JOIN menu_categories c ON c.id = i.category_id
      WHERE i.is_active AND c.name = 'Salad Bar'
        AND i.name NOT IN (
          SELECT i2.name FROM menu_items i2
          JOIN menu_categories c2 ON c2.id = i2.category_id
          WHERE c2.name = 'Salad' AND i2.is_active
        )
      LIMIT 1
    `)) as unknown as { name: string }[]
    expect(outsider, 'expected a Salad Bar dish absent from every Salad list').toBeTruthy()

    // Offered under the name Silver prints, which is the one its picker asks for…
    const pools = await menus.getMasterMenuPools()
    const salad = pools.find((p) => p.categoryName === 'Salad')!.items
    expect(salad).toContain(outsider!.name)
    // …and both spellings key the same pool, so neither side is the privileged one. (Only
    // Salad, pick-3, ever consults it: Salad Bar is all-included from Platinum up and its
    // picker is read-only.)
    expect(new Set(pools.find((p) => p.categoryName === 'Salad Bar')!.items)).toEqual(new Set(salad))

    // And it saves, rather than being offered and then refused.
    await menus.saveSubEventMenu(actor, sub, { tierId: silver, selections: { Salad: [outsider!.name] } })
    const saved = await menus.getSubEventMenu(sub)
    expect(saved.menu!.categories.find((c) => c.categoryName === 'Salad')!.selected).toContain(outsider!.name)
  })

  it('leaves an unaliased sub-heading pooling only its own name', async () => {
    // The merge is the three renamed courses, not "everything is one list".
    const pools = await menus.getMasterMenuPools()
    const soup = pools.find((p) => p.categoryName === 'Soup')!.items
    const dessert = pools.find((p) => p.categoryName === 'Dessert')!.items
    expect(soup.some((s) => dessert.includes(s))).toBe(false)
  })
})

d('per-item preference notes', () => {
  it('saves a free-text note per dish, returns it, and never changes the price', async () => {
    const sub = await makeSubEvent()
    const silver = await tierId('Silver')

    const before = await menus.saveSubEventMenu(actor, sub, {
      tierId: silver,
      selections: { Soup: ['Hot & Sour Soup'] },
    })
    const priceBefore = (await menus.getSubEventMenu(sub)).menu!.perPlatePaise

    await menus.saveSubEventMenu(actor, sub, {
      tierId: silver,
      selections: { Soup: ['Hot & Sour Soup'] },
      notes: { Soup: { 'Hot & Sour Soup': 'extra spicy, no cornflour' } },
    })

    const snap = await menus.getSubEventMenu(sub)
    const soup = snap.menu!.categories.find((c) => c.categoryName === 'Soup')!
    expect(soup.notes['Hot & Sour Soup']).toBe('extra spicy, no cornflour')
    // A preference is a kitchen instruction, not a charge.
    expect(snap.menu!.perPlatePaise).toBe(priceBefore)
    expect(before.menuId).toBeTruthy()

    // Clearing the note removes it.
    await menus.saveSubEventMenu(actor, sub, {
      tierId: silver,
      selections: { Soup: ['Hot & Sour Soup'] },
      notes: { Soup: { 'Hot & Sour Soup': '   ' } },
    })
    const cleared = await menus.getSubEventMenu(sub)
    expect(cleared.menu!.categories.find((c) => c.categoryName === 'Soup')!.notes).toEqual({})
  })
})
