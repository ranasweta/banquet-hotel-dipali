import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { dedupeMenuNames } from '@/lib/menu-name'
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
// BR-M2, amended 21 Jul 2026: two extra dishes per FUNCTION may be taken without Higher
// Authority approval, shared across every segment rather than tied to one eligible
// category. Per segment was considered and rejected by the client — a four-function
// wedding with five segments each would give away forty dishes unseen.
const FREE_EXTRAS_PER_FUNCTION = 2

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

  const byCat = new Map<string, string[]>()
  for (const r of rows) {
    const list = byCat.get(r.categoryName) ?? []
    list.push(r.itemName)
    byCat.set(r.categoryName, list)
  }
  // The same dish is spelled differently from tier to tier ("Aam Panna" / "Aam Pana
  // (Seasonal)"), which would otherwise show up as several entries in one Swap list.
  return [...byCat.entries()].map(([categoryName, items]) => ({
    categoryName,
    items: dedupeMenuNames(items),
  }))
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
  /** Increase pressed here: picking is unbounded and the tail of `selected` are extras. */
  increaseUnlocked: boolean
  /** Which of `selected` are extras — the picker colours these apart. */
  extras: string[]
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
    // Base picks first, extras after, so the array the picker sends back reproduces the
    // same split on the next save. Selections carry no insertion timestamp, so this
    // ordering IS the record of which dishes were the additions.
    db
      .select()
      .from(schema.subEventMenuSelections)
      .where(eq(schema.subEventMenuSelections.menuId, menu.id))
      .orderBy(
        asc(schema.subEventMenuSelections.categoryName),
        asc(schema.subEventMenuSelections.isExtra),
        asc(schema.subEventMenuSelections.itemName),
      ),
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
  const extraByCat = new Map<string, string[]>()
  const notesByCat = new Map<string, Record<string, string>>()
  for (const s of sels) {
    const list = selByCat.get(s.categoryName) ?? []
    list.push(s.itemName)
    selByCat.set(s.categoryName, list)
    if (s.isExtra) extraByCat.set(s.categoryName, [...(extraByCat.get(s.categoryName) ?? []), s.itemName])
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
      increaseUnlocked: c.increaseUnlocked,
      extras: extraByCat.get(c.categoryName) ?? [],
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
): Promise<{ menuId: string; isComplete: boolean; tierName: string; perPlatePaise: number }> {
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
    type Overlay = {
      unlocked: boolean
      submittedExtraPicks: number
      approvedExtraPicks: number
      exceptionId: string | null
    }
    const prevOverlay = new Map<string, Overlay>()
    if (existing && !tierChanged) {
      const prev = await tx
        .select()
        .from(schema.subEventMenuCategories)
        .where(eq(schema.subEventMenuCategories.menuId, existing.id))
      for (const p of prev) {
        // Every counter is carried, not just extraPicks. Dropping approved/submitted here
        // was silently un-approving picks the Authority had already sanctioned, and the
        // picker autosaves, so it happened within seconds of every decision.
        prevOverlay.set(p.categoryName, {
          unlocked: p.increaseUnlocked,
          submittedExtraPicks: p.submittedExtraPicks,
          approvedExtraPicks: p.approvedExtraPicks,
          exceptionId: p.exceptionId,
        })
      }
    }

    // Build the validated per-category snapshot: base_pick from the master now, the increase
    // overlay carried across a same-tier save, all-included categories forced to the full list.
    //
    // Extras are positional (client, 21 Jul 2026): pressing Increase unlocks a segment, and
    // everything picked beyond base_pick from then on is an extra. The picker appends on
    // click, so the tail of the array IS the list of additions — which is what gives the
    // Authority dish names instead of a bare count, and what lets a base pick be dropped
    // without orphaning the extras above it.
    type CatWrite = {
      categoryName: string
      basePick: number | null
      extraPicks: number
      submittedExtraPicks: number
      approvedExtraPicks: number
      unlocked: boolean
      exceptionId: string | null
      selected: string[]
      /** Indices at and beyond this are the extras. */
      extraFrom: number
    }
    const writes: CatWrite[] = []
    let allComplete = true
    for (const mc of masterCats) {
      const overlay = tierChanged ? undefined : prevOverlay.get(mc.name)
      const unlocked = overlay?.unlocked ?? false
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
        // Unlocked means unlimited: the guest may take as much of this segment as they
        // like, and the overflow becomes the Authority's decision rather than a refusal.
        if (!unlocked && requested.length > mc.pickCount) {
          throw badRequest(
            `Select at most ${mc.pickCount} in ${mc.name}. Press Increase to add more.`,
          )
        }
        selected = requested
      }

      const basePick = mc.pickCount
      const extraFrom = basePick ?? selected.length
      const extraPicks = basePick == null ? 0 : Math.max(0, selected.length - basePick)
      // Removing an extra hands its allowance back, so the bookkeeping clamps down with it.
      const submittedExtraPicks = Math.min(overlay?.submittedExtraPicks ?? 0, extraPicks)
      const approvedExtraPicks = Math.min(overlay?.approvedExtraPicks ?? 0, submittedExtraPicks)

      // Extras never bear on completeness — a segment is complete once its base picks are in.
      const complete = basePick == null || selected.length >= basePick
      if (!complete) allComplete = false
      writes.push({
        categoryName: mc.name,
        basePick,
        extraPicks,
        submittedExtraPicks,
        approvedExtraPicks,
        unlocked,
        exceptionId,
        selected,
        extraFrom,
      })
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
        submittedExtraPicks: w.submittedExtraPicks,
        approvedExtraPicks: w.approvedExtraPicks,
        increaseUnlocked: w.unlocked,
        exceptionId: w.exceptionId,
      })),
    )
    const selectionRows = writes.flatMap((w) =>
      w.selected.map((itemName, i) => ({
        menuId,
        categoryName: w.categoryName,
        itemName,
        // Preference notes ride along with the snapshot so the day sheet shows them.
        note: input.notes?.[w.categoryName]?.[itemName]?.trim() || null,
        // Beyond base_pick, by click order — see the CatWrite comment above.
        isExtra: i >= w.extraFrom,
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

    // The caller (the booking wizard) prices its function list from this — the per-plate
    // rate INCLUDING the wedding surcharge, computed here and never on the client (BR-M5).
    // Returning only { menuId, isComplete } left perPlatePaise undefined, and Payment review
    // then called formatPaise(undefined) and white-screened the whole step.
    return {
      menuId,
      isComplete: allComplete,
      tierName: tier.name,
      perPlatePaise: price.baseRatePaise + surchargePaise,
    }
  })
}

// ── Increase — unlocks a segment for unlimited picking ───────────────────────

export type IncreaseResult = {
  categoryName: string
  /** Base picks the segment came with; everything above this is an extra. */
  basePick: number
  /** Extras already taken in this segment. */
  extraPicks: number
  /** Of the two free per function, how many are still unspent. */
  freeRemaining: number
}

/**
 * Presses Increase on one segment (client, 21 Jul 2026). It does not grant "+1" — it
 * UNLOCKS the segment, and from then on the manager takes as many dishes from it as the
 * guest wants. Everything above base_pick is an extra, coloured apart in the picker and
 * remembered by name.
 *
 * Nothing reaches the Authority here. Extras beyond the free allowance — TWO PER FUNCTION,
 * shared across every segment — go out when the function's submit button is pressed, the
 * same shape as a chef delicacy request. A wedding menu is settled over days, and none of
 * it is the Authority's business until the function is done.
 *
 * All-included segments (base_pick NULL) can't be increased: everything is already on.
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
    if (cat.increaseUnlocked) {
      // Idempotent: pressing it twice is not an error, it is a manager double-checking.
      const used = await totalExtras(tx, menu.id)
      return {
        categoryName,
        basePick: cat.basePick,
        extraPicks: cat.extraPicks,
        freeRemaining: Math.max(0, FREE_EXTRAS_PER_FUNCTION - used),
      }
    }

    await tx
      .update(schema.subEventMenuCategories)
      .set({ increaseUnlocked: true })
      .where(
        and(
          eq(schema.subEventMenuCategories.menuId, menu.id),
          eq(schema.subEventMenuCategories.categoryName, categoryName),
        ),
      )

    await audit(tx, actor, {
      entity: 'sub_event_menu_categories',
      entityId: menu.id,
      eventId: ctx.eventId,
      action: 'update',
      field: 'increase_unlocked',
      oldValue: categoryName,
      newValue: 'unlimited',
    })

    const used = await totalExtras(tx, menu.id)
    return {
      categoryName,
      basePick: cat.basePick,
      extraPicks: cat.extraPicks,
      freeRemaining: Math.max(0, FREE_EXTRAS_PER_FUNCTION - used),
    }
  })
}

/** Extras taken across every segment of one function — the free allowance is shared. */
async function totalExtras(tx: Tx, menuId: string): Promise<number> {
  const [row] = (await tx.execute(sql`
    SELECT COALESCE(sum(extra_picks), 0)::int AS total
    FROM sub_event_menu_categories WHERE menu_id = ${menuId}
  `)) as unknown as { total: number }[]
  return row?.total ?? 0
}

// ── Submitting a function's increases to the Authority ───────────────────────

export type PendingIncrease = {
  categoryName: string
  basePick: number
  extraPicks: number
  submitted: number
  /** The extra dishes themselves, in the order they were taken. */
  items: string[]
}
export type IncreaseSummary = {
  subEventId: string
  subEventName: string
  totalExtras: number
  freeCovered: number
  /** Extras above the free two that have not yet gone to the Authority. */
  awaitingSubmission: number
  alreadySubmitted: number
  segments: PendingIncrease[]
}

/**
 * What this function's submit button would carry: every extra above the free two, by
 * segment, with the dish names already ticked. Pre-fills the confirmation the same way a
 * chef delicacy request is pre-filled.
 */
export async function getIncreaseSummary(
  subEventId: string,
  // Defaults to the pool for plain reads. `submitIncreases` passes its own transaction:
  // calling this on a second connection from inside one would wait on locks the
  // transaction itself holds, and the request hangs until it times out.
  exec: Tx | typeof db = db,
): Promise<IncreaseSummary | null> {
  const [menu] = await exec
    .select({ id: schema.subEventMenus.id })
    .from(schema.subEventMenus)
    .where(eq(schema.subEventMenus.subEventId, subEventId))
    .limit(1)
  if (!menu) return null

  const [sub] = await exec
    .select({ name: schema.subEvents.name })
    .from(schema.subEvents)
    .where(eq(schema.subEvents.id, subEventId))
    .limit(1)

  const rows = (await exec.execute(sql`
    SELECT c.category_name AS "categoryName", c.base_pick AS "basePick",
           c.extra_picks AS "extraPicks", c.submitted_extra_picks AS "submitted",
           COALESCE(
             array_agg(s.item_name ORDER BY s.item_name) FILTER (WHERE s.is_extra), '{}'
           ) AS items
    FROM sub_event_menu_categories c
    LEFT JOIN sub_event_menu_selections s
      ON s.menu_id = c.menu_id AND s.category_name = c.category_name
    WHERE c.menu_id = ${menu.id} AND c.extra_picks > 0
    GROUP BY 1, 2, 3, 4
    ORDER BY 1
  `)) as unknown as PendingIncrease[]

  const total = rows.reduce((n, r) => n + r.extraPicks, 0)
  const alreadySubmitted = rows.reduce((n, r) => n + r.submitted, 0)
  const freeCovered = Math.min(FREE_EXTRAS_PER_FUNCTION, total)

  return {
    subEventId,
    subEventName: sub?.name ?? 'Function',
    totalExtras: total,
    freeCovered,
    awaitingSubmission: Math.max(0, total - freeCovered - alreadySubmitted),
    alreadySubmitted,
    segments: rows,
  }
}

/**
 * Sends this function's outstanding extras to the Authority as one request, itemised by
 * segment and dish. Pressed per function while the proposal is still being built, so the
 * Authority is fed as the work happens rather than in one batch at the lock.
 *
 * The free two are covered off the top and never appear. Re-pressing after adding more
 * dishes sends only what is new — `submitted_extra_picks` is the high-water mark.
 */
export async function submitIncreases(
  actor: Actor,
  subEventId: string,
): Promise<{ exceptionId: string | null; submitted: number }> {
  return db.transaction(async (tx) => {
    const ctx = await loadSubEventContext(tx, subEventId)
    assertEditable(ctx.status)

    const summary = await getIncreaseSummary(subEventId, tx)
    if (!summary || summary.awaitingSubmission === 0) {
      return { exceptionId: null, submitted: 0 }
    }

    // Walk the segments in order, spending the free allowance first, and record what each
    // one still owes the Authority. The dish names come along so the decision is made on
    // "two more starters: paneer tikka, galouti" rather than on a bare count.
    let freeLeft = summary.freeCovered
    const items: {
      categoryName: string
      basePick: number
      alreadySubmitted: number
      requesting: number
      dishes: string[]
    }[] = []

    for (const seg of summary.segments) {
      const covered = Math.min(freeLeft, seg.extraPicks)
      freeLeft -= covered
      const chargeable = seg.extraPicks - covered
      const requesting = chargeable - seg.submitted
      if (requesting <= 0) continue
      items.push({
        categoryName: seg.categoryName,
        basePick: seg.basePick,
        alreadySubmitted: seg.submitted,
        requesting,
        // The dishes this request is actually about: the tail of the extras.
        dishes: seg.items.slice(seg.items.length - requesting),
      })
    }
    if (!items.length) return { exceptionId: null, submitted: 0 }

    const menuId = await menuIdFor(tx, subEventId)
    if (!menuId) return { exceptionId: null, submitted: 0 }

    const [exc] = await tx
      .insert(schema.exceptions)
      .values({
        eventId: ctx.eventId,
        kind: 'menu_increase',
        status: 'pending',
        payload: { subEventId, subEventName: summary.subEventName, menuId, items },
        raisedBy: actor.id,
      })
      .returning({ id: schema.exceptions.id })

    // Mark them sent. Everything chargeable in this function is now submitted.
    for (const it of items) {
      await tx
        .update(schema.subEventMenuCategories)
        .set({
          submittedExtraPicks: it.alreadySubmitted + it.requesting,
          exceptionId: exc!.id,
        })
        .where(
          and(
            eq(schema.subEventMenuCategories.menuId, menuId),
            eq(schema.subEventMenuCategories.categoryName, it.categoryName),
          ),
        )
    }

    await audit(tx, actor, {
      entity: 'exceptions',
      entityId: exc!.id,
      eventId: ctx.eventId,
      action: 'insert',
      field: 'menu_increase',
      newValue: `${summary.subEventName}: ${items.reduce((n, i) => n + i.requesting, 0)} extra dish(es) across ${items.length} segment(s)`,
    })

    return { exceptionId: exc!.id, submitted: items.reduce((n, i) => n + i.requesting, 0) }
  })
}

async function menuIdFor(tx: Tx, subEventId: string): Promise<string | undefined> {
  const [m] = await tx
    .select({ id: schema.subEventMenus.id })
    .from(schema.subEventMenus)
    .where(eq(schema.subEventMenus.subEventId, subEventId))
    .limit(1)
  return m?.id
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
