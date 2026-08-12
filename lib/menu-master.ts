import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { assertPaise } from '@/lib/money'
import { TIER_LADDER, segmentAliases } from '@/lib/menu-ladder'
import { menuItemKey } from '@/lib/menu-name'

/**
 * Menu master — the catalog itself, not any one event's copy of it (module `menu_master`).
 *
 * The Auditor keeps the hotel's printed menu current here: tiers, their per-plate prices,
 * the segments inside each tier and the dishes inside those. It is the module the
 * permission matrix has always carried and nothing ever implemented.
 *
 * **A price change never touches a booked event.** Two things guarantee that, and neither
 * is optional:
 *
 *  1. `menu_tier_prices` is effective-DATED, keyed `(tier_id, effective_from)`. A new price
 *     is a new row, never an edit to the old one — so what a menu cost last March is still
 *     on record, and last March's bill can still be explained.
 *  2. Saving a menu snapshots the rate onto the sub-event (BR-M1), and reads it effective on
 *     the SUB-EVENT'S DATE. So a rate dated 1 Apr prices April's weddings and leaves March's
 *     alone, without anybody having to time the edit.
 *
 * Dishes are retired with `is_active`, not deleted: snapshots copy dishes by NAME, so a
 * delete would not corrupt a booked menu — but it would erase the dish from the pooled Swap
 * list that other tiers draw on, and there is no undo. Segments CAN be deleted, because an
 * empty segment on a printed card is a mistake rather than history.
 */


const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// ── Read ─────────────────────────────────────────────────────────────────────

export type MasterItem = { id: string; name: string; isActive: boolean }
export type MasterCategory = {
  id: string
  name: string
  /** NULL = every dish is included and there is nothing to pick. */
  pickCount: number | null
  freeIncreaseEligible: boolean
  sortOrder: number
  items: MasterItem[]
}
export type MasterPrice = {
  effectiveFrom: string
  baseRatePaise: number
  weddingSurchargePaise: number
  /** The row currently in force — what a menu saved today would snapshot. */
  current: boolean
}
export type MasterTier = {
  id: string
  name: string
  prices: MasterPrice[]
  categories: MasterCategory[]
  /** Menus already saved against this tier. Their snapshots are unaffected by edits here. */
  savedMenus: number
}

/**
 * Every tier with its full price history and its segments. Includes INACTIVE dishes, unlike
 * the picker's catalog — this is the screen where you turn one back on.
 */
export async function getMasterCatalog(): Promise<MasterTier[]> {
  const [tiers, prices, cats, items] = await Promise.all([
    db.execute(sql`
      SELECT t.id, t.name,
             (SELECT count(*)::int FROM sub_event_menus m WHERE m.tier_id = t.id) AS "savedMenus"
      FROM menu_tiers t ORDER BY t.name
    `) as unknown as Promise<{ id: string; name: string; savedMenus: number }[]>,
    db.execute(sql`
      SELECT tier_id AS "tierId", effective_from::text AS "effectiveFrom",
             base_rate_paise AS "baseRatePaise", wedding_surcharge_paise AS "weddingSurchargePaise",
             -- The row in force today: the newest one not dated in the future.
             effective_from = (
               SELECT max(p2.effective_from) FROM menu_tier_prices p2
               WHERE p2.tier_id = p.tier_id AND p2.effective_from <= CURRENT_DATE
             ) AS current
      FROM menu_tier_prices p ORDER BY tier_id, effective_from DESC
    `) as unknown as Promise<(MasterPrice & { tierId: string })[]>,
    db
      .select()
      .from(schema.menuCategories)
      .orderBy(asc(schema.menuCategories.tierId), asc(schema.menuCategories.sortOrder), asc(schema.menuCategories.name)),
    db.select().from(schema.menuItems).orderBy(asc(schema.menuItems.name)),
  ])

  const itemsByCat = new Map<string, MasterItem[]>()
  for (const i of items) {
    itemsByCat.set(i.categoryId, [
      ...(itemsByCat.get(i.categoryId) ?? []),
      { id: i.id, name: i.name, isActive: i.isActive },
    ])
  }
  const catsByTier = new Map<string, MasterCategory[]>()
  for (const c of cats) {
    catsByTier.set(c.tierId, [
      ...(catsByTier.get(c.tierId) ?? []),
      {
        id: c.id,
        name: c.name,
        pickCount: c.pickCount,
        freeIncreaseEligible: c.freeIncreaseEligible,
        sortOrder: c.sortOrder,
        items: itemsByCat.get(c.id) ?? [],
      },
    ])
  }
  const pricesByTier = new Map<string, MasterPrice[]>()
  for (const p of prices) {
    const { tierId, ...rest } = p
    pricesByTier.set(tierId, [...(pricesByTier.get(tierId) ?? []), { ...rest, baseRatePaise: Number(rest.baseRatePaise), weddingSurchargePaise: Number(rest.weddingSurchargePaise) }])
  }

  return tiers.map((t) => ({
    id: t.id,
    name: t.name,
    prices: pricesByTier.get(t.id) ?? [],
    categories: catsByTier.get(t.id) ?? [],
    savedMenus: t.savedMenus,
  }))
}

// ── Tiers ────────────────────────────────────────────────────────────────────

/** Postgres unique-violation, unwrapped from Drizzle's wrapper (see confirm.ts pgCode). */
function isUnique(err: unknown): boolean {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && (cur as { code: unknown }).code === '23505') return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

export async function createTier(
  actor: Actor,
  input: { name: string; effectiveFrom: string; baseRatePaise: number; weddingSurchargePaise?: number },
): Promise<{ id: string }> {
  const name = input.name.trim()
  if (!name) throw badRequest('A tier needs a name.')
  assertPaise(input.baseRatePaise)
  if (input.baseRatePaise <= 0) throw badRequest('The per-plate rate must be more than zero.')
  if (!ISO_DATE.test(input.effectiveFrom)) throw badRequest('Effective-from must be YYYY-MM-DD.')

  return db.transaction(async (tx) => {
    let tierId: string
    try {
      const [t] = await tx.insert(schema.menuTiers).values({ name }).returning({ id: schema.menuTiers.id })
      tierId = t!.id
    } catch (e) {
      if (isUnique(e)) throw conflict(`A tier called "${name}" already exists.`)
      throw e
    }
    // A tier with no price cannot be saved onto a sub-event (menus.ts refuses it), so the
    // opening rate is part of creating one rather than a second step to forget.
    await tx.insert(schema.menuTierPrices).values({
      tierId,
      effectiveFrom: input.effectiveFrom,
      baseRatePaise: input.baseRatePaise,
      weddingSurchargePaise: input.weddingSurchargePaise ?? 5000,
    })
    await audit(tx, actor, {
      entity: 'menu_tiers',
      entityId: tierId,
      action: 'insert',
      field: 'name',
      newValue: `${name} @ ${input.baseRatePaise} paise from ${input.effectiveFrom}`,
    })
    return { id: tierId }
  })
}

export async function renameTier(actor: Actor, tierId: string, name: string): Promise<void> {
  const next = name.trim()
  if (!next) throw badRequest('A tier needs a name.')
  await db.transaction(async (tx) => {
    const [t] = await tx.select().from(schema.menuTiers).where(eq(schema.menuTiers.id, tierId)).limit(1)
    if (!t) throw notFound('Tier not found')
    if (t.name === next) return
    try {
      await tx.update(schema.menuTiers).set({ name: next }).where(eq(schema.menuTiers.id, tierId))
    } catch (e) {
      if (isUnique(e)) throw conflict(`A tier called "${next}" already exists.`)
      throw e
    }
    // Renaming does NOT touch saved menus: they carry their own `tier_name` snapshot, so an
    // event booked as "Silver" stays "Silver" on its bill however the catalog is relabelled.
    await audit(tx, actor, {
      entity: 'menu_tiers', entityId: tierId, action: 'update', field: 'name',
      oldValue: t.name, newValue: next,
    })
  })
}

/**
 * Records a per-plate rate for a tier, effective from a date.
 *
 * Never an edit in place unless you are correcting a row dated today or later — re-pricing
 * the past would change what an already-billed event was charged and leave the audit trail
 * saying something different from the invoice.
 */
export async function setTierPrice(
  actor: Actor,
  tierId: string,
  input: { effectiveFrom: string; baseRatePaise: number; weddingSurchargePaise: number },
): Promise<void> {
  assertPaise(input.baseRatePaise)
  assertPaise(input.weddingSurchargePaise)
  if (input.baseRatePaise <= 0) throw badRequest('The per-plate rate must be more than zero.')
  if (input.weddingSurchargePaise < 0) throw badRequest('The wedding surcharge cannot be negative.')
  if (!ISO_DATE.test(input.effectiveFrom)) throw badRequest('Effective-from must be YYYY-MM-DD.')

  await db.transaction(async (tx) => {
    const [tier] = await tx.select().from(schema.menuTiers).where(eq(schema.menuTiers.id, tierId)).limit(1)
    if (!tier) throw notFound('Tier not found')

    const [existing] = await tx
      .select()
      .from(schema.menuTierPrices)
      .where(and(eq(schema.menuTierPrices.tierId, tierId), eq(schema.menuTierPrices.effectiveFrom, input.effectiveFrom)))
      .limit(1)

    await tx
      .insert(schema.menuTierPrices)
      .values({
        tierId,
        effectiveFrom: input.effectiveFrom,
        baseRatePaise: input.baseRatePaise,
        weddingSurchargePaise: input.weddingSurchargePaise,
      })
      .onConflictDoUpdate({
        target: [schema.menuTierPrices.tierId, schema.menuTierPrices.effectiveFrom],
        set: { baseRatePaise: input.baseRatePaise, weddingSurchargePaise: input.weddingSurchargePaise },
      })

    await audit(tx, actor, {
      entity: 'menu_tier_prices', entityId: tierId, action: existing ? 'update' : 'insert',
      field: `rate from ${input.effectiveFrom}`,
      oldValue: existing ? String(existing.baseRatePaise) : null,
      newValue: String(input.baseRatePaise),
    })
  })
}

// ── Categories (the segments on the printed card) ────────────────────────────

export type CategoryInput = {
  name: string
  /** NULL means every dish is included — the picker renders it read-only. */
  pickCount: number | null
  freeIncreaseEligible: boolean
  sortOrder: number
}

function validateCategory(input: CategoryInput): void {
  if (!input.name.trim()) throw badRequest('A segment needs a name.')
  if (input.pickCount != null && input.pickCount < 1) {
    throw badRequest('Pick count must be at least 1, or blank for "all included".')
  }
  // Mirrors the DB CHECK. Caught here so the message names the actual problem.
  if (input.pickCount == null && input.freeIncreaseEligible) {
    throw badRequest('An all-included segment has nothing to increase, so it cannot be free-increase eligible.')
  }
}

export async function createCategory(actor: Actor, tierId: string, input: CategoryInput): Promise<{ id: string }> {
  validateCategory(input)
  return db.transaction(async (tx) => {
    const [tier] = await tx.select().from(schema.menuTiers).where(eq(schema.menuTiers.id, tierId)).limit(1)
    if (!tier) throw notFound('Tier not found')
    try {
      const [c] = await tx
        .insert(schema.menuCategories)
        .values({ tierId, name: input.name.trim(), pickCount: input.pickCount, freeIncreaseEligible: input.freeIncreaseEligible, sortOrder: input.sortOrder })
        .returning({ id: schema.menuCategories.id })
      await audit(tx, actor, {
        entity: 'menu_categories', entityId: c!.id, action: 'insert', field: 'name',
        newValue: `${tier.name} · ${input.name.trim()} (pick ${input.pickCount ?? 'all'})`,
      })
      return { id: c!.id }
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${input.name.trim()}" is already a segment of ${tier.name}.`)
      throw e
    }
  })
}

export async function updateCategory(actor: Actor, categoryId: string, input: CategoryInput): Promise<void> {
  validateCategory(input)
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(schema.menuCategories).where(eq(schema.menuCategories.id, categoryId)).limit(1)
    if (!c) throw notFound('Segment not found')
    try {
      await tx
        .update(schema.menuCategories)
        .set({ name: input.name.trim(), pickCount: input.pickCount, freeIncreaseEligible: input.freeIncreaseEligible, sortOrder: input.sortOrder })
        .where(eq(schema.menuCategories.id, categoryId))
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${input.name.trim()}" is already a segment of this tier.`)
      throw e
    }
    // Saved menus keep the pick-count they were saved with — `sub_event_menu_categories`
    // holds its own `base_pick`. Changing it here governs menus saved from now on.
    await audit(tx, actor, {
      entity: 'menu_categories', entityId: categoryId, action: 'update', field: 'segment',
      oldValue: `${c.name} (pick ${c.pickCount ?? 'all'})`,
      newValue: `${input.name.trim()} (pick ${input.pickCount ?? 'all'})`,
    })
  })
}

export async function deleteCategory(actor: Actor, categoryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(schema.menuCategories).where(eq(schema.menuCategories.id, categoryId)).limit(1)
    if (!c) throw notFound('Segment not found')
    // Cascades to its dishes. Booked menus are untouched — they snapshot by name — but the
    // dishes leave the pooled Swap list, so the audit row records what went.
    const [{ n }] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM menu_items WHERE category_id = ${categoryId}
    `)) as unknown as { n: number }[]
    await tx.delete(schema.menuCategories).where(eq(schema.menuCategories.id, categoryId))
    await audit(tx, actor, {
      entity: 'menu_categories', entityId: categoryId, action: 'delete', field: 'segment',
      oldValue: `${c.name} (${n} dish(es))`,
    })
  })
}

// ── Items (the dishes) ───────────────────────────────────────────────────────

export type CreatedItem = {
  id: string
  /** Tiers above this one that the dish was copied onto, cheapest first. */
  cascadedTo: string[]
  /** Tiers above this one carrying no segment of this name or its aliases — left alone. */
  skippedTiers: string[]
}

/**
 * Adds a dish, and carries it up the ladder — a richer card contains the poorer ones, so a
 * paneer put on Silver must appear on Gold through Crown too, without four more trips through
 * the form (client, 12 Aug 2026). The ladder and the segment aliases live in
 * `lib/menu-ladder.ts`, which the picker's Swap pool reads as well.
 *
 * Two things the caller must tell the user about, because both are silent otherwise:
 *
 *  - **Segments are matched by name, plus the aliases in `segmentAliases`.** Every segment
 *    on the seeded card now reaches Crown, so `skippedTiers` should come back empty in
 *    practice; a tier lands in it only when somebody has built a segment that genuinely has
 *    no counterpart above. Still reported rather than swallowed — that is the one case where
 *    a dish quietly fails to reach a card.
 *  - **A dish already on a card is left exactly as it is** — added once, as asked — including
 *    one that was RETIRED there. Retiring is a per-tier decision somebody made on purpose; a
 *    cascade from below is not the place to undo it.
 *
 * "Already there" is judged by `menuItemKey`, not by string equality, and that is the whole
 * point rather than a refinement. The hotel spells one dish several ways across its cards —
 * "Ice Cream" / "Ice-Cream", "Jal Jeera" / "Jaljeera", "Pani Puri" / "Panipuri" — so a
 * cascade comparing raw strings puts a second spelling of the same dish on 36 of the seeded
 * card's segments, and the guest is offered it twice in one Swap list. The pooled menu
 * already collapses those (`dedupeMenuNames`); the cascade has to agree with it or it
 * manufactures exactly the duplicates that pooling exists to remove.
 */
export async function createItem(actor: Actor, categoryId: string, name: string): Promise<CreatedItem> {
  const clean = name.trim()
  if (!clean) throw badRequest('A dish needs a name.')
  const key = menuItemKey(clean)
  return db.transaction(async (tx) => {
    const [cat] = await tx.select().from(schema.menuCategories).where(eq(schema.menuCategories.id, categoryId)).limit(1)
    if (!cat) throw notFound('Segment not found')
    const [tier] = await tx.select().from(schema.menuTiers).where(eq(schema.menuTiers.id, cat.tierId)).limit(1)
    if (!tier) throw notFound('Tier not found')

    // The same dish under another spelling is still the same dish. The UNIQUE index cannot see
    // that, so it is caught here — and named, because "already on the list" is baffling when
    // the list visibly does not contain what you just typed.
    const onSegment = await tx
      .select({ name: schema.menuItems.name })
      .from(schema.menuItems)
      .where(eq(schema.menuItems.categoryId, categoryId))
    const clash = onSegment.find((i) => menuItemKey(i.name) === key)
    if (clash) {
      throw conflict(
        clash.name === clean
          ? `"${clean}" is already on the ${cat.name} list.`
          : `"${clean}" is already on the ${cat.name} list, spelled "${clash.name}".`,
      )
    }

    let id: string
    try {
      const [i] = await tx
        .insert(schema.menuItems)
        .values({ categoryId, name: clean })
        .returning({ id: schema.menuItems.id })
      id = i!.id
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${clean}" is already on the ${cat.name} list.`)
      throw e
    }
    await audit(tx, actor, {
      entity: 'menu_items', entityId: id, action: 'insert', field: 'name',
      newValue: `${cat.name} · ${clean}`,
    })

    // -1 for a tier off the ladder — Breakfast Gold, High Tea Silver, anything newly created.
    // Guarded before the slice, because slice(-1 + 1) is slice(0), which would cascade a high
    // tea dish onto every banquet card. Crown, at the top, lands on the same early return.
    const rung = (TIER_LADDER as readonly string[]).indexOf(tier.name)
    const above: string[] = rung === -1 ? [] : TIER_LADDER.slice(rung + 1)
    if (above.length === 0) return { id, cascadedTo: [], skippedTiers: [] }

    // LEFT join: a tier carrying no segment of this name — nor any alias of it — still comes
    // back, with a null category, so it can be reported as skipped instead of vanishing.
    const targets = await tx
      .select({
        tierName: schema.menuTiers.name,
        categoryId: schema.menuCategories.id,
        categoryName: schema.menuCategories.name,
      })
      .from(schema.menuTiers)
      .leftJoin(
        schema.menuCategories,
        and(
          eq(schema.menuCategories.tierId, schema.menuTiers.id),
          inArray(schema.menuCategories.name, segmentAliases(cat.name)),
        ),
      )
      .where(inArray(schema.menuTiers.name, above))

    // One target per tier: the dish belongs in ONE segment of a card, not two. The join can
    // return two rows for a tier only if it carries both names of an alias pair; there the
    // source tier's own spelling wins. (A tier with no match yields a single null row, never
    // a null row alongside a real one, so that is the only tie there is to break.)
    const byTier = new Map<string, (typeof targets)[number]>()
    for (const t of targets) {
      if (!byTier.has(t.tierName) || t.categoryName === cat.name) byTier.set(t.tierName, t)
    }

    // What those segments already carry, so a dish can be recognised under whatever spelling
    // that card happens to use for it.
    const targetCatIds = [...byTier.values()].map((t) => t.categoryId).filter((c): c is string => c !== null)
    const alreadyOn = new Map<string, Set<string>>()
    if (targetCatIds.length > 0) {
      const rows = await tx
        .select({ categoryId: schema.menuItems.categoryId, name: schema.menuItems.name })
        .from(schema.menuItems)
        .where(inArray(schema.menuItems.categoryId, targetCatIds))
      for (const r of rows) {
        const set = alreadyOn.get(r.categoryId) ?? new Set<string>()
        set.add(menuItemKey(r.name))
        alreadyOn.set(r.categoryId, set)
      }
    }

    const cascadedTo: string[] = []
    const skippedTiers: string[] = []
    // Ladder order, so the message reads "Gold, Platinum, Crown" rather than however the
    // planner happened to return them.
    for (const t of [...byTier.values()].sort((a, b) => above.indexOf(a.tierName) - above.indexOf(b.tierName))) {
      if (!t.categoryId) {
        skippedTiers.push(t.tierName)
        continue
      }
      // Already on that card, under this spelling or another — leave it be. This is what
      // "added once" means, and it keeps a second "Ice-Cream" off a card printing "Ice Cream".
      if (alreadyOn.get(t.categoryId)?.has(key)) continue
      const [copy] = await tx
        .insert(schema.menuItems)
        .values({ categoryId: t.categoryId, name: clean })
        // Belt and braces on the exact name: the key check above cannot see a concurrent
        // insert, and the cascade must stay safe to re-run.
        .onConflictDoNothing({ target: [schema.menuItems.categoryId, schema.menuItems.name] })
        .returning({ id: schema.menuItems.id })
      if (!copy) continue
      cascadedTo.push(t.tierName)
      await audit(tx, actor, {
        entity: 'menu_items', entityId: copy.id, action: 'insert', field: 'name',
        // The target's own segment name, not the source's — the audit should say the dish
        // landed on Crown's "Raita Bar", which is where somebody would go looking for it.
        newValue: `${t.tierName} · ${t.categoryName} · ${clean} (cascaded from ${tier.name})`,
      })
    }
    return { id, cascadedTo, skippedTiers }
  })
}

/** Renames a dish, retires it, or brings it back. */
export async function updateItem(
  actor: Actor,
  itemId: string,
  patch: { name?: string; isActive?: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [i] = await tx.select().from(schema.menuItems).where(eq(schema.menuItems.id, itemId)).limit(1)
    if (!i) throw notFound('Dish not found')

    const name = patch.name?.trim() ?? i.name
    if (!name) throw badRequest('A dish needs a name.')
    const isActive = patch.isActive ?? i.isActive
    if (name === i.name && isActive === i.isActive) return

    try {
      await tx.update(schema.menuItems).set({ name, isActive }).where(eq(schema.menuItems.id, itemId))
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${name}" is already on this list.`)
      throw e
    }
    await audit(tx, actor, {
      entity: 'menu_items', entityId: itemId, action: 'update', field: 'dish',
      oldValue: `${i.name}${i.isActive ? '' : ' (retired)'}`,
      newValue: `${name}${isActive ? '' : ' (retired)'}`,
    })
  })
}

/**
 * What a price change would affect, before it is made.
 *
 * The honest answer is usually "nothing already saved" — snapshots see to that — but a
 * manager re-opening a menu on an UNSAVED future event will pick up the new rate, and the
 * screen should say so out loud rather than let it be discovered on a bill.
 */
export async function priceChangeImpact(
  tierId: string,
  effectiveFrom: string,
): Promise<{ savedMenus: number; upcomingUnbilled: number }> {
  const [row] = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM sub_event_menus WHERE tier_id = ${tierId}) AS "savedMenus",
      (SELECT count(*)::int
         FROM sub_event_menus m
         JOIN sub_events se ON se.id = m.sub_event_id
         JOIN events e ON e.id = se.event_id
        WHERE m.tier_id = ${tierId}
          AND se.event_date >= ${effectiveFrom}::date
          AND e.status NOT IN ('locked','billed','closed','cancelled')) AS "upcomingUnbilled"
  `)) as unknown as { savedMenus: number; upcomingUnbilled: number }[]
  return row ?? { savedMenus: 0, upcomingUnbilled: 0 }
}
