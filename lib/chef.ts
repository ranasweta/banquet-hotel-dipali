import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api'
import { recomputeProposalTotal } from '@/lib/pricing'
import { formatPaise } from '@/lib/money'
import { pushToUsers, usersInRoles } from '@/lib/push'

/**
 * Chef delicacy requests (client, 19 Jul 2026).
 *
 * The second flavour of "increase" on the menu picker. The first adds a pick from the printed
 * list; this one asks for something that isn't on any list ("sushi"). The Booking Manager types
 * it free-text, and only the **Chef** puts a price on it. That price is **per plate** — it joins
 * the tier rate and the wedding surcharge, so the food line becomes
 *   pax × (tier base + wedding surcharge + every priced delicacy)
 * and the proposal total is recomputed the moment the Chef prices one.
 *
 * Deliberately not an `exception`: an exception carries a verdict from the Higher Authority,
 * this carries an amount from the Chef.
 */

const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])
/**
 * Only the Chef prices a delicacy (the Auditor is the standing break-glass, as elsewhere). Like
 * the other queues, this also scopes visibility: the queue belongs to whoever settles it, so
 * everyone else sees only the requests they raised.
 */
export const PRICER_ROLES = new Set(['chef', 'auditor'])

export type ChefRequest = {
  id: string
  subEventId: string
  description: string
  status: 'pending' | 'priced' | 'declined'
  chargePaise: number | null
  remark: string | null
  requestedByName: string
  requestedAt: string
  pricedByName: string | null
  pricedAt: string | null
}

type SubCtx = { eventId: string; status: string; subEventName: string }

async function loadSub(exec: typeof db, subEventId: string): Promise<SubCtx> {
  const [row] = (await exec.execute(sql`
    SELECT se.event_id AS "eventId", e.status, se.name AS "subEventName"
    FROM sub_events se JOIN events e ON e.id = se.event_id
    WHERE se.id = ${subEventId}
  `)) as unknown as SubCtx[]
  if (!row) throw notFound('Function not found')
  return row
}

/** Raises a delicacy request against one function. Anyone who may edit menus can ask. */
export async function requestDelicacy(
  actor: Actor,
  subEventId: string,
  description: string,
): Promise<{ id: string }> {
  const text = description.trim()
  if (!text) throw badRequest('Describe what the guest is asking for')
  if (text.length > 300) throw badRequest('Keep the request under 300 characters')

  const created = await db.transaction(async (tx) => {
    const ctx = await loadSub(tx, subEventId)
    if (LOCKED_STATES.has(ctx.status)) throw conflict('This event is locked — its menus can no longer change.')

    const [row] = await tx
      .insert(schema.chefRequests)
      .values({ subEventId, description: text, requestedBy: actor.id })
      .returning({ id: schema.chefRequests.id })

    await audit(tx, actor, {
      entity: 'chef_requests',
      entityId: row!.id,
      eventId: ctx.eventId,
      action: 'insert',
      field: 'description',
      newValue: text,
    })
    return { id: row!.id }
  })

  // AFTER the commit, and never inside it: a push that fails must not roll back the request
  // it was announcing. `pushToUsers` swallows its own errors for the same reason.
  await pushToUsers(await usersInRoles([...PRICER_ROLES]), {
    title: 'New chef request',
    body: text,
    href: '/chef',
    tag: `delicacy-${created.id}`,
  })
  return created
}

/**
 * The Chef prices a request (or declines it). Pricing re-derives the event's proposal total,
 * because the charge lands on every plate of that function.
 */
export async function priceDelicacy(
  actor: Actor,
  requestId: string,
  input: { chargePaise?: number; decline?: boolean; remark?: string },
): Promise<{ id: string; status: string }> {
  if (!PRICER_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Chef can price a delicacy request.')
  }
  const declining = Boolean(input.decline)
  if (!declining) {
    if (input.chargePaise == null || !Number.isInteger(input.chargePaise) || input.chargePaise < 0) {
      throw badRequest('Enter the per-plate charge in paise (0 or more)')
    }
  }

  const decided = await db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(schema.chefRequests)
      .where(eq(schema.chefRequests.id, requestId))
      .for('update')
      .limit(1)
    if (!req) throw notFound('Request not found')
    if (req.status !== 'pending') throw conflict(`This request was already ${req.status}.`)

    const ctx = await loadSub(tx, req.subEventId)
    if (LOCKED_STATES.has(ctx.status)) throw conflict('This event is locked — its menus can no longer change.')

    await tx
      .update(schema.chefRequests)
      .set({
        status: declining ? 'declined' : 'priced',
        chargePaise: declining ? null : input.chargePaise!,
        remark: input.remark?.trim() || null,
        pricedBy: actor.id,
        pricedAt: new Date().toISOString(),
      })
      .where(eq(schema.chefRequests.id, requestId))

    // The per-plate rate just moved, so the proposal total must follow.
    const [ev] = (await tx.execute(sql`
      SELECT event_type AS "eventType" FROM events WHERE id = ${ctx.eventId}
    `)) as unknown as { eventType: string }[]
    await recomputeProposalTotal(tx, ctx.eventId, ev!.eventType)

    await audit(tx, actor, {
      entity: 'chef_requests',
      entityId: requestId,
      eventId: ctx.eventId,
      action: 'approval',
      field: 'charge_paise',
      oldValue: 'pending',
      newValue: declining ? 'declined' : String(input.chargePaise),
    })
    return {
      id: requestId,
      status: declining ? 'declined' : 'priced',
      requestedBy: req.requestedBy,
      description: req.description,
      eventId: ctx.eventId,
    }
  })

  // Back to whoever asked. They are usually mid-proposal with the guest in front of them, so
  // the answer is worth a banner rather than waiting for the next poll of the bell.
  await pushToUsers([decided.requestedBy], {
    title: decided.status === 'priced' ? 'Chef priced your request' : 'Chef declined your request',
    body:
      decided.status === 'priced'
        ? `${decided.description} — ${formatPaise(input.chargePaise!)}/plate`
        : decided.description,
    href: `/bookings/${decided.eventId}`,
    tag: `delicacy-${decided.id}`,
  })
  return { id: decided.id, status: decided.status }
}

/** Total per-plate addition from priced delicacies on a function. */
export async function delicacyChargePaise(exec: typeof db, subEventId: string): Promise<number> {
  const [row] = (await exec.execute(sql`
    SELECT COALESCE(sum(charge_paise), 0) AS total
    FROM chef_requests WHERE sub_event_id = ${subEventId} AND status = 'priced'
  `)) as unknown as { total: number }[]
  return Number(row?.total ?? 0)
}

/** Requests on one function, newest first — drives the picker's delicacy list. */
export async function listForSubEvent(subEventId: string): Promise<ChefRequest[]> {
  return (await db.execute(sql`
    SELECT r.id, r.sub_event_id AS "subEventId", r.description, r.status,
           r.charge_paise AS "chargePaise", r.remark,
           u.full_name AS "requestedByName", r.requested_at AS "requestedAt",
           p.full_name AS "pricedByName", r.priced_at AS "pricedAt"
    FROM chef_requests r
    JOIN users u ON u.id = r.requested_by
    LEFT JOIN users p ON p.id = r.priced_by
    WHERE r.sub_event_id = ${subEventId}
    ORDER BY r.requested_at DESC
  `)) as unknown as ChefRequest[]
}

export type ChefQueueRow = ChefRequest & {
  eventId: string
  eventCode: string
  guestName: string
  subEventName: string
  eventDate: string
  pax: number
}

/** The Chef's queue: every request, pending first, with the function it belongs to. */
export async function listChefQueue(status?: string, mineId?: string): Promise<ChefQueueRow[]> {
  const conds = [] as ReturnType<typeof sql>[]
  if (status) conds.push(sql`r.status = ${status}`)
  // Non-pricers see only what they asked for — see the route.
  if (mineId) conds.push(sql`r.requested_by = ${mineId}`)
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``
  return (await db.execute(sql`
    SELECT r.id, r.sub_event_id AS "subEventId", r.description, r.status,
           r.charge_paise AS "chargePaise", r.remark,
           u.full_name AS "requestedByName", r.requested_at AS "requestedAt",
           p.full_name AS "pricedByName", r.priced_at AS "pricedAt",
           e.id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
           se.name AS "subEventName", se.event_date::text AS "eventDate", se.pax
    FROM chef_requests r
    JOIN sub_events se ON se.id = r.sub_event_id
    JOIN events e ON e.id = se.event_id
    JOIN users u ON u.id = r.requested_by
    LEFT JOIN users p ON p.id = r.priced_by
    ${where}
    ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
  `)) as unknown as ChefQueueRow[]
}
