import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound, ApiError } from '@/lib/api'

/**
 * Approvals queue (M6, FR-6.x). The Higher Authority (and Auditor/Admin) work a single
 * queue of exceptions raised by the other modules — menu increases (M4) and 35+ room
 * allocations (M5) so far, discounts and overdue balances later. Deciding is the other
 * half of every "defer until approved" flow:
 *   - approve applies the deferred change (bumps the pick / inserts the held rooms);
 *   - reject leaves the change unapplied and records a mandatory remark;
 *   - approve_modified applies a modified version supplied by the Authority.
 * Every decision is audited (the requester's notification surrogate until the notifications
 * table lands in M7/M10; see SEED_ASSUMPTIONS C7).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Only these roles may decide an exception — a behavioural rule, not a permission bit
 * (masters.ts). It also decides *visibility*: an approval queue belongs to whoever settles it,
 * so everyone else sees only what they raised themselves. A Banquet Manager has no business
 * reading a menu increase awaiting the GM, and the `approvals` permission bit is too coarse to
 * say so — hence this list, applied server-side in the route.
 */
export const DECIDER_ROLES = new Set(['higher_authority', 'auditor'])
const EXCLUSION_VIOLATION = '23P01'

function pgCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && typeof (cur as { code: unknown }).code === 'string') {
      return (cur as { code: string }).code
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * A one-line, human summary of what an exception is asking for. Exported because the bundle
 * screen (lib/approval-bundles.ts) prints the same sentence beside the proposal — two
 * phrasings of one request is how a GM ends up deciding something other than what was asked.
 */
export function summarizeException(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'menu_increase': {
      // One request per FUNCTION, sent when its submit button is pressed (21 Jul 2026).
      // Name the segment and the dishes, because that is what is actually being decided —
      // "two more starters: paneer tikka, galouti" beats "+2 on segment 3".
      const fn = (payload.subEventName as string | undefined) ?? 'Function'
      const items = (payload.items ?? []) as {
        categoryName: string; requesting: number; dishes: string[]
      }[]
      if (items.length === 0) return 'menu increase'
      const lines = items.map((i) => {
        const dishes = i.dishes?.length ? ` — ${i.dishes.join(', ')}` : ''
        return `${i.categoryName} +${i.requesting}${dishes}`
      })
      return `${fn} · ${lines.join('; ')}`
    }
    case 'room_allocation_35plus': {
      // The bulk shape carries `lines`, not the room-by-room `allocations` the old
      // allocation path wrote; `existingCount` never existed on it and rendered as NaN.
      const lines = (payload.lines ?? []) as { roomType: string; count: number }[]
      const detail = lines.map((l) => `${l.count} × ${l.roomType}`).join(', ')
      return `${payload.requestedCount} room(s) — over the ${payload.threshold} threshold${detail ? ` (${detail})` : ''}`
    }
    case 'discount_over_cap':
      return `discount of ₹${(Number(payload.amountPaise) / 100).toLocaleString('en-IN')} over the cap`
    case 'overdue_wedding_balance':
      return `overdue wedding balance`
    case 'counter_change': {
      // The Authority revising a settled decision. Name what it revises and why — the actual
      // menu/room change is made through the normal tools, this row is the logged directive.
      const orig = (payload.originalSummary as string | undefined) ?? 'a prior decision'
      const reason = (payload.reason as string | undefined) ?? ''
      return `Revision of “${orig}”${reason ? ` — ${reason}` : ''}`
    }
    default:
      return kind
  }
}

// ── List / dashboard ─────────────────────────────────────────────────────────

export type ExceptionRow = {
  id: string
  kind: string
  status: string
  summary: string
  eventId: string
  eventCode: string
  guestName: string
  eventType: string
  raisedByName: string
  raisedAt: string
  decidedByName: string | null
  decidedAt: string | null
  remark: string | null
}

/**
 * Lists exceptions with event + requester context. `status` filters (default all);
 * `mineId` restricts to those a given user raised (so a requester sees their own outcomes);
 * `decidedOnly` keeps only settled rows (anything past `pending`) for the approvals history.
 */
export async function listExceptions(opts: { status?: string; mineId?: string; decidedOnly?: boolean } = {}): Promise<ExceptionRow[]> {
  const conds = [] as ReturnType<typeof sql>[]
  if (opts.status) conds.push(sql`x.status = ${opts.status}::exception_status`)
  if (opts.decidedOnly) conds.push(sql`x.status <> 'pending'`)
  if (opts.mineId) conds.push(sql`x.raised_by = ${opts.mineId}`)
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``

  const rows = (await db.execute(sql`
    SELECT x.id, x.kind::text AS kind, x.status::text AS status, x.payload,
           x.raised_at AS "raisedAt", x.decided_at AS "decidedAt", x.remark,
           ev.id AS "eventId", ev.code AS "eventCode", ev.guest_name AS "guestName", ev.event_type AS "eventType",
           u.full_name AS "raisedByName", du.full_name AS "decidedByName"
    FROM exceptions x
    JOIN events ev ON ev.id = x.event_id
    JOIN users u ON u.id = x.raised_by
    LEFT JOIN users du ON du.id = x.decided_by
    ${where}
    ORDER BY (x.status = 'pending') DESC, x.raised_at DESC
  `)) as unknown as (Omit<ExceptionRow, 'summary'> & { payload: Record<string, unknown> })[]

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    summary: summarizeException(r.kind, r.payload),
    eventId: r.eventId,
    eventCode: r.eventCode,
    guestName: r.guestName,
    eventType: r.eventType,
    raisedByName: r.raisedByName,
    raisedAt: r.raisedAt,
    decidedByName: r.decidedByName,
    decidedAt: r.decidedAt,
    remark: r.remark,
  }))
}

export type Dashboard = {
  pendingCount: number
  byKind: { kind: string; n: number }[]
  upcomingHighValue: { id: string; code: string; guestName: string; firstDate: string | null; proposalTotalPaise: number }[]
}

/** Authority dashboard figures (FR-6.3): pending load and the biggest upcoming events. */
export async function authorityDashboard(): Promise<Dashboard> {
  const [byKindRows, upcoming] = await Promise.all([
    db.execute(sql`
      SELECT kind::text AS kind, count(*)::int AS n
      FROM exceptions WHERE status = 'pending' GROUP BY kind ORDER BY n DESC
    `) as unknown as Promise<{ kind: string; n: number }[]>,
    db.execute(sql`
      SELECT id, code, guest_name AS "guestName", first_date::text AS "firstDate", proposal_total_paise AS "proposalTotalPaise"
      FROM events
      WHERE status IN ('confirmed','in_progress') AND (first_date IS NULL OR first_date >= CURRENT_DATE)
      ORDER BY proposal_total_paise DESC LIMIT 5
    `) as unknown as Promise<Dashboard['upcomingHighValue']>,
  ])
  const pendingCount = byKindRows.reduce((s, r) => s + r.n, 0)
  return { pendingCount, byKind: byKindRows, upcomingHighValue: upcoming }
}

// ── Decide ───────────────────────────────────────────────────────────────────

export type DecideAction = 'approve' | 'reject' | 'approve_modified'
export type DecideInput = { action: DecideAction; remark?: string; modified?: Record<string, unknown> }
export type DecideResult = { id: string; status: string; applied: string }

/**
 * Decides one exception (FR-6.2). Only the Authority/Auditor may call this. On approval it
 * applies the deferred change atomically; on rejection it records the mandatory remark and
 * applies nothing. Runs in one transaction with the audit row.
 */
export async function decideException(
  actor: Actor,
  exceptionId: string,
  input: DecideInput,
): Promise<DecideResult> {
  try {
    return await db.transaction(async (tx) => settleException(tx, actor, exceptionId, input))
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict('A room in this held allocation was taken while the request was pending. Free it or reject this request.')
    }
    throw err
  }
}

/**
 * Settles ONE exception inside a caller-supplied transaction.
 *
 * Split out of `decideException` so a bundle decision (lib/approval-bundles.ts) can settle
 * every ask on a proposal, and the GM's edits to that proposal, in a single transaction — a
 * half-approved bundle is not a state anyone should be able to observe.
 *
 * `alreadyApplied` is the bundle's answer to a genuine ordering hazard: when the GM decides an
 * ask BY EDITING the proposal — unticking the two extra starters rather than pressing Reject —
 * the edit has already set the sanctioned pick count. Re-running the deferred change on top
 * would roll the same dishes back a second time, against a menu that no longer looks the way
 * the request described. So the ask is recorded as decided and nothing is re-applied.
 */
export async function settleException(
  tx: Tx,
  actor: Actor,
  exceptionId: string,
  input: DecideInput,
  opts: { alreadyApplied?: boolean } = {},
): Promise<DecideResult> {
  if (!DECIDER_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Higher Authority can decide exceptions.')
  }
  if (input.action === 'reject' && !input.remark?.trim()) {
    throw badRequest('A remark is required when rejecting.')
  }

  const [exc] = await tx
    .select()
    .from(schema.exceptions)
    .where(eq(schema.exceptions.id, exceptionId))
    .for('update')
    .limit(1)
  if (!exc) throw notFound('Exception not found')
  if (exc.status !== 'pending') throw conflict(`This exception was already ${exc.status}.`)

  const newStatus =
    input.action === 'approve' ? 'approved' : input.action === 'approve_modified' ? 'approved_modified' : 'rejected'
  const payload = exc.payload as Record<string, unknown>
  let applied = opts.alreadyApplied ? 'applied by the Authority’s own edit' : 'none'

  if (!opts.alreadyApplied) {
    if (input.action !== 'reject') {
      applied = await applyDeferred(tx, exc.kind, payload, input.modified)
    } else if (exc.kind === 'menu_increase') {
      // Menu increases are NOT deferred any more — the picks were applied when the
      // manager chose them, days before this decision (21 Jul 2026). A rejection therefore
      // has something real to undo: it is "approve zero", rolling every requested pick
      // back to what was already sanctioned and dropping the dishes chosen above it.
      applied = await applyDeferred(tx, exc.kind, payload, { extraPicks: 0 })
    }
    // Other kinds defer their change until approval, so a rejection has nothing to undo;
    // the rejected status and remark surface to the requester.
  }

  await tx
    .update(schema.exceptions)
    .set({
      status: newStatus as 'approved',
      decidedBy: actor.id,
      decidedAt: new Date().toISOString(),
      remark: input.remark?.trim() || null,
    })
    .where(eq(schema.exceptions.id, exceptionId))

  // FR-6.2: audited, and the audit row is the requester's notification for now.
  await audit(tx, actor, {
    entity: 'exceptions',
    entityId: exceptionId,
    eventId: exc.eventId,
    action: 'approval',
    field: exc.kind,
    oldValue: 'pending',
    newValue: `${newStatus}${input.remark?.trim() ? ` — ${input.remark.trim()}` : ''}`,
  })

  return { id: exceptionId, status: newStatus, applied }
}

/**
 * Raises a counter-change against an already-decided exception (tester, 23 Jul 2026).
 *
 * Decisions are final and immutable. Rather than editing one, the Authority records a NEW,
 * linked exception — kind `counter_change` — that captures the revised intent and a mandatory
 * reason. It appears in the queue/log for the Authority and Auditor and is decided normally;
 * because `applyDeferred` has no arm for this kind, resolving it is a no-op ('noted') and can
 * never touch a guest's saved menu or rooms. The operational change is made through the normal
 * booking/menu tools ("record & route"). The original stays exactly as it was decided.
 */
export async function raiseCounterChange(
  actor: Actor,
  originalId: string,
  reason: string,
): Promise<{ id: string }> {
  if (!DECIDER_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Higher Authority can raise a counter-change.')
  }
  if (!reason.trim()) throw badRequest('A reason is required for a counter-change.')

  return await db.transaction(async (tx) => {
    const [orig] = await tx
      .select()
      .from(schema.exceptions)
      .where(eq(schema.exceptions.id, originalId))
      .for('update')
      .limit(1)
    if (!orig) throw notFound('Exception not found')
    if (orig.status === 'pending') {
      throw conflict('This approval has not been decided yet — decide it rather than countering it.')
    }

    const originalSummary = summarizeException(orig.kind, orig.payload as Record<string, unknown>)
    const [created] = await tx
      .insert(schema.exceptions)
      .values({
        eventId: orig.eventId,
        kind: 'counter_change',
        raisedBy: actor.id,
        payload: {
          supersedesId: orig.id,
          reason: reason.trim(),
          originalKind: orig.kind,
          originalSummary,
          originalStatus: orig.status,
        },
      })
      .returning({ id: schema.exceptions.id })

    await audit(tx, actor, {
      entity: 'exceptions',
      entityId: created.id,
      eventId: orig.eventId,
      action: 'insert',
      field: orig.kind,
      oldValue: orig.status,
      newValue: `counter-change raised — ${reason.trim()}`,
    })

    return { id: created.id }
  })
}

/** Applies (or applies-modified) the deferred change for an approved exception. */
async function applyDeferred(
  tx: Tx,
  kind: string,
  payload: Record<string, unknown>,
  modified: Record<string, unknown> | undefined,
): Promise<string> {
  switch (kind) {
    case 'menu_increase': {
      // The picks are already applied — the manager chose dishes against them over the days
      // the proposal took to settle. What is decided here is how many of them SURVIVE.
      //
      //   approve            every requested pick stands
      //   approve_modified   only `extraPicks` per segment stands; the rest ROLL OUT, and
      //                      any dish selected above the new limit rolls out with them
      //                      (client, 21 Jul 2026: "if he approves partially then that
      //                      other will roll out")
      //
      // A rejection is handled by the caller, which reverses the batch wholesale.
      const menuId = payload.menuId as string | undefined
      const items = (payload.items ?? []) as {
        categoryName: string; requesting: number; dishes: string[]
      }[]
      if (!menuId || items.length === 0) {
        throw badRequest('This request carries no increments to apply.')
      }

      const cap = modified?.extraPicks != null ? Number(modified.extraPicks) : null
      if (cap != null && (!Number.isInteger(cap) || cap < 0)) {
        throw badRequest('Modified pick must be a whole number, zero or more')
      }

      let rolledBack = 0
      for (const i of items) {
        const asked = i.requesting
        const granted = cap == null ? asked : Math.min(asked, cap)
        if (granted < asked) rolledBack += asked - granted

        await tx.execute(sql`
          UPDATE sub_event_menu_categories
             SET approved_extra_picks = approved_extra_picks + ${granted}
           WHERE menu_id = ${menuId} AND category_name = ${i.categoryName}
        `)

        // Drop the dishes this decision refused. The request carries the dish names it is
        // about, so a partial approval removes the last ones asked for rather than the
        // alphabetically-last ones — which used to delete a guest's choice at random
        // because the snapshot could not say which picks were the additions.
        const refused = i.dishes.slice(granted)
        if (refused.length) {
          await tx.execute(sql`
            DELETE FROM sub_event_menu_selections
             WHERE menu_id = ${menuId}
               AND category_name = ${i.categoryName}
               AND item_name IN (${sql.join(refused.map((d) => sql`${d}`), sql`, `)})
          `)
          // extra_picks is derived from the surviving selections on the next save; bring it
          // down now so the figures agree before then.
          await tx.execute(sql`
            UPDATE sub_event_menu_categories
               SET extra_picks = GREATEST(extra_picks - ${refused.length}, approved_extra_picks),
                   submitted_extra_picks = LEAST(submitted_extra_picks, GREATEST(extra_picks - ${refused.length}, approved_extra_picks))
             WHERE menu_id = ${menuId} AND category_name = ${i.categoryName}
          `)
        }
      }
      // Recompute completeness rather than forcing it false. Rolling out a refused EXTRA
      // leaves the base picks untouched, so the menu is usually still complete — and
      // blanking the flag left it blocking the lock checklist until somebody re-saved every
      // menu by hand, with nothing on screen to say why.
      await tx.execute(sql`
        UPDATE sub_event_menus m
           SET is_complete = NOT EXISTS (
             SELECT 1
               FROM sub_event_menu_categories c
              WHERE c.menu_id = m.id
                AND c.base_pick IS NOT NULL
                AND (SELECT count(*) FROM sub_event_menu_selections s
                      WHERE s.menu_id = c.menu_id AND s.category_name = c.category_name) < c.base_pick
           )
         WHERE m.id = ${menuId}
      `)

      const name = (payload.subEventName as string | undefined) ?? 'function'
      return rolledBack === 0
        ? `${items.length} segment(s) in ${name}`
        : `${items.length} segment(s) in ${name}; ${rolledBack} dish(es) rolled out`
    }
    case 'room_allocation_35plus': {
      // There is nothing to insert. Rooms are booked in bulk on the proposal (migration
      // 0009) and `room_requirements` is written the moment the manager saves, threshold
      // crossed or not — the request gates CONFIRM and the lock, it does not hold the rooms.
      //
      // This arm used to read `payload.allocations` and insert into `room_allocations`,
      // neither of which the bulk path produces: the raise side writes `lines`, and nothing
      // has written an allocation since 21 Jul. Every approval therefore died on
      // "No rooms to allocate", which is the one outcome the Authority cannot work around.
      const lines = (payload.lines ?? []) as { roomType: string; count: number }[]
      const rooms = lines.reduce((n, l) => n + Number(l.count ?? 0), 0)
      return lines.length
        ? `${rooms} room(s) across ${lines.length} line(s) approved`
        : 'approved'
    }
    default:
      // discount_over_cap / overdue_wedding_balance carry no deferred insert to apply in M6.
      return 'noted'
  }
}
