import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { percentOfPaise } from '@/lib/money'
import { getIntSettings } from '@/lib/settings'

/**
 * Discount service (M7, FR-11.x, BR-D2). Discounts are ledger rows at a head (menu / venue /
 * overall — per-room discounts live on the allocation, BR-D1/M5). The combined discount
 * across every head must stay ≤ 10% of the proposal total (BR-D2); a discount that would
 * cross that cap is recorded but held behind a discount_over_cap exception until the
 * Authority approves it (FR-11.3). The "effective" total counts allocation discounts plus
 * ledger discounts whose exception is absent or approved.
 */

const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])
const LEDGER_HEADS = new Set(['menu', 'venue', 'overall'])

/**
 * The event's currently-effective discount total: per-room allocation discounts (already
 * BR-D1-capped) plus ledger discounts that are either uncapped or approved.
 */
export async function effectiveDiscountPaise(eventId: string, exec = db): Promise<number> {
  const [row] = (await exec.execute(sql`
    SELECT
      COALESCE((SELECT sum(discount_paise) FROM room_allocations WHERE event_id = ${eventId}), 0)
      + COALESCE((
          SELECT sum(d.amount_paise) FROM discounts d
          LEFT JOIN exceptions x ON x.id = d.exception_id
          WHERE d.event_id = ${eventId}
            AND (d.exception_id IS NULL OR x.status IN ('approved','approved_modified'))
        ), 0) AS total
  `)) as unknown as { total: number }[]
  return Number(row!.total)
}

export type DiscountInput = { head: string; amountPaise: number; remark: string; refId?: string }
export type AddDiscountResult =
  | { deferred: false; discountId: string; combinedPaise: number; capPaise: number }
  | { deferred: true; discountId: string; exceptionId: string; combinedPaise: number; capPaise: number }

/**
 * Records a discount. Within the 10% cap it takes effect immediately; over the cap it is
 * saved linked to a pending discount_over_cap exception and takes effect only on approval.
 */
export async function addDiscount(
  actor: Actor,
  eventId: string,
  input: DiscountInput,
): Promise<AddDiscountResult> {
  if (!LEDGER_HEADS.has(input.head)) {
    throw badRequest(`Head must be menu, venue or overall. Per-room discounts are set on the room allocation (BR-D1).`)
  }
  if (input.amountPaise <= 0) throw badRequest('Discount amount must be positive')
  if (!input.remark.trim()) throw badRequest('A remark is required for every discount (FR-11.1)')

  const { discount_cap_pct } = await getIntSettings(['discount_cap_pct'] as const, { discount_cap_pct: 10 })

  return db.transaction(async (tx) => {
    const [ev] = await tx
      .select({ status: schema.events.status, proposalTotalPaise: schema.events.proposalTotalPaise })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1)
    if (!ev) throw notFound('Event not found')
    if (LOCKED_STATES.has(ev.status)) throw conflict('This event is locked — discounts can no longer change.')
    if (ev.proposalTotalPaise <= 0) {
      throw badRequest('Price the proposal first (confirm the booking) before applying a discount.')
    }

    const existing = await effectiveDiscountPaise(eventId, tx)
    const capPaise = percentOfPaise(ev.proposalTotalPaise, discount_cap_pct)
    const combinedPaise = existing + input.amountPaise
    const overCap = combinedPaise > capPaise

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
            amountPaise: input.amountPaise,
            remark: input.remark.trim(),
            combinedPaise,
            capPaise,
            proposalTotalPaise: ev.proposalTotalPaise,
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
        amountPaise: input.amountPaise,
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
      newValue: `${input.amountPaise}${overCap ? ' (over cap — pending)' : ''}`,
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
  amountPaise: number
  remark: string
  status: 'effective' | 'pending' | 'rejected'
  givenAt: string
}

/** All discounts on an event, each tagged effective / pending / rejected. */
export async function listDiscounts(eventId: string): Promise<DiscountRow[]> {
  const rows = (await db.execute(sql`
    SELECT d.id, d.head::text AS head, d.amount_paise AS "amountPaise", d.remark, d.given_at AS "givenAt",
           x.status::text AS "excStatus", d.exception_id AS "exceptionId"
    FROM discounts d LEFT JOIN exceptions x ON x.id = d.exception_id
    WHERE d.event_id = ${eventId}
    ORDER BY d.given_at
  `)) as unknown as { id: string; head: string; amountPaise: number; remark: string; givenAt: string; excStatus: string | null; exceptionId: string | null }[]

  return rows.map((r) => ({
    id: r.id,
    head: r.head,
    amountPaise: Number(r.amountPaise),
    remark: r.remark,
    status: !r.exceptionId
      ? 'effective'
      : r.excStatus === 'approved' || r.excStatus === 'approved_modified'
        ? 'effective'
        : r.excStatus === 'rejected'
          ? 'rejected'
          : 'pending',
    givenAt: r.givenAt,
  }))
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
