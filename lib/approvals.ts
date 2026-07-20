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

/** A one-line, human summary of what an exception is asking for. */
function summarize(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'menu_increase':
      return `+1 pick on "${payload.categoryName}" (${payload.currentPick} → ${payload.requestedPick})`
    case 'room_allocation_35plus':
      return `${payload.requestedCount} room(s) — event total would reach ${Number(payload.existingCount) + Number(payload.requestedCount)}`
    case 'discount_over_cap':
      return `discount of ₹${(Number(payload.amountPaise) / 100).toLocaleString('en-IN')} over the cap`
    case 'overdue_wedding_balance':
      return `overdue wedding balance`
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
  decidedAt: string | null
  remark: string | null
}

/**
 * Lists exceptions with event + requester context. `status` filters (default all);
 * `mineId` restricts to those a given user raised (so a requester sees their own outcomes).
 */
export async function listExceptions(opts: { status?: string; mineId?: string } = {}): Promise<ExceptionRow[]> {
  const conds = [] as ReturnType<typeof sql>[]
  if (opts.status) conds.push(sql`x.status = ${opts.status}::exception_status`)
  if (opts.mineId) conds.push(sql`x.raised_by = ${opts.mineId}`)
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``

  const rows = (await db.execute(sql`
    SELECT x.id, x.kind::text AS kind, x.status::text AS status, x.payload,
           x.raised_at AS "raisedAt", x.decided_at AS "decidedAt", x.remark,
           ev.id AS "eventId", ev.code AS "eventCode", ev.guest_name AS "guestName", ev.event_type AS "eventType",
           u.full_name AS "raisedByName"
    FROM exceptions x
    JOIN events ev ON ev.id = x.event_id
    JOIN users u ON u.id = x.raised_by
    ${where}
    ORDER BY (x.status = 'pending') DESC, x.raised_at DESC
  `)) as unknown as (Omit<ExceptionRow, 'summary'> & { payload: Record<string, unknown> })[]

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    summary: summarize(r.kind, r.payload),
    eventId: r.eventId,
    eventCode: r.eventCode,
    guestName: r.guestName,
    eventType: r.eventType,
    raisedByName: r.raisedByName,
    raisedAt: r.raisedAt,
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
  if (!DECIDER_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Higher Authority can decide exceptions.')
  }
  if (input.action === 'reject' && !input.remark?.trim()) {
    throw badRequest('A remark is required when rejecting.')
  }

  try {
    return await db.transaction(async (tx) => {
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
      let applied = 'none'

      // On reject there is nothing to undo — neither deferred change was ever committed
      // (the pick was never bumped; no rooms were inserted). The exception's rejected
      // status + remark, still linked from the menu category, surfaces to the requester.
      if (input.action !== 'reject') {
        applied = await applyDeferred(tx, exc.kind, payload, input.modified, exc.raisedBy, exc.eventId)
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
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict('A room in this held allocation was taken while the request was pending. Free it or reject this request.')
    }
    throw err
  }
}

/** Applies (or applies-modified) the deferred change for an approved exception. */
async function applyDeferred(
  tx: Tx,
  kind: string,
  payload: Record<string, unknown>,
  modified: Record<string, unknown> | undefined,
  raisedBy: string,
  eventId: string,
): Promise<string> {
  switch (kind) {
    case 'menu_increase': {
      // Bump the category's extra pick and mark the menu incomplete until the item is chosen.
      const delta = modified?.extraPicks != null ? Number(modified.extraPicks) : 1
      if (!Number.isInteger(delta) || delta < 1) throw badRequest('Modified pick must be a positive whole number')
      await tx.execute(sql`
        UPDATE sub_event_menu_categories
        SET extra_picks = extra_picks + ${delta}
        WHERE menu_id = ${payload.menuId as string} AND category_name = ${payload.categoryName as string}
      `)
      await tx.execute(sql`
        UPDATE sub_event_menus SET is_complete = false WHERE id = ${payload.menuId as string}
      `)
      return `+${delta} pick on ${payload.categoryName}`
    }
    case 'room_allocation_35plus': {
      // Insert the held rooms now. A subset may be chosen on approve_modified.
      const all = (payload.allocations ?? []) as {
        roomId: string; checkIn: string; checkOut: string; ratePaise: number; discountPaise: number; overrideNote: string | null
      }[]
      const only = modified?.roomIds as string[] | undefined
      const toInsert = only ? all.filter((a) => only.includes(a.roomId)) : all
      if (toInsert.length === 0) throw badRequest('No rooms to allocate')
      // One multi-row insert, not 35 round trips — the exclusion constraint still checks
      // every row (against existing rows and each other) in the single statement.
      await tx.execute(sql`
        INSERT INTO room_allocations (event_id, room_id, stay, rate_paise, discount_paise, override_note, allocated_by)
        VALUES ${sql.join(
          toInsert.map(
            (a) => sql`(${eventId}, ${a.roomId},
                        daterange(${a.checkIn}::date, ${a.checkOut}::date, '[)'),
                        ${a.ratePaise}, ${a.discountPaise}, ${a.overrideNote}, ${raisedBy})`,
          ),
          sql`, `,
        )}
      `)
      return `allocated ${toInsert.length} room(s)`
    }
    default:
      // discount_over_cap / overdue_wedding_balance carry no deferred insert to apply in M6.
      return 'noted'
  }
}
