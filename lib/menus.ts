import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { recomputeProposalTotal } from '@/lib/pricing'

/**
 * Menu module service layer (M4, FR-3.x, BR-M1..M5).
 *
 *  - The picker reads the tier catalog (masters) and the sub-event's saved snapshot.
 *  - Saving copies the tier's price, pick-counts and chosen items ONTO the sub-event
 *    (BR-M1): later master edits never touch a saved menu. Weddings carry a per-plate
 *    surcharge (BR-M5). An incomplete menu is allowed (FR-3.2) — completion is a
 *    lock-checklist item, not a save gate.
 *  - One free +1 is allowed on exactly one eligible category per sub-event (BR-M2);
 *    any further increase, or any increase on an ineligible category, raises an
 *    Exception that stays deferred until an Authority approves it (BR-M3).
 *  - Menus stay tentative and every save is written to the audit trail (FR-1.12).
 *
 * Menus have no event_id of their own; a DB trigger backs the lock guard, and the
 * service layer blocks first with a clean 409 (CLAUDE.md rule 6).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])
const FREE_INCREASE_MAX = 1 // BR-M2: one free increase per sub-event, whole menu

function assertEditable(status: string): void {
  if (LOCKED_STATES.has(status)) {
    throw conflict('This event is locked — its menus can no longer be changed.')
  }
}

// ── Catalog (masters) ────────────────────────────────────────────────────────

export type CatalogCategory = {
  id: string
  name: string
  pickCount: number | null
  freeIncreaseEligible: boolean
  items: string[]
}
export type CatalogTier = {
  id: string
  name: string
  /** Per-plate base rate (currently effective). The wedding surcharge is applied server-side
   *  on save and deliberately not shown to the guest — see BR-M5. */
  baseRatePaise: number
  categories: CatalogCategory[]
}

/** Every tier → its categories (in card order) → its active item names. Drives the picker. */
export async function getTierCatalog(): Promise<CatalogTier[]> {
  const tiers = (await db.execute(sql`
    SELECT t.id, t.name,
           COALESCE((SELECT p.base_rate_paise FROM menu_tier_prices p
                     WHERE p.tier_id = t.id AND p.effective_from <= CURRENT_DATE
                     ORDER BY p.effective_from DESC LIMIT 1), 0) AS "baseRatePaise"
    FROM menu_tiers t
    ORDER BY "baseRatePaise", t.name
  `)) as unknown as { id: string; name: string; baseRatePaise: number }[]

  const cats = await db
    .select({
      id: schema.menuCategories.id,
      tierId: schema.menuCategories.tierId,
      name: schema.menuCategories.name,
      pickCount: schema.menuCategories.pickCount,
      freeIncreaseEligible: schema.menuCategories.freeIncreaseEligible,
      sortOrder: schema.menuCategories.sortOrder,
    })
    .from(schema.menuCategories)
    .orderBy(asc(schema.menuCategories.tierId), asc(schema.menuCategories.sortOrder))

  const items = await db
    .select({ categoryId: schema.menuItems.categoryId, name: schema.menuItems.name })
    .from(schema.menuItems)
    .where(eq(schema.menuItems.isActive, true))
    .orderBy(asc(schema.menuItems.name))

  const itemsByCat = new Map<string, string[]>()
  for (const it of items) {
    const list = itemsByCat.get(it.categoryId) ?? []
    list.push(it.name)
    itemsByCat.set(it.categoryId, list)
  }
  const catsByTier = new Map<string, CatalogCategory[]>()
  for (const c of cats) {
    const list = catsByTier.get(c.tierId) ?? []
    list.push({
      id: c.id,
      name: c.name,
      pickCount: c.pickCount,
      freeIncreaseEligible: c.freeIncreaseEligible,
      items: itemsByCat.get(c.id) ?? [],
    })
    catsByTier.set(c.tierId, list)
  }
  return tiers.map((t) => ({
    id: t.id,
    name: t.name,
    baseRatePaise: Number(t.baseRatePaise),
    categories: catsByTier.get(t.id) ?? [],
  }))
}

export type MenuPool = { categoryName: string; items: string[] }

/**
 * The pooled "master menu": every active item across every tier, grouped by sub-heading.
 * Drives Swap — picking from here spends one of that sub-heading's picks (see saveSubEventMenu).
 */
export async function getMasterMenuPools(): Promise<MenuPool[]> {
  const rows = await db
    .select({ categoryName: schema.menuCategories.name, itemName: schema.menuItems.name })
    .from(schema.menuItems)
    .innerJoin(schema.menuCategories, eq(schema.menuCategories.id, schema.menuItems.categoryId))
    .where(eq(schema.menuItems.isActive, true))
    .orderBy(asc(schema.menuCategories.name), asc(schema.menuItems.name))

  const byCat = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = byCat.get(r.categoryName) ?? new Set<string>()
    set.add(r.itemName)
    byCat.set(r.categoryName, set)
  }
  return [...byCat.entries()].map(([categoryName, items]) => ({ categoryName, items: [...items] }))
}

// ── Sub-event context + snapshot ─────────────────────────────────────────────

type SubEventContext = {
  id: string
  name: string
  eventId: string
  eventType: string
  isWedding: boolean
  status: string
  pax: number
  eventDate: string
}

async function loadSubEventContext(exec: Tx | typeof db, subEventId: string): Promise<SubEventContext> {
  const [row] = (await exec.execute(sql`
    SELECT se.id, se.name, se.event_id AS "eventId", se.pax, se.event_date AS "eventDate",
           e.event_type AS "eventType", e.status, et.is_wedding AS "isWedding"
    FROM sub_events se
    JOIN events e ON e.id = se.event_id
    JOIN event_types et ON et.code = e.event_type
    WHERE se.id = ${subEventId}
  `)) as unknown as SubEventContext[]
  if (!row) throw notFound('Sub-event not found')
  return row
}

export type MenuCategorySnapshot = {
  categoryName: string
  basePick: number | null
  extraPicks: number
  effectivePick: number | null
  exceptionId: string | null
  exceptionPending: boolean
  exceptionStatus: string | null
  exceptionRemark: string | null
  selected: string[]
  /** itemName -> preference note ("dal spicy"). Free text, never priced. */
  notes: Record<string, string>
  complete: boolean
}
export type MenuSnapshot = {
  tierId: string
  tierName: string
  baseRatePaise: number
  surchargePaise: number
  perPlatePaise: number
  isComplete: boolean
  isTentative: boolean
  freeIncreaseCategoryName: string | null
  freeIncreaseUsed: boolean
  categories: MenuCategorySnapshot[]
  foodTotalPaise: number
}
export type Addon = { id: string; description: string; ratePaise: number; qty: number }
export type SubEventMenuResult = {
  subEvent: SubEventContext & { editable: boolean }
  menu: MenuSnapshot | null
  addons: Addon[]
}

/**
 * The sub-event's context, its saved menu snapshot (null if none saved yet), and its
 * add-ons. Add-ons are surfaced at the top level because they live outside the tier
 * (FR-3.6) and can exist before any menu is saved.
 */
export async function getSubEventMenu(subEventId: string): Promise<SubEventMenuResult> {
  const ctx = await loadSubEventContext(db, subEventId)
  const editable = !LOCKED_STATES.has(ctx.status)

  const addonRows = await db
    .select()
    .from(schema.subEventAddons)
    .where(eq(schema.subEventAddons.subEventId, subEventId))
  const addons: Addon[] = addonRows.map((a) => ({
    id: a.id,
    description: a.description,
    ratePaise: a.ratePaise,
    qty: a.qty,
  }))

  const [menu] = await db
    .select()
    .from(schema.subEventMenus)
    .where(eq(schema.subEventMenus.subEventId, subEventId))
    .limit(1)

  if (!menu) return { subEvent: { ...ctx, editable }, menu: null, addons }

  const [cats, sels, freeCat] = await Promise.all([
    db
      .select()
      .from(schema.subEventMenuCategories)
      .where(eq(schema.subEventMenuCategories.menuId, menu.id)),
    db
      .select()
      .from(schema.subEventMenuSelections)
      .where(eq(schema.subEventMenuSelections.menuId, menu.id)),
    menu.freeIncreaseCategory
      ? db
          .select({ name: schema.menuCategories.name })
          .from(schema.menuCategories)
          .where(eq(schema.menuCategories.id, menu.freeIncreaseCategory))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
  ])

  // Status + remark of each linked exception (drives the "awaiting approval" badge and,
  // once decided, surfaces the Authority's remark to the booking manager — FR-6.2).
  const excIds = cats.map((c) => c.exceptionId).filter((x): x is string => Boolean(x))
  const excById = new Map<string, { status: string; remark: string | null }>()
  if (excIds.length > 0) {
    const rows = await db
      .select({ id: schema.exceptions.id, status: schema.exceptions.status, remark: schema.exceptions.remark })
      .from(schema.exceptions)
      .where(
        sql`${schema.exceptions.id} IN (${sql.join(
          excIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      )
    for (const r of rows) excById.set(r.id, { status: r.status, remark: r.remark })
  }

  const selByCat = new Map<string, string[]>()
  const notesByCat = new Map<string, Record<string, string>>()
  for (const s of sels) {
    const list = selByCat.get(s.categoryName) ?? []
    list.push(s.itemName)
    selByCat.set(s.categoryName, list)
    if (s.note) {
      const notes = notesByCat.get(s.categoryName) ?? {}
      notes[s.itemName] = s.note
      notesByCat.set(s.categoryName, notes)
    }
  }

  const categories: MenuCategorySnapshot[] = cats.map((c) => {
    const selected = selByCat.get(c.categoryName) ?? []
    const effectivePick = c.basePick == null ? null : c.basePick + c.extraPicks
    const complete = effectivePick == null || selected.length >= effectivePick
    const exc = c.exceptionId ? excById.get(c.exceptionId) : undefined
    return {
      categoryName: c.categoryName,
      basePick: c.basePick,
      extraPicks: c.extraPicks,
      effectivePick,
      exceptionId: c.exceptionId,
      exceptionPending: exc?.status === 'pending',
      exceptionStatus: exc?.status ?? null,
      exceptionRemark: exc?.status === 'rejected' ? exc.remark : null,
      selected,
      notes: notesByCat.get(c.categoryName) ?? {},
      complete,
    }
  })

  const perPlate = menu.baseRatePaise + menu.surchargePaise
  return {
    subEvent: { ...ctx, editable },
    addons,
    menu: {
      tierId: menu.tierId,
      tierName: menu.tierName,
      baseRatePaise: menu.baseRatePaise,
      surchargePaise: menu.surchargePaise,
      perPlatePaise: perPlate,
      isComplete: menu.isComplete,
      isTentative: menu.isTentative,
      freeIncreaseCategoryName: freeCat[0]?.name ?? null,
      freeIncreaseUsed: menu.freeIncreaseCategory != null,
      categories,
      foodTotalPaise: perPlate * ctx.pax,
    },
  }
}

// ── Save (snapshot write) ────────────────────────────────────────────────────

export type MenuSaveInput = {
  tierId: string
  isTentative?: boolean
  /** categoryName -> chosen item names. Omit or [] for an untouched/incomplete category. */
  selections: Record<string, string[]>
  /**
   * categoryName -> itemName -> preference note ("dal spicy", "rasgulla less sugary").
   * A kitchen instruction, never a charge — only a chef delicacy or a pick increase can move
   * the per-plate rate. Notes for items that aren't selected are ignored.
   */
  notes?: Record<string, Record<string, string>>
}

/**
 * Saves the menu for a sub-event: snapshots the chosen tier's price, pick-counts and item
 * choices onto the sub-event (BR-M1/M3). Re-snapshots base data from the master on every
 * save, but preserves the increase overlay (extra picks, the used free increase, and any
 * pending exception link) as long as the tier is unchanged — a tier change resets it.
 * Enforces per-category pick ceilings; allows an incomplete menu.
 */
export async function saveSubEventMenu(
  actor: Actor,
  subEventId: string,
  input: MenuSaveInput,
): Promise<{ menuId: string; isComplete: boolean }> {
  return db.transaction(async (tx) => {
    const ctx = await loadSubEventContext(tx, subEventId)
    assertEditable(ctx.status)

    // Tier master + price effective on the sub-event's date (BR-M1, BR-M5).
    const [tier] = await tx
      .select({ name: schema.menuTiers.name })
      .from(schema.menuTiers)
      .where(eq(schema.menuTiers.id, input.tierId))
      .limit(1)
    if (!tier) throw badRequest('Unknown menu tier')

    const [price] = (await tx.execute(sql`
      SELECT base_rate_paise AS "baseRatePaise", wedding_surcharge_paise AS "weddingSurchargePaise"
      FROM menu_tier_prices
      WHERE tier_id = ${input.tierId} AND effective_from <= ${ctx.eventDate}
      ORDER BY effective_from DESC
      LIMIT 1
    `)) as unknown as { baseRatePaise: number; weddingSurchargePaise: number }[]
    if (!price) throw badRequest(`No price is defined for ${tier.name} on ${ctx.eventDate}`)
    const surchargePaise = ctx.isWedding ? price.weddingSurchargePaise : 0

    // Master categories (+ items) of the chosen tier.
    const masterCats = await tx
      .select({
        id: schema.menuCategories.id,
        name: schema.menuCategories.name,
        pickCount: schema.menuCategories.pickCount,
      })
      .from(schema.menuCategories)
      .where(eq(schema.menuCategories.tierId, input.tierId))
      .orderBy(asc(schema.menuCategories.sortOrder))
    const masterItems = await tx
      .select({ categoryName: schema.menuCategories.name, itemName: schema.menuItems.name })
      .from(schema.menuItems)
      .innerJoin(schema.menuCategories, eq(schema.menuCategories.id, schema.menuItems.categoryId))
      .where(and(eq(schema.menuCategories.tierId, input.tierId), eq(schema.menuItems.isActive, true)))
    const itemsByCat = new Map<string, Set<string>>()
    for (const it of masterItems) {
      const set = itemsByCat.get(it.categoryName) ?? new Set<string>()
      set.add(it.itemName)
      itemsByCat.set(it.categoryName, set)
    }
    const masterNames = new Set(masterCats.map((c) => c.name))

    // Swap (client request, 19 Jul 2026): within a sub-heading the guest may take an item from
    // ANY tier's list — a Gold dessert on a Silver plate — and it simply spends one of that
    // sub-heading's picks. So picks validate against the pooled master menu (every tier's items
    // for that sub-heading), while the pick count still caps how many. Tier rate is unaffected.
    const pooledRows = await tx
      .select({ categoryName: schema.menuCategories.name, itemName: schema.menuItems.name })
      .from(schema.menuItems)
      .innerJoin(schema.menuCategories, eq(schema.menuCategories.id, schema.menuItems.categoryId))
      .where(eq(schema.menuItems.isActive, true))
    const pooledByCat = new Map<string, Set<string>>()
    for (const it of pooledRows) {
      const set = pooledByCat.get(it.categoryName) ?? new Set<string>()
      set.add(it.itemName)
      pooledByCat.set(it.categoryName, set)
    }

    // Reject selections for categories that aren't in this tier (catches stale/typo input).
    for (const key of Object.keys(input.selections)) {
      if (!masterNames.has(key)) throw badRequest(`"${key}" is not a category of ${tier.name}`)
    }

    // Existing menu → tier-change detection and the increase overlay to preserve.
    const [existing] = await tx
      .select()
      .from(schema.subEventMenus)
      .where(eq(schema.subEventMenus.subEventId, subEventId))
      .limit(1)
    const tierChanged = existing != null && existing.tierId !== input.tierId
    const prevOverlay = new Map<string, { extraPicks: number; exceptionId: string | null }>()
    if (existing && !tierChanged) {
      const prev = await tx
        .select()
        .from(schema.subEventMenuCategories)
        .where(eq(schema.subEventMenuCategories.menuId, existing.id))
      for (const p of prev) {
        prevOverlay.set(p.categoryName, { extraPicks: p.extraPicks, exceptionId: p.exceptionId })
      }
    }

    // Build the validated per-category snapshot: base_pick from the master now, the extra
    // overlay carried across a same-tier save, all-included categories forced to the full list.
    type CatWrite = {
      categoryName: string
      basePick: number | null
      extraPicks: number
      exceptionId: string | null
      selected: string[]
    }
    const writes: CatWrite[] = []
    let allComplete = true
    for (const mc of masterCats) {
      const overlay = tierChanged ? undefined : prevOverlay.get(mc.name)
      const extraPicks = overlay?.extraPicks ?? 0
      const exceptionId = overlay?.exceptionId ?? null

      let selected: string[]
      if (mc.pickCount == null) {
        // All-included: the whole item list is part of the menu, read-only (BR).
        selected = [...(itemsByCat.get(mc.name) ?? [])]
      } else {
        const requested = [...new Set(input.selections[mc.name] ?? [])]
        // Pooled, not tier-only — a swapped-in item from another tier is legitimate here.
        const allowed = pooledByCat.get(mc.name) ?? new Set<string>()
        for (const item of requested) {
          if (!allowed.has(item)) throw badRequest(`"${item}" is not on any ${mc.name} list`)
        }
        const ceiling = mc.pickCount + extraPicks
        if (requested.length > ceiling) {
          throw badRequest(
            `Select at most ${ceiling} in ${mc.name}. Request a menu increase to add more.`,
          )
        }
        selected = requested
      }

      const effectivePick = mc.pickCount == null ? null : mc.pickCount + extraPicks
      const complete = effectivePick == null || selected.length >= effectivePick
      if (!complete) allComplete = false
      writes.push({ categoryName: mc.name, basePick: mc.pickCount, extraPicks, exceptionId, selected })
    }

    // Upsert the menu header. A tier change drops the used free increase.
    let menuId: string
    if (existing) {
      await tx
        .update(schema.subEventMenus)
        .set({
          tierId: input.tierId,
          tierName: tier.name,
          baseRatePaise: price.baseRatePaise,
          surchargePaise,
          isComplete: allComplete,
          isTentative: input.isTentative ?? existing.isTentative,
          freeIncreaseCategory: tierChanged ? null : existing.freeIncreaseCategory,
          savedAt: new Date().toISOString(),
        })
        .where(eq(schema.subEventMenus.id, existing.id))
      menuId = existing.id
    } else {
      const [ins] = await tx
        .insert(schema.subEventMenus)
        .values({
          subEventId,
          tierId: input.tierId,
          tierName: tier.name,
          baseRatePaise: price.baseRatePaise,
          surchargePaise,
          isComplete: allComplete,
          isTentative: input.isTentative ?? true,
        })
        .returning({ id: schema.subEventMenus.id })
      menuId = ins!.id
    }

    // Re-snapshot categories and selections (delete + insert; the overlay was captured above).
    await tx.delete(schema.subEventMenuCategories).where(eq(schema.subEventMenuCategories.menuId, menuId))
    await tx.delete(schema.subEventMenuSelections).where(eq(schema.subEventMenuSelections.menuId, menuId))
    await tx.insert(schema.subEventMenuCategories).values(
      writes.map((w) => ({
        menuId,
        categoryName: w.categoryName,
        basePick: w.basePick,
        extraPicks: w.extraPicks,
        exceptionId: w.exceptionId,
      })),
    )
    const selectionRows = writes.flatMap((w) =>
      w.selected.map((itemName) => ({
        menuId,
        categoryName: w.categoryName,
        itemName,
        // Preference notes ride along with the snapshot so the day sheet shows them.
        note: input.notes?.[w.categoryName]?.[itemName]?.trim() || null,
      })),
    )
    if (selectionRows.length > 0) await tx.insert(schema.subEventMenuSelections).values(selectionRows)

    await recomputeProposalTotal(tx, ctx.eventId, ctx.eventType)

    // FR-1.12: every menu save is a versioned entry in the audit trail.
    await audit(tx, actor, {
      entity: 'sub_event_menus',
      entityId: menuId,
      eventId: ctx.eventId,
      action: existing ? 'update' : 'insert',
      field: 'tier',
      oldValue: existing ? existing.tierName : null,
      newValue: `${tier.name}${allComplete ? '' : ' (incomplete)'}`,
    })

    return { menuId, isComplete: allComplete }
  })
}

// ── Increase (free / exception) ──────────────────────────────────────────────

export type IncreaseResult =
  | { applied: 'free'; categoryName: string; effectivePick: number }
  | { applied: 'exception'; categoryName: string; exceptionId: string }

/**
 * Requests +1 on a category (FR-3.4/3.5). If the category is one of the four eligible
 * heads and the sub-event's single free increase is unused, it applies immediately
 * (BR-M2). Otherwise — a second increase anywhere, or any increase on an ineligible
 * category — it raises a pending Exception and leaves the pick unchanged until an
 * Authority approves it (BR-M3). All-included categories can't be increased at all.
 */
export async function increaseCategory(
  actor: Actor,
  subEventId: string,
  categoryName: string,
): Promise<IncreaseResult> {
  return db.transaction(async (tx) => {
    const ctx = await loadSubEventContext(tx, subEventId)
    assertEditable(ctx.status)

    const [menu] = await tx
      .select()
      .from(schema.subEventMenus)
      .where(eq(schema.subEventMenus.subEventId, subEventId))
      .limit(1)
    if (!menu) throw badRequest('Save a menu before requesting an increase.')

    const [cat] = await tx
      .select()
      .from(schema.subEventMenuCategories)
      .where(
        and(
          eq(schema.subEventMenuCategories.menuId, menu.id),
          eq(schema.subEventMenuCategories.categoryName, categoryName),
        ),
      )
      .limit(1)
    if (!cat) throw badRequest(`"${categoryName}" is not a category of this menu`)
    if (cat.basePick == null) {
      throw badRequest(`Every item in ${categoryName} is already included — there is nothing to increase.`)
    }
    if (cat.exceptionId) {
      const [exc] = await tx
        .select({ status: schema.exceptions.status })
        .from(schema.exceptions)
        .where(eq(schema.exceptions.id, cat.exceptionId))
        .limit(1)
      if (exc?.status === 'pending') {
        throw conflict(`An increase for ${categoryName} is already awaiting approval.`)
      }
    }

    // Master category → is it free-eligible, and its id for the free-increase marker.
    const [masterCat] = await tx
      .select({
        id: schema.menuCategories.id,
        freeIncreaseEligible: schema.menuCategories.freeIncreaseEligible,
      })
      .from(schema.menuCategories)
      .where(and(eq(schema.menuCategories.tierId, menu.tierId), eq(schema.menuCategories.name, categoryName)))
      .limit(1)

    const freeUsed = menu.freeIncreaseCategory != null
    const canBeFree = Boolean(masterCat?.freeIncreaseEligible) && !freeUsed

    if (canBeFree) {
      const newExtra = cat.extraPicks + FREE_INCREASE_MAX
      await tx
        .update(schema.subEventMenuCategories)
        .set({ extraPicks: newExtra })
        .where(
          and(
            eq(schema.subEventMenuCategories.menuId, menu.id),
            eq(schema.subEventMenuCategories.categoryName, categoryName),
          ),
        )
      await tx
        .update(schema.subEventMenus)
        .set({ freeIncreaseCategory: masterCat!.id, isComplete: false })
        .where(eq(schema.subEventMenus.id, menu.id))

      await audit(tx, actor, {
        entity: 'sub_event_menu_categories',
        entityId: menu.id,
        eventId: ctx.eventId,
        action: 'update',
        field: 'free_increase',
        oldValue: categoryName,
        newValue: String(cat.basePick + newExtra),
      })
      return { applied: 'free', categoryName, effectivePick: cat.basePick + newExtra }
    }

    // Exception path: raise a pending request, defer the pick until approval (BR-M3).
    const reason = freeUsed ? 'free_increase_already_used' : 'category_not_free_eligible'
    const [exc] = await tx
      .insert(schema.exceptions)
      .values({
        eventId: ctx.eventId,
        kind: 'menu_increase',
        status: 'pending',
        payload: {
          subEventId,
          menuId: menu.id,
          categoryName,
          currentPick: cat.basePick + cat.extraPicks,
          requestedPick: cat.basePick + cat.extraPicks + 1,
          reason,
        },
        raisedBy: actor.id,
      })
      .returning({ id: schema.exceptions.id })
    await tx
      .update(schema.subEventMenuCategories)
      .set({ exceptionId: exc!.id })
      .where(
        and(
          eq(schema.subEventMenuCategories.menuId, menu.id),
          eq(schema.subEventMenuCategories.categoryName, categoryName),
        ),
      )

    await audit(tx, actor, {
      entity: 'exceptions',
      entityId: exc!.id,
      eventId: ctx.eventId,
      action: 'insert',
      field: 'menu_increase',
      newValue: categoryName,
    })
    return { applied: 'exception', categoryName, exceptionId: exc!.id }
  })
}

// ── Add-ons (FR-3.6) ─────────────────────────────────────────────────────────

export async function addAddon(
  actor: Actor,
  subEventId: string,
  input: { description: string; ratePaise: number; qty: number },
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const ctx = await loadSubEventContext(tx, subEventId)
    assertEditable(ctx.status)

    const [addon] = await tx
      .insert(schema.subEventAddons)
      .values({
        subEventId,
        description: input.description,
        ratePaise: input.ratePaise,
        qty: input.qty,
      })
      .returning({ id: schema.subEventAddons.id })

    await recomputeProposalTotal(tx, ctx.eventId, ctx.eventType)
    await audit(tx, actor, {
      entity: 'sub_event_addons',
      entityId: addon!.id,
      eventId: ctx.eventId,
      action: 'insert',
      field: 'description',
      newValue: input.description,
    })
    return { id: addon!.id }
  })
}

export async function deleteAddon(actor: Actor, addonId: string): Promise<void> {
  return db.transaction(async (tx) => {
    const [addon] = await tx
      .select({ id: schema.subEventAddons.id, subEventId: schema.subEventAddons.subEventId, description: schema.subEventAddons.description })
      .from(schema.subEventAddons)
      .where(eq(schema.subEventAddons.id, addonId))
      .limit(1)
    if (!addon) throw notFound('Add-on not found')
    const ctx = await loadSubEventContext(tx, addon.subEventId)
    assertEditable(ctx.status)

    await tx.delete(schema.subEventAddons).where(eq(schema.subEventAddons.id, addonId))
    await recomputeProposalTotal(tx, ctx.eventId, ctx.eventType)
    await audit(tx, actor, {
      entity: 'sub_event_addons',
      entityId: addonId,
      eventId: ctx.eventId,
      action: 'delete',
      field: 'description',
      oldValue: addon.description,
    })
  })
}
