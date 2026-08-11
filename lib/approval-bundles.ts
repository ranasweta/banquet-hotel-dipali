import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { conflict, forbidden, notFound, ApiError } from '@/lib/api'
import type { Actor } from '@/lib/audit'
import { proposalDocument, type ProposalDocument } from '@/lib/proposal'
import { summarizeException, settleException, DECIDER_ROLES, type DecideAction } from '@/lib/approvals'
import { settleChangeRequest } from '@/lib/change-requests'
import { applyGmProposalEdits, type GmProposalEdits } from '@/lib/gm-authority'

/**
 * Approval BUNDLES (client's lead, 1 Aug 2026).
 *
 * The Higher Authority used to receive one card per request: a menu increase for the Sangeet,
 * a 35+ room ask, an over-cap discount and a venue move all arrived separately, each carrying a
 * one-line summary and no sight of the booking behind it. His complaint was precise — he was
 * approving fragments and could not see the deal.
 *
 * So the unit of decision becomes the PROPOSAL. Nothing changed about how requests are raised:
 * `lib/menus.ts`, `lib/rooms.ts` and `lib/discounts.ts` still insert an `exceptions` row the
 * moment the ask happens, and `change_requests` still takes venue/date/time moves. What changed
 * is that they are read grouped by `event_id` and decided together. Two consequences fall out
 * of that and are the reason this is a grouping rather than a new table:
 *
 *   • Nothing can be lost. A request that arrives after the GM has already settled part of the
 *     bundle simply joins it, because the bundle is a live query and not a snapshot taken when
 *     the first ask landed.
 *   • Nothing is decided twice. Each underlying row keeps its own status, so a decision applies
 *     to exactly the asks that were still pending when it was made.
 *
 * The GM also sees the whole proposal underneath the asks and may edit any of it — see
 * `lib/gm-authority.ts` for the write side, which is where the lock override lives.
 */

/** Which part of the proposal an ask belongs to — the sections the GM's screen is grouped into. */
export type AskSection = 'food' | 'rooms' | 'discount' | 'timing' | 'other'

const SECTION_OF: Record<string, AskSection> = {
  menu_increase: 'food',
  room_allocation_35plus: 'rooms',
  discount_over_cap: 'discount',
  overdue_wedding_balance: 'discount',
  counter_change: 'other',
  other: 'other',
}

export type BundleAsk = {
  id: string
  /** `exception` rows and `change_request` rows are settled through different tables. */
  source: 'exception' | 'change_request'
  kind: string
  section: AskSection
  status: string
  summary: string
  raisedByName: string
  raisedAt: string
  /** Machine-readable request, so the screen can paint the asked-for items purple. */
  payload: Record<string, unknown>
}

export type BundleSummary = {
  eventId: string
  eventCode: string
  guestName: string
  eventType: string
  status: string
  firstDate: string | null
  proposalTotalPaise: number
  pendingCount: number
  /** Section → how many pending asks, for the queue card's chips. */
  bySection: { section: AskSection; n: number }[]
  /** The oldest pending ask — a bundle is as old as the thing that has waited longest. */
  oldestRaisedAt: string
  raisedByNames: string[]
}

/**
 * Every event with at least one pending ask, oldest-waiting first.
 *
 * Both feeder tables are aggregated per event BEFORE the join, not joined row-to-row: an event
 * with 3 menu increases and 2 change requests would otherwise produce 6 rows and report 6 of
 * each. (That is exactly the bug shape the old per-row queue could not have, and the first one
 * this grouping could introduce.)
 */
export async function listBundles(): Promise<BundleSummary[]> {
  const rows = (await db.execute(sql`
    WITH pending AS (
      SELECT x.event_id, x.kind::text AS kind, x.raised_at, x.raised_by
        FROM exceptions x WHERE x.status = 'pending'
      UNION ALL
      SELECT c.event_id, 'change_request' AS kind, c.requested_at, c.requested_by
        FROM change_requests c WHERE c.status = 'pending'
    )
    SELECT e.id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
           e.event_type AS "eventType", e.status::text AS status,
           e.first_date::text AS "firstDate",
           e.proposal_total_paise AS "proposalTotalPaise",
           count(*)::int AS "pendingCount",
           min(p.raised_at) AS "oldestRaisedAt",
           array_agg(DISTINCT p.kind) AS kinds,
           array_agg(DISTINCT u.full_name) AS "raisedByNames"
      FROM pending p
      JOIN events e ON e.id = p.event_id
      JOIN users u ON u.id = p.raised_by
     GROUP BY e.id, e.code, e.guest_name, e.event_type, e.status, e.first_date, e.proposal_total_paise
     ORDER BY min(p.raised_at)
  `)) as unknown as {
    eventId: string; eventCode: string; guestName: string; eventType: string; status: string
    firstDate: string | null; proposalTotalPaise: number; pendingCount: number
    oldestRaisedAt: string; kinds: string[]; raisedByNames: string[]
  }[]

  // The per-section counts need the kind of every pending row, not the DISTINCT set above, so
  // they are counted in a second pass keyed by event.
  const counts = (await db.execute(sql`
    SELECT event_id AS "eventId", kind, n FROM (
      SELECT x.event_id, x.kind::text AS kind, count(*)::int AS n
        FROM exceptions x WHERE x.status = 'pending' GROUP BY x.event_id, x.kind
      UNION ALL
      SELECT c.event_id, 'change_request' AS kind, count(*)::int AS n
        FROM change_requests c WHERE c.status = 'pending' GROUP BY c.event_id
    ) k
  `)) as unknown as { eventId: string; kind: string; n: number }[]

  return rows.map((r) => {
    const bySection = new Map<AskSection, number>()
    for (const c of counts.filter((c) => c.eventId === r.eventId)) {
      const section = c.kind === 'change_request' ? 'timing' : (SECTION_OF[c.kind] ?? 'other')
      bySection.set(section, (bySection.get(section) ?? 0) + c.n)
    }
    return {
      ...r,
      proposalTotalPaise: Number(r.proposalTotalPaise),
      bySection: [...bySection].map(([section, n]) => ({ section, n })),
      raisedByNames: r.raisedByNames ?? [],
    }
  })
}

export type BundleDetail = {
  event: BundleSummary
  /** Pending asks first; settled ones stay visible so the GM can see what he already did. */
  asks: BundleAsk[]
  proposal: ProposalDocument
  /**
   * True once the event is past editing for everyone else. The GM may still edit it — this
   * only tells the screen to warn him that he is overriding a lock, and (past billing) that
   * saving re-issues the guest's document.
   */
  isLocked: boolean
  willReissueInvoice: boolean
}

const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])
const REISSUE_STATES = new Set(['billed', 'closed'])

/** One event's asks plus the full proposal they belong to. */
export async function bundleDetail(eventId: string, opts: { includeSettled?: boolean } = {}): Promise<BundleDetail> {
  const [ev] = (await db.execute(sql`
    SELECT e.id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
           e.event_type AS "eventType", e.status::text AS status,
           e.first_date::text AS "firstDate", e.proposal_total_paise AS "proposalTotalPaise"
      FROM events e WHERE e.id = ${eventId}
  `)) as unknown as {
    eventId: string; eventCode: string; guestName: string; eventType: string
    status: string; firstDate: string | null; proposalTotalPaise: number
  }[]
  if (!ev) throw notFound('Event not found')

  // Settled asks are kept out by default so the queue reads as work-to-do; the detail screen
  // asks for them so the GM can see the decisions he has already made on this booking.
  const settledFilter = opts.includeSettled ? sql`` : sql`AND x.status = 'pending'`
  const settledCrFilter = opts.includeSettled ? sql`` : sql`AND c.status = 'pending'`

  const excRows = (await db.execute(sql`
    SELECT x.id, x.kind::text AS kind, x.status::text AS status, x.payload,
           x.raised_at AS "raisedAt", u.full_name AS "raisedByName"
      FROM exceptions x JOIN users u ON u.id = x.raised_by
     WHERE x.event_id = ${eventId} ${settledFilter}
     ORDER BY x.raised_at
  `)) as unknown as { id: string; kind: string; status: string; payload: Record<string, unknown>; raisedAt: string; raisedByName: string }[]

  const crRows = (await db.execute(sql`
    SELECT c.id, c.status, c.payload, c.summary, c.reason, c.sub_event_id AS "subEventId",
           c.requested_at AS "raisedAt", u.full_name AS "raisedByName"
      FROM change_requests c JOIN users u ON u.id = c.requested_by
     WHERE c.event_id = ${eventId} ${settledCrFilter}
     ORDER BY c.requested_at
  `)) as unknown as { id: string; status: string; payload: Record<string, unknown>; summary: string; reason: string | null; subEventId: string; raisedAt: string; raisedByName: string }[]

  const asks: BundleAsk[] = [
    ...excRows.map((x) => ({
      id: x.id,
      source: 'exception' as const,
      kind: x.kind,
      section: SECTION_OF[x.kind] ?? 'other',
      status: x.status,
      summary: summarizeException(x.kind, x.payload),
      raisedByName: x.raisedByName,
      raisedAt: x.raisedAt,
      payload: x.payload,
    })),
    ...crRows.map((c) => ({
      id: c.id,
      source: 'change_request' as const,
      kind: 'change_request',
      section: 'timing' as const,
      status: c.status,
      summary: c.reason ? `${c.summary} — ${c.reason}` : c.summary,
      raisedByName: c.raisedByName,
      raisedAt: c.raisedAt,
      // The sub-event travels with the payload so the screen can mark the right function.
      payload: { ...c.payload, subEventId: c.subEventId },
    })),
  ].sort((a, b) => (a.status === b.status ? (a.raisedAt < b.raisedAt ? -1 : 1) : a.status === 'pending' ? -1 : 1))

  const pending = asks.filter((a) => a.status === 'pending')
  const bySection = new Map<AskSection, number>()
  for (const a of pending) bySection.set(a.section, (bySection.get(a.section) ?? 0) + 1)

  return {
    event: {
      ...ev,
      proposalTotalPaise: Number(ev.proposalTotalPaise),
      pendingCount: pending.length,
      bySection: [...bySection].map(([section, n]) => ({ section, n })),
      oldestRaisedAt: pending[0]?.raisedAt ?? asks[0]?.raisedAt ?? '',
      raisedByNames: [...new Set(pending.map((a) => a.raisedByName))],
    },
    asks,
    proposal: await proposalDocument(eventId),
    isLocked: LOCKED_STATES.has(ev.status),
    willReissueInvoice: REISSUE_STATES.has(ev.status),
  }
}

// ── Deciding ─────────────────────────────────────────────────────────────────

export type BundleDecision = {
  id: string
  source: 'exception' | 'change_request'
  action: DecideAction
  remark?: string
  /** Kind-specific modification, e.g. `{ extraPicks: 1 }` on a menu increase. */
  modified?: Record<string, unknown>
}

export type DecideBundleInput = {
  decisions?: BundleDecision[]
  /** Edits to the proposal itself. Applied first — they are the GM's actual answer. */
  edits?: GmProposalEdits
  /** A remark applied to any decision that carries none of its own. */
  remark?: string
}

export type DecideBundleResult = {
  settled: { id: string; status: string; applied: string }[]
  /** Asks that vanished before they could be settled — see the note in the body. */
  skipped: string[]
  changes: string[]
  invoiceReissued: boolean
  invoiceNo: string | null
  /** Pending asks still on this booking after the decision (a late arrival, or a deferral). */
  remaining: number
}

const EXCLUSION_VIOLATION = '23P01'

function pgCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && typeof (cur as { code: unknown }).code === 'string') return (cur as { code: string }).code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Settles a whole bundle — every ask the GM decided, plus every edit he made to the proposal
 * while deciding it — in ONE transaction.
 *
 * Order is deliberate and load-bearing: the EDITS GO FIRST. The GM's real answer to "may they
 * have two more starters?" is usually the tick-box, not the button: he unticks one and saves.
 * Applying edits first means the proposal already says what he decided, and each ask is then
 * recorded against a booking that matches it. Settling first and editing after would briefly
 * put the ask's version of the menu on the guest's booking, and any failure in between would
 * commit that version for good.
 *
 * Anything the edits already carried out is marked `alreadyApplied`, so the deferred change is
 * recorded rather than run a second time (see `settleException`).
 */
export async function decideBundle(
  actor: Actor,
  eventId: string,
  input: DecideBundleInput,
): Promise<DecideBundleResult> {
  if (!DECIDER_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Higher Authority can decide approvals.')
  }
  const decisions = input.decisions ?? []
  const hasEdits = Boolean(
    input.edits &&
      (input.edits.event ||
        input.edits.functions?.length ||
        input.edits.menus?.length ||
        input.edits.rooms ||
        input.edits.addDiscounts?.length ||
        input.edits.removeDiscountIds?.length),
  )
  if (!decisions.length && !hasEdits) throw conflict('Nothing to decide and nothing to change.')

  try {
    return await db.transaction(async (tx) => {
      let changes: string[] = []
      let invoiceReissued = false
      let invoiceNo: string | null = null

      if (hasEdits) {
        const res = await applyGmProposalEdits(tx, actor, eventId, input.edits!)
        changes = res.changes
        invoiceReissued = res.invoiceReissued
        invoiceNo = res.invoiceNo
      }

      // Which asks the edits have already answered. Only these two kinds can be answered by
      // editing: a 35+ room request and an over-cap discount defer nothing, so approving them
      // writes nothing that an edit could collide with.
      const menuTouched = new Set((input.edits?.menus ?? []).map((m) => m.subEventId))
      const scheduleTouched = new Set(
        (input.edits?.functions ?? [])
          .filter((f) => f.eventDate != null || f.startTime != null || f.endTime != null || f.venueId !== undefined || f.bundleId !== undefined)
          .map((f) => f.id),
      )

      // An edit can remove the very row a decision refers to — deleting a discount takes its
      // pending exception with it (lib/gm-authority.ts). That is a resolution, not an error, so
      // the decision is skipped rather than failing the whole bundle.
      const live = new Set(
        (
          (await tx.execute(sql`
            SELECT id::text AS id FROM exceptions WHERE event_id = ${eventId} AND status = 'pending'
            UNION ALL
            SELECT id::text AS id FROM change_requests WHERE event_id = ${eventId} AND status = 'pending'
          `)) as unknown as { id: string }[]
        ).map((r) => r.id),
      )

      const settled: DecideBundleResult['settled'] = []
      const skipped: string[] = []

      for (const d of decisions) {
        if (!live.has(d.id)) {
          skipped.push(d.id)
          continue
        }
        const remark = d.remark ?? input.remark
        if (d.source === 'change_request') {
          const covered = await changeRequestTargets(tx, d.id, scheduleTouched)
          const res = await settleChangeRequest(
            tx,
            actor,
            d.id,
            { action: d.action === 'reject' ? 'reject' : 'approve', remark },
            { alreadyApplied: covered },
          )
          settled.push({ id: d.id, status: res.status, applied: covered ? 'applied by the Authority’s own edit' : 'schedule moved' })
        } else {
          const covered = await exceptionTargets(tx, d.id, menuTouched)
          const res = await settleException(tx, actor, d.id, { action: d.action, remark, modified: d.modified }, { alreadyApplied: covered })
          settled.push({ id: d.id, status: res.status, applied: res.applied })
        }
      }

      const [{ remaining }] = (await tx.execute(sql`
        SELECT (
          (SELECT count(*) FROM exceptions WHERE event_id = ${eventId} AND status = 'pending')
        + (SELECT count(*) FROM change_requests WHERE event_id = ${eventId} AND status = 'pending')
        )::int AS remaining
      `)) as unknown as { remaining: number }[]

      return { settled, skipped, changes, invoiceReissued, invoiceNo, remaining }
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict(
        'That venue window is already held by another confirmed booking, so nothing in this bundle was saved. ' +
          'Pick a different time or venue and decide again.',
      )
    }
    throw err
  }
}

/** True when the GM's own menu edit has already answered this exception. */
async function exceptionTargets(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: string, menuTouched: Set<string>): Promise<boolean> {
  if (menuTouched.size === 0) return false
  const [row] = (await tx.execute(sql`
    SELECT kind::text AS kind, payload->>'subEventId' AS "subEventId" FROM exceptions WHERE id = ${id}
  `)) as unknown as { kind: string; subEventId: string | null }[]
  return Boolean(row && row.kind === 'menu_increase' && row.subEventId && menuTouched.has(row.subEventId))
}

/** True when the GM has already moved the function this change request is about. */
async function changeRequestTargets(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: string, scheduleTouched: Set<string>): Promise<boolean> {
  if (scheduleTouched.size === 0) return false
  const [row] = (await tx.execute(sql`
    SELECT sub_event_id::text AS "subEventId" FROM change_requests WHERE id = ${id}
  `)) as unknown as { subEventId: string }[]
  return Boolean(row && scheduleTouched.has(row.subEventId))
}
