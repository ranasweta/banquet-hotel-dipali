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

d('increases (BR-M2 free, BR-M3 exception)', () => {
  it('applies one free increase on an eligible category, bumping its effective pick', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: { Soup: ['Hot & Sour Soup'] } })
    const res = await menus.increaseCategory(actor, sub, 'Soup')
    expect(res).toMatchObject({ applied: 'free', effectivePick: 2 })

    const snap = await menus.getSubEventMenu(sub)
    expect(snap.menu!.freeIncreaseUsed).toBe(true)
    expect(snap.menu!.freeIncreaseCategoryName).toBe('Soup')
    const soup = snap.menu!.categories.find((c) => c.categoryName === 'Soup')!
    expect(soup.effectivePick).toBe(2)
  })

  it('raises a deferred exception on the SECOND increase (202)', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: { Soup: ['Hot & Sour Soup'], Salad: ['Green Salad'] } })
    await menus.increaseCategory(actor, sub, 'Soup') // free
    const second = await menus.increaseCategory(actor, sub, 'Salad') // eligible but free already used
    expect(second.applied).toBe('exception')

    // A pending menu_increase exception exists, and the category pick is NOT yet bumped.
    const eid = await eventIdOf(sub)
    const [exc] = await db.select().from(schema.exceptions).where(eq(schema.exceptions.eventId, eid))
    expect(exc!.kind).toBe('menu_increase')
    expect(exc!.status).toBe('pending')
    const snap = await menus.getSubEventMenu(sub)
    const salad = snap.menu!.categories.find((c) => c.categoryName === 'Salad')!
    expect(salad.effectivePick).toBe(3) // unchanged until approved
    expect(salad.exceptionPending).toBe(true)
  })

  it('raises an exception for an ineligible category even as the first increase', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: { 'Paneer Main Course': ['Kadai Paneer'] } })
    const res = await menus.increaseCategory(actor, sub, 'Paneer Main Course')
    expect(res.applied).toBe('exception')
    // The one free increase is still available (it was not consumed by the exception path).
    const snap = await menus.getSubEventMenu(sub)
    expect(snap.menu!.freeIncreaseUsed).toBe(false)
  })

  it('will not raise a duplicate exception while one is already pending', async () => {
    const sub = await makeSubEvent()
    await menus.saveSubEventMenu(actor, sub, { tierId: await tierId('Silver'), selections: { Dal: ['Dal Tadka'] } })
    await menus.increaseCategory(actor, sub, 'Dal') // exception (ineligible)
    await expect(menus.increaseCategory(actor, sub, 'Dal')).rejects.toThrow(/already awaiting approval/)
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
