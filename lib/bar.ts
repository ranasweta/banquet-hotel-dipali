import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { assertPaise } from '@/lib/money'
import { recomputeProposalTotal } from '@/lib/pricing'
import { loadSubEventContext, type SubEventContext } from '@/lib/menus'

/**
 * The bar (client, 12 Aug 2026) — brands the Auditor prices, bottles the guest orders.
 *
 * Two halves, deliberately kept apart:
 *
 *  - **The catalogue** (`bar_brands`) is master data, the Auditor's, edited beside the menu
 *    tiers under the same `menu_master` permission. A brand is a name and what one bottle
 *    costs.
 *  - **The order** (`sub_event_bar_items`) hangs off a FUNCTION, like an add-on, because a
 *    wedding drinks at the reception and not at the mehndi. It carries the brand's name and
 *    price as SNAPSHOTS (rule 4), so re-pricing the bar tomorrow leaves every proposal
 *    already quoted exactly where it was.
 *
 * The money reaches the bill through `recomputeProposalTotal`, the same path add-ons take, so
 * a bar line is inside `proposal_total_paise` and therefore inside the payable, the 25%
 * advance base and the 10% discount cap without any of those modules needing to know the bar
 * exists. It prints as an 18%-shown line (rule 11) — see the CA note in the 0028 migration.
 */

// ── The catalogue (Auditor) ──────────────────────────────────────────────────

export type BarBrand = { id: string; name: string; pricePerBottlePaise: number; isActive: boolean }

/** Every brand, retired ones included — this is the screen where you turn one back on. */
export async function listBrands(): Promise<BarBrand[]> {
  const rows = await db.select().from(schema.barBrands).orderBy(asc(schema.barBrands.name))
  return rows.map((b) => ({
    id: b.id,
    name: b.name,
    pricePerBottlePaise: Number(b.pricePerBottlePaise),
    isActive: b.isActive,
  }))
}

/** Active brands only, for the dropdown the picker searches. */
export async function listActiveBrands(): Promise<BarBrand[]> {
  return (await listBrands()).filter((b) => b.isActive)
}

/** Postgres unique-violation, unwrapped from Drizzle's wrapper (see menu-master.ts). */
function isUnique(err: unknown): boolean {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && (cur as { code: unknown }).code === '23505') return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

function assertPrice(paise: number): void {
  assertPaise(paise)
  if (paise <= 0) throw badRequest('A bottle has to cost more than zero.')
}

export async function createBrand(
  actor: Actor,
  input: { name: string; pricePerBottlePaise: number },
): Promise<{ id: string }> {
  const name = input.name.trim()
  if (!name) throw badRequest('A brand needs a name.')
  assertPrice(input.pricePerBottlePaise)

  return db.transaction(async (tx) => {
    try {
      const [b] = await tx
        .insert(schema.barBrands)
        .values({ name, pricePerBottlePaise: input.pricePerBottlePaise })
        .returning({ id: schema.barBrands.id })
      await audit(tx, actor, {
        entity: 'bar_brands', entityId: b!.id, action: 'insert', field: 'name',
        newValue: `${name} @ ${input.pricePerBottlePaise} paise/bottle`,
      })
      return { id: b!.id }
    } catch (e) {
      // The index is on lower(name): "blenders pride" is the same brand as "Blenders Pride",
      // and two of them in the dropdown is how one gets picked at the wrong price.
      if (isUnique(e)) throw conflict(`"${name}" is already on the bar list.`)
      throw e
    }
  })
}

/** Re-prices a brand, renames it, retires it, or brings it back. */
export async function updateBrand(
  actor: Actor,
  brandId: string,
  patch: { name?: string; pricePerBottlePaise?: number; isActive?: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [b] = await tx.select().from(schema.barBrands).where(eq(schema.barBrands.id, brandId)).limit(1)
    if (!b) throw notFound('Brand not found')

    const name = patch.name?.trim() ?? b.name
    if (!name) throw badRequest('A brand needs a name.')
    const price = patch.pricePerBottlePaise ?? Number(b.pricePerBottlePaise)
    assertPrice(price)
    const isActive = patch.isActive ?? b.isActive
    if (name === b.name && price === Number(b.pricePerBottlePaise) && isActive === b.isActive) return

    try {
      await tx
        .update(schema.barBrands)
        .set({ name, pricePerBottlePaise: price, isActive })
        .where(eq(schema.barBrands.id, brandId))
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${name}" is already on the bar list.`)
      throw e
    }
    // Bottles already ordered keep the price they were quoted at — they hold their own
    // snapshot — so this governs orders placed from now on and nothing else.
    await audit(tx, actor, {
      entity: 'bar_brands', entityId: brandId, action: 'update', field: 'brand',
      oldValue: `${b.name} @ ${b.pricePerBottlePaise}${b.isActive ? '' : ' (retired)'}`,
      newValue: `${name} @ ${price}${isActive ? '' : ' (retired)'}`,
    })
  })
}

/** What a re-price would and would not move, for the screen to say out loud. */
export async function brandUsage(brandId: string): Promise<{ orderedOn: number }> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS "orderedOn" FROM sub_event_bar_items WHERE brand_id = ${brandId}
  `)) as unknown as { orderedOn: number }[]
  return row ?? { orderedOn: 0 }
}

// ── The order (per function) ─────────────────────────────────────────────────

export type BarLine = {
  id: string
  brandId: string
  brandName: string
  ratePaise: number
  bottles: number
  /** bottles × rate, so no screen has to multiply it back out. */
  totalPaise: number
}

export async function getSubEventBar(subEventId: string): Promise<BarLine[]> {
  const rows = await db
    .select()
    .from(schema.subEventBarItems)
    .where(eq(schema.subEventBarItems.subEventId, subEventId))
    .orderBy(asc(schema.subEventBarItems.brandName))
  return rows.map((r) => ({
    id: r.id,
    brandId: r.brandId,
    brandName: r.brandName,
    ratePaise: Number(r.ratePaise),
    bottles: r.bottles,
    totalPaise: r.bottles * Number(r.ratePaise),
  }))
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])

/**
 * The function's event, refusing if the booking can no longer be edited.
 *
 * The `sub_event_bar_items` trigger backs this at the DB; blocking here first is what turns
 * it into a clean 409 with a sentence a human can act on (rule 6).
 */
async function loadEditableSubEvent(tx: Tx, subEventId: string): Promise<SubEventContext> {
  const ctx = await loadSubEventContext(tx, subEventId)
  if (LOCKED_STATES.has(ctx.status)) throw conflict('This booking is locked — the bar can no longer be changed.')
  return ctx
}

/**
 * Orders bottles of a brand for one function.
 *
 * Ordering a brand that is already on the function REPLACES the count rather than adding a
 * second line — `UNIQUE (sub_event_id, brand_id)` sees to it, and "3 bottles" then "2 bottles"
 * meaning five is a guess nobody should be making off a bill.
 */
export async function setBarLine(
  actor: Actor,
  subEventId: string,
  input: { brandId: string; bottles: number },
): Promise<{ id: string }> {
  if (!Number.isInteger(input.bottles) || input.bottles < 1) {
    throw badRequest('Order at least one bottle.')
  }
  return db.transaction(async (tx) => {
    const ctx = await loadEditableSubEvent(tx, subEventId)

    const [brand] = await tx.select().from(schema.barBrands).where(eq(schema.barBrands.id, input.brandId)).limit(1)
    if (!brand) throw notFound('Brand not found')
    // A retired brand is off the dropdown; refusing it here is what stops a stale screen
    // quoting a price the hotel has withdrawn.
    if (!brand.isActive) throw badRequest(`${brand.name} is no longer stocked.`)

    const [existing] = await tx
      .select()
      .from(schema.subEventBarItems)
      .where(
        and(
          eq(schema.subEventBarItems.subEventId, subEventId),
          eq(schema.subEventBarItems.brandId, input.brandId),
        ),
      )
      .limit(1)

    const rate = Number(brand.pricePerBottlePaise)
    const [row] = await tx
      .insert(schema.subEventBarItems)
      .values({
        subEventId,
        brandId: brand.id,
        brandName: brand.name,
        ratePaise: rate,
        bottles: input.bottles,
      })
      // Re-ordering re-snapshots the price, which is right: the guest is being quoted again,
      // today, and the line they end up holding should say today's rate.
      .onConflictDoUpdate({
        target: [schema.subEventBarItems.subEventId, schema.subEventBarItems.brandId],
        set: { brandName: brand.name, ratePaise: rate, bottles: input.bottles },
      })
      .returning({ id: schema.subEventBarItems.id })

    await recomputeProposalTotal(tx, ctx.eventId, ctx.eventType)
    await audit(tx, actor, {
      entity: 'sub_event_bar_items', entityId: row!.id, eventId: ctx.eventId,
      action: existing ? 'update' : 'insert', field: 'bottles',
      oldValue: existing ? `${brand.name} × ${existing.bottles}` : null,
      newValue: `${brand.name} × ${input.bottles} @ ${rate} paise`,
    })
    return { id: row!.id }
  })
}

export async function removeBarLine(actor: Actor, lineId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(schema.subEventBarItems)
      .where(eq(schema.subEventBarItems.id, lineId))
      .limit(1)
    if (!line) throw notFound('Bar line not found')
    const ctx = await loadEditableSubEvent(tx, line.subEventId)

    await tx.delete(schema.subEventBarItems).where(eq(schema.subEventBarItems.id, lineId))
    await recomputeProposalTotal(tx, ctx.eventId, ctx.eventType)
    await audit(tx, actor, {
      entity: 'sub_event_bar_items', entityId: lineId, eventId: ctx.eventId,
      action: 'delete', field: 'bottles',
      oldValue: `${line.brandName} × ${line.bottles}`,
    })
  })
}
