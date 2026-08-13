import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { percentOfPaise } from '@/lib/money'
import { AUTHORITY_ROLES } from '@/lib/post-confirm'
import { getIntSettings } from '@/lib/settings'

/**
 * Discount service (M7, FR-11.x, BR-D2). Discounts are ledger rows at a head — menu / venue /
 * room / overall.
 *
 * A discount is **an amount of money** (client's lead, 4 Aug 2026), reversing the 25 Jul rule
 * that made it a live percentage of its head. ₹50,000 promised is ₹50,000 given, whatever the
 * bill does afterwards — which is what a guest is told and what a guest expects. The percentage
 * still exists, but only as arithmetic: it is what the 10% cap is tested in, never what the row
 * is worth. Such a row stores `percent_bp = NULL`, which is what `discountAmountPaise` reads as
 * "this figure is fixed"; percentage rows written before today keep recomputing live, so old
 * bookings are undisturbed.
 *
 * The COMBINED effective discount across every head must stay ≤ 10% of the **total bill**
 * (venue + food + rooms, pre-tax — amends BR-D2, which used to measure venue+food only; GST
 * never enters it, neither the 5% nor the 18%). A discount that would cross the cap is recorded
 * but held behind a `discount_over_cap` exception until the Higher Authority approves it
 * (FR-11.3).
 *
 * ONE CONSEQUENCE OF FREEZING THE RUPEES. A percentage shrank with the bill and so could never
 * drift over the cap on its own; a fixed amount can, if a function is later removed. So the cap
 * is tested a second time inside `confirmEvent` — the last gate before the money is committed —
 * using this same `discountCap`, and never in two places with two answers.
 *
 * The cap binds the Booking Manager, who gives most discounts. It does not bind the Higher
 * Authority (FR-11.3a), and as of 3 Aug 2026 that is true of every screen he can reach — not
 * only the approvals queue, which is where `lib/gm-authority.ts` had it. Sending his own
 * discount to a queue only he can clear is a round trip with no one at the other end, and it
 * changed answer depending on which page he happened to be on.
 */

const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])
const LEDGER_HEADS = new Set(['menu', 'venue', 'room', 'overall'])
const MAX_BP = 10_000 // 100%

type HeadSubtotals = { venue: number; menu: number; room: number; overall: number }

/**
 * The event's live per-head subtotals — the same figures the bill is built from (venue rate
 * snapshots, pax × per-plate + add-ons, and count × nights × rate for rooms). `overall` is the
 * whole pre-tax bill. A percentage discount is measured against one of these.
 */
async function headSubtotals(eventId: string, exec: Pick<typeof db, 'execute'> = db): Promise<HeadSubtotals> {
  const [row] = (await exec.execute(sql`
    SELECT
      COALESCE((SELECT sum(COALESCE(NULLIF(se.venue_rate_paise, 0),
                 (SELECT rc.rate_paise FROM venue_rate_cards rc
                   WHERE ((se.venue_id IS NOT NULL AND rc.venue_id = se.venue_id)
                       OR (se.bundle_id IS NOT NULL AND rc.bundle_id = se.bundle_id))
                     AND rc.event_type = e.event_type
                     AND rc.effective_from <= se.event_date
                   ORDER BY rc.effective_from DESC LIMIT 1), 0))
                 FROM sub_events se JOIN events e ON e.id = se.event_id
                WHERE se.event_id = ${eventId}), 0)::bigint AS venue,
      (COALESCE((SELECT sum(se.pax::bigint * (m.base_rate_paise + m.surcharge_paise))
                   FROM sub_event_menus m JOIN sub_events se ON se.id = m.sub_event_id
                  WHERE se.event_id = ${eventId}), 0)
       + COALESCE((SELECT sum(a.qty::bigint * a.rate_paise)
                     FROM sub_event_addons a JOIN sub_events se ON se.id = a.sub_event_id
                    WHERE se.event_id = ${eventId}), 0))::bigint AS menu,
      COALESCE((SELECT sum(rr.count::bigint * (rr.check_out - rr.check_in)
                          * COALESCE(rr.rate_paise, (SELECT min(r.rack_rate_paise) FROM rooms r
                                       WHERE r.room_type = rr.room_type AND r.is_active
                                         AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)), 0))
                 FROM room_requirements rr WHERE rr.event_id = ${eventId}), 0)::bigint AS room
  `)) as unknown as { venue: number; menu: number; room: number }[]
  const venue = Number(row!.venue)
  const menu = Number(row!.menu)
  const room = Number(row!.room)
  return { venue, menu, room, overall: venue + menu + room }
}

/** The current rupee value of one discount row — a percentage of its head, or a fixed amount. */
function discountAmountPaise(
  row: { head: string; percentBp: number | null; amountPaise: number },
  subs: HeadSubtotals,
): number {
  if (row.percentBp != null) {
    return Math.round((subs[row.head as keyof HeadSubtotals] * row.percentBp) / MAX_BP)
  }
  return row.amountPaise
}

/**
 * The event's currently-effective discount total, computed LIVE: per-room allocation discounts
 * (legacy, BR-D1) plus ledger discounts — each recomputed from its percentage against the
 * current subtotal — whose exception is absent or approved.
 */
export async function effectiveDiscountPaise(eventId: string, exec: Pick<typeof db, 'execute'> = db): Promise<number> {
  const subs = await headSubtotals(eventId, exec)
  const rows = (await exec.execute(sql`
    SELECT d.head::text AS head, d.percent_bp AS "percentBp", d.amount_paise AS "amountPaise",
           d.exception_id AS "exceptionId", x.status::text AS "excStatus"
    FROM discounts d LEFT JOIN exceptions x ON x.id = d.exception_id
    WHERE d.event_id = ${eventId}
  `)) as unknown as { head: string; percentBp: number | null; amountPaise: number; exceptionId: string | null; excStatus: string | null }[]
  const [alloc] = (await exec.execute(
    sql`SELECT COALESCE(sum(discount_paise), 0)::bigint AS total FROM room_allocations WHERE event_id = ${eventId}`,
  )) as unknown as { total: number }[]

  let total = Number(alloc!.total)
  for (const r of rows) {
    const effective = !r.exceptionId || r.excStatus === 'approved' || r.excStatus === 'approved_modified'
    if (!effective) continue
    total += discountAmountPaise(
      { head: r.head, percentBp: r.percentBp == null ? null : Number(r.percentBp), amountPaise: Number(r.amountPaise) },
      subs,
    )
  }
  return total
}

export type DiscountCap = {
  capPct: number
  /** The undiscounted bill the cap is a percentage of: venue + food + rooms, no tax. */
  capBasePaise: number
  capPaise: number
  /** Effective discounts already given — what is eaten out of the cap. */
  usedPaise: number
  /** capPaise − usedPaise, floored at zero: what a manager still has to give. */
  headroomPaise: number
}

/**
 * The 10% ceiling and how much of it is spent. One definition, read by the entry check, by
 * confirm's re-test, and by the screen that shows a manager what is left — a discount is a
 * rupee figure now, so headroom has to be a rupee figure too.
 *
 * A confirmed booking measures against its stored proposal total (venue+food) plus rooms; an
 * enquiry has no stored total yet, so it measures the live overall. Tax is in neither.
 */
export async function discountCap(
  eventId: string,
  exec: Pick<typeof db, 'execute' | 'select'> = db,
): Promise<DiscountCap> {
  const { discount_cap_pct } = await getIntSettings(['discount_cap_pct'] as const, { discount_cap_pct: 10 })
  const [ev] = await exec
    .select({ proposalTotalPaise: schema.events.proposalTotalPaise })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1)
  if (!ev) throw notFound('Event not found')
  const subs = await headSubtotals(eventId, exec)
  const capBasePaise = ev.proposalTotalPaise > 0 ? ev.proposalTotalPaise + subs.room : subs.overall
  const capPaise = percentOfPaise(capBasePaise, discount_cap_pct)
  const usedPaise = await effectiveDiscountPaise(eventId, exec)
  return {
    capPct: discount_cap_pct,
    capBasePaise,
    capPaise,
    usedPaise,
    headroomPaise: Math.max(0, capPaise - usedPaise),
  }
}

export type DiscountInput = { head: string; percentBp?: number; amountPaise?: number; remark: string; refId?: string }
export type AddDiscountResult =
  | { deferred: false; discountId: string; combinedPaise: number; capPaise: number }
  | { deferred: true; discountId: string; exceptionId: string; combinedPaise: number; capPaise: number }

/**
 * Records a discount against a head — a rupee amount, which is how every screen sends one since
 * 4 Aug 2026, or a percentage for the approval-bundle path and older callers. Within the 10% cap
 * it takes effect immediately; over the cap it is saved linked to a pending discount_over_cap
 * exception and takes effect only on approval.
 */
export async function addDiscount(
  actor: Actor,
  eventId: string,
  input: DiscountInput,
): Promise<AddDiscountResult> {
  if (!LEDGER_HEADS.has(input.head)) {
    throw badRequest('Head must be menu, venue, room or overall.')
  }
  const hasPct = input.percentBp != null
  const hasAmt = input.amountPaise != null
  if (hasPct === hasAmt) throw badRequest('Give either a percentage or a rupee amount — exactly one.')
  if (hasPct && (input.percentBp! <= 0 || input.percentBp! > MAX_BP)) throw badRequest('Percentage must be between 0 and 100.')
  if (hasAmt && input.amountPaise! <= 0) throw badRequest('Discount amount must be positive')
  if (!input.remark.trim()) throw badRequest('A remark is required for every discount (FR-11.1)')

  return db.transaction(async (tx) => {
    const [ev] = await tx
      .select({ status: schema.events.status })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1)
    if (!ev) throw notFound('Event not found')
    if (LOCKED_STATES.has(ev.status)) throw conflict('This event is locked — discounts can no longer change.')

    const subs = await headSubtotals(eventId, tx)
    // A rupee row is worth exactly what was typed. A legacy % row is priced here for the cap
    // check and recomputes live thereafter.
    const thisAmount = hasPct ? Math.round((subs[input.head as keyof HeadSubtotals] * input.percentBp!) / MAX_BP) : input.amountPaise!
    if (thisAmount <= 0) throw badRequest('This head has no charge to discount yet — price the proposal first.')

    // 10% of the TOTAL BILL, pre-tax (client, 25 Jul 2026, amends BR-D2) — one definition,
    // shared with confirm's re-test and with the screen that shows the remaining headroom.
    const { capBasePaise, capPaise, usedPaise } = await discountCap(eventId, tx)
    const combinedPaise = usedPaise + thisAmount
    // The cap routes a large discount TO the Authority; it has nothing to do when he is the one
    // giving it (FR-11.3a). His row carries no exception, which is what `effectiveDiscountPaise`
    // reads as in force. The remark is still mandatory, and the audit row says who waived it.
    const uncapped = AUTHORITY_ROLES.has(actor.roleName)
    const overCap = !uncapped && combinedPaise > capPaise

    let exceptionId: string | null = null
    if (overCap) {
      const [exc] = await tx
        .insert(schema.exceptions)
        .values({
          eventId,
          kind: 'discount_over_cap',
          status: 'pending',
          payload: {
            head: input.head,
            percentBp: hasPct ? input.percentBp : null,
            amountPaise: thisAmount,
            remark: input.remark.trim(),
            combinedPaise,
            capPaise,
            capBasePaise,
          },
          raisedBy: actor.id,
        })
        .returning({ id: schema.exceptions.id })
      exceptionId = exc!.id
    }

    const [disc] = await tx
      .insert(schema.discounts)
      .values({
        eventId,
        head: input.head as 'menu',
        refId: input.refId ?? null,
        percentBp: hasPct ? input.percentBp! : null,
        amountPaise: thisAmount,
        remark: input.remark.trim(),
        exceptionId,
        givenBy: actor.id,
      })
      .returning({ id: schema.discounts.id })

    await audit(tx, actor, {
      entity: 'discounts',
      entityId: disc!.id,
      eventId,
      action: 'insert',
      field: input.head,
      newValue: `${hasPct ? `${input.percentBp! / 100}%` : `₹${thisAmount / 100}`}${
        overCap ? ' (over cap — pending)' : uncapped && combinedPaise > capPaise ? ' (Authority, uncapped)' : ''
      }`,
    })

    if (overCap) {
      await audit(tx, actor, {
        entity: 'exceptions',
        entityId: exceptionId!,
        eventId,
        action: 'insert',
        field: 'discount_over_cap',
        newValue: `combined ₹${(combinedPaise / 100).toLocaleString('en-IN')} > cap ₹${(capPaise / 100).toLocaleString('en-IN')}`,
      })
      return { deferred: true, discountId: disc!.id, exceptionId: exceptionId!, combinedPaise, capPaise }
    }
    return { deferred: false, discountId: disc!.id, combinedPaise, capPaise }
  })
}

export type DiscountRow = {
  id: string
  head: string
  percentBp: number | null
  amountPaise: number
  remark: string
  status: 'effective' | 'pending' | 'rejected'
  givenAt: string
}

/** All discounts on an event — each with its live rupee value and effective/pending/rejected tag. */
export async function listDiscounts(eventId: string): Promise<DiscountRow[]> {
  const subs = await headSubtotals(eventId)
  const rows = (await db.execute(sql`
    SELECT d.id, d.head::text AS head, d.percent_bp AS "percentBp", d.amount_paise AS "amountPaise",
           d.remark, d.given_at AS "givenAt", x.status::text AS "excStatus", d.exception_id AS "exceptionId"
    FROM discounts d LEFT JOIN exceptions x ON x.id = d.exception_id
    WHERE d.event_id = ${eventId}
    ORDER BY d.given_at
  `)) as unknown as { id: string; head: string; percentBp: number | null; amountPaise: number; remark: string; givenAt: string; excStatus: string | null; exceptionId: string | null }[]

  return rows.map((r) => {
    const percentBp = r.percentBp == null ? null : Number(r.percentBp)
    return {
      id: r.id,
      head: r.head,
      percentBp,
      amountPaise: discountAmountPaise({ head: r.head, percentBp, amountPaise: Number(r.amountPaise) }, subs),
      remark: r.remark,
      status: !r.exceptionId
        ? 'effective'
        : r.excStatus === 'approved' || r.excStatus === 'approved_modified'
          ? 'effective'
          : r.excStatus === 'rejected'
            ? 'rejected'
            : 'pending',
      givenAt: r.givenAt,
    }
  })
}

/** The live per-head subtotals, so a UI can price a "30% on menu" before it is saved. */
export async function discountBases(eventId: string): Promise<HeadSubtotals> {
  return headSubtotals(eventId)
}

/** Removes a discount (and its pending exception, if any). */
export async function deleteDiscount(actor: Actor, discountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [d] = await tx
      .select({ id: schema.discounts.id, eventId: schema.discounts.eventId, exceptionId: schema.discounts.exceptionId, head: schema.discounts.head })
      .from(schema.discounts)
      .where(eq(schema.discounts.id, discountId))
      .limit(1)
    if (!d) throw notFound('Discount not found')
    const [ev] = await tx.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, d.eventId)).limit(1)
    if (ev && LOCKED_STATES.has(ev.status)) throw conflict('This event is locked — discounts can no longer change.')

    await tx.delete(schema.discounts).where(eq(schema.discounts.id, discountId))
    // Clear a still-pending exception so it leaves the queue with the discount.
    if (d.exceptionId) {
      await tx
        .delete(schema.exceptions)
        .where(and(eq(schema.exceptions.id, d.exceptionId), eq(schema.exceptions.status, 'pending')))
    }
    await audit(tx, actor, { entity: 'discounts', entityId: discountId, eventId: d.eventId, action: 'delete', field: d.head, oldValue: 'removed' })
  })
}
