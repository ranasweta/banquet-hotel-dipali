import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound, ApiError } from '@/lib/api'
import { occupancyParts } from '@/lib/occupancy'

/**
 * Post-confirmation change requests (M8, FR-1.9). Changing a confirmed sub-event's date,
 * time window or venue is not applied directly — it files a change request that the Banquet
 * Manager decides (they own venue/timing changes). On approval the venue slot is re-booked
 * inside one transaction, so the GiST exclusion still decides clashes and an approved move
 * can fail cleanly if the new slot was taken meanwhile. (pax / menu / add-ons apply directly
 * — see changePax below and the menu module.)
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
const REQUESTABLE = new Set(['confirmed', 'in_progress'])
/**
 * Only the Banquet Manager settles a venue/timing move (plus the Auditor for oversight). This
 * also scopes visibility: the queue belongs to whoever decides it, so everyone else sees only
 * the moves they asked for themselves.
 */
// Client, 21 Jul 2026: the Banquet Manager approves nothing — he reads the book. Venue,
// date and time moves are the Higher Authority's call now, alongside menu increases,
// 35+ room requests and over-cap discounts.
export const DECIDER_ROLES = new Set(['higher_authority', 'auditor'])
const EXCLUSION_VIOLATION = '23P01'

function pgCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && typeof (cur as { code: unknown }).code === 'string') return (cur as { code: string }).code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type ChangePayload = { eventDate?: string; startTime?: string; endTime?: string; venueId?: string; bundleId?: string }

/** A fully-resolved, validated schedule — what `applyMove` books. */
export type ResolvedSchedule = {
  eventDate: string; startTime: string; endTime: string
  venueId: string | null; bundleId: string | null
}

type SubEventRow = { id: string; eventId: string; eventDate: string; startTime: string; endTime: string; venueId: string | null; bundleId: string | null; name: string }

async function loadSub(exec: Tx | typeof db, subEventId: string): Promise<SubEventRow & { status: string }> {
  const [row] = (await exec.execute(sql`
    SELECT se.id, se.event_id AS "eventId", se.event_date::text AS "eventDate",
           se.start_time::text AS "startTime", se.end_time::text AS "endTime",
           se.venue_id AS "venueId", se.bundle_id AS "bundleId", se.name, e.status
    FROM sub_events se JOIN events e ON e.id = se.event_id WHERE se.id = ${subEventId}
  `)) as unknown as (SubEventRow & { status: string })[]
  if (!row) throw notFound('Sub-event not found')
  return row
}

/** Merges the requested changes onto the current values and validates the result. */
function resolveNext(cur: SubEventRow, p: ChangePayload) {
  const eventDate = p.eventDate ?? cur.eventDate
  const startTime = (p.startTime ?? cur.startTime).slice(0, 5)
  const endTime = (p.endTime ?? cur.endTime).slice(0, 5)
  // A change targets either a venue or a bundle; if one is set in the payload it replaces both.
  const venueId = p.venueId ?? (p.bundleId ? null : cur.venueId)
  const bundleId = p.bundleId ?? (p.venueId ? null : cur.bundleId)

  if (!ISO_DATE.test(eventDate)) throw badRequest('Invalid date')
  if (!HHMM.test(startTime) || !HHMM.test(endTime)) throw badRequest('Invalid time')
  if (startTime === endTime) throw badRequest('Start and end time cannot be equal')
  if (Boolean(venueId) === Boolean(bundleId)) throw badRequest('Exactly one of venue or bundle must be set')
  return { eventDate, startTime, endTime, venueId, bundleId }
}

/** Files a change request for a confirmed sub-event's date / time / venue. */
export async function requestChange(
  actor: Actor,
  subEventId: string,
  input: { payload: ChangePayload; reason?: string },
): Promise<{ id: string }> {
  const cur = await loadSub(db, subEventId)
  if (!REQUESTABLE.has(cur.status)) {
    throw badRequest('Change requests apply to a confirmed booking. Edit an enquiry directly.')
  }
  const next = resolveNext(cur, input.payload)
  const changed =
    next.eventDate !== cur.eventDate ||
    next.startTime !== cur.startTime.slice(0, 5) ||
    next.endTime !== cur.endTime.slice(0, 5) ||
    next.venueId !== cur.venueId ||
    next.bundleId !== cur.bundleId
  if (!changed) throw badRequest('Nothing is being changed.')

  const parts: string[] = []
  if (next.eventDate !== cur.eventDate) parts.push(`date ${cur.eventDate} → ${next.eventDate}`)
  if (next.startTime !== cur.startTime.slice(0, 5) || next.endTime !== cur.endTime.slice(0, 5)) {
    parts.push(`time ${cur.startTime.slice(0, 5)}–${cur.endTime.slice(0, 5)} → ${next.startTime}–${next.endTime}`)
  }
  if (next.venueId !== cur.venueId || next.bundleId !== cur.bundleId) parts.push('venue change')

  const [cr] = await db
    .insert(schema.changeRequests)
    .values({
      eventId: cur.eventId,
      subEventId,
      payload: next,
      summary: `${cur.name}: ${parts.join('; ')}`,
      reason: input.reason ?? null,
      requestedBy: actor.id,
    })
    .returning({ id: schema.changeRequests.id })
  await audit(db, actor, { entity: 'change_requests', entityId: cr!.id, eventId: cur.eventId, action: 'insert', field: 'requested', newValue: parts.join('; ') })
  return { id: cr!.id }
}

export type DecideChangeInput = { action: 'approve' | 'reject'; remark?: string }

/** The Higher Authority decides a change request; approval re-books the venue slot. */
export async function decideChange(actor: Actor, crId: string, input: DecideChangeInput): Promise<{ status: string }> {
  try {
    return await db.transaction(async (tx) => settleChangeRequest(tx, actor, crId, input))
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict('The requested slot is already taken by another confirmed booking. The change was not applied.')
    }
    throw err
  }
}

/**
 * Settles ONE change request inside a caller-supplied transaction — the composable half of
 * `decideChange`, so the bundle screen can settle a venue move alongside every other ask on
 * the same proposal in one commit (lib/approval-bundles.ts).
 *
 * `alreadyApplied` covers the case where the Authority answered the request by editing the
 * function's schedule himself rather than pressing Approve; moving it again to the payload's
 * dates would undo his own edit.
 */
export async function settleChangeRequest(
  tx: Tx,
  actor: Actor,
  crId: string,
  input: DecideChangeInput,
  opts: { alreadyApplied?: boolean } = {},
): Promise<{ status: string }> {
  if (!DECIDER_ROLES.has(actor.roleName)) throw forbidden('Only the Higher Authority can decide venue/timing changes.')
  if (input.action === 'reject' && !input.remark?.trim()) throw badRequest('A remark is required when rejecting.')

  const [cr] = await tx.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, crId)).for('update').limit(1)
  if (!cr) throw notFound('Change request not found')
  if (cr.status !== 'pending') throw conflict(`This change request was already ${cr.status}.`)

  if (input.action === 'approve' && !opts.alreadyApplied) {
    await applyMove(tx, actor, cr.subEventId, cr.eventId, cr.payload as ResolvedSchedule)
  }
  const status = input.action === 'approve' ? 'approved' : 'rejected'
  await tx
    .update(schema.changeRequests)
    .set({ status, decidedBy: actor.id, decidedAt: new Date().toISOString(), remark: input.remark?.trim() || null })
    .where(eq(schema.changeRequests.id, crId))
  await audit(tx, actor, { entity: 'change_requests', entityId: crId, eventId: cr.eventId, action: 'approval', field: 'status', oldValue: 'pending', newValue: status === 'approved' ? 'approved' : `rejected — ${input.remark?.trim() ?? ''}` })
  return { status }
}

/**
 * Re-books the venue slot for a moved sub-event (delete old bookings, update, re-insert).
 *
 * Exported so the Higher Authority's proposal editor (lib/gm-authority.ts) moves a function
 * through this exact path. A second copy of the venue-hold logic is the surest way to end up
 * with a calendar that disagrees with the bookings — and the GiST exclusion still decides
 * every clash, override or no override.
 */
export async function applyMove(tx: Tx, actor: Actor, subEventId: string, eventId: string, next: ResolvedSchedule): Promise<void> {
  const before = await loadSub(tx, subEventId)
  await tx.delete(schema.venueBookings).where(eq(schema.venueBookings.subEventId, subEventId))
  await tx
    .update(schema.subEvents)
    .set({ eventDate: next.eventDate, startTime: next.startTime, endTime: next.endTime, venueId: next.venueId, bundleId: next.bundleId })
    .where(eq(schema.subEvents.id, subEventId))

  const venueIds = next.bundleId
    ? (await tx.select({ venueId: schema.venueBundleMembers.venueId }).from(schema.venueBundleMembers).where(eq(schema.venueBundleMembers.bundleId, next.bundleId))).map((r) => r.venueId)
    : [next.venueId!]
  const { lowerDate, lowerTime, upperDate, upperTime } = occupancyParts(next.eventDate, next.startTime, next.endTime)
  for (const venueId of venueIds) {
    await tx.execute(sql`
      INSERT INTO venue_bookings (venue_id, sub_event_id, event_id, occupancy)
      VALUES (${venueId}, ${subEventId}, ${eventId},
              tsrange((${lowerDate}::date + ${lowerTime}::time), (${upperDate}::date + ${upperTime}::time), '[)'))
    `)
  }

  // Derived event dates may have moved.
  const dates = (await tx.select({ eventDate: schema.subEvents.eventDate }).from(schema.subEvents).where(eq(schema.subEvents.eventId, eventId))).map((r) => r.eventDate).sort()
  await tx.update(schema.events).set({ firstDate: dates[0], lastDate: dates[dates.length - 1] }).where(eq(schema.events.id, eventId))

  await audit(tx, actor, {
    entity: 'sub_events', entityId: subEventId, eventId, action: 'update', field: 'schedule',
    oldValue: `${before.eventDate} ${before.startTime.slice(0, 5)}–${before.endTime.slice(0, 5)}`,
    newValue: `${next.eventDate} ${next.startTime}–${next.endTime}`,
  })
}

/**
 * Directly changes pax on a confirmed sub-event (FR-1.9 — no approval needed), versioned.
 * No upper bound of any kind (client, 4 Aug 2026): a positive whole number is all that is
 * asked, and there is no capacity left to override.
 */
export async function changePax(actor: Actor, subEventId: string, pax: number): Promise<void> {
  if (!Number.isInteger(pax) || pax <= 0) throw badRequest('Pax must be a positive whole number')
  await db.transaction(async (tx) => {
    const cur = await loadSub(tx, subEventId)
    if (!REQUESTABLE.has(cur.status)) throw badRequest('Edit an enquiry directly; pax changes here are for confirmed bookings.')
    const [old] = await tx.select({ pax: schema.subEvents.pax }).from(schema.subEvents).where(eq(schema.subEvents.id, subEventId)).limit(1)
    await tx.update(schema.subEvents).set({ pax }).where(eq(schema.subEvents.id, subEventId))
    await audit(tx, actor, { entity: 'sub_events', entityId: subEventId, eventId: cur.eventId, action: 'update', field: 'pax', oldValue: String(old!.pax), newValue: String(pax) })
  })
}

export type ChangeRequestRow = {
  id: string; summary: string; status: string; reason: string | null; remark: string | null
  eventId: string; eventCode: string; guestName: string; requestedByName: string; requestedAt: string
  decidedAt: string | null
}

/** Lists change requests with event + requester context (pending-first). */
export async function listChangeRequests(
  opts: { status?: string; eventId?: string; mineId?: string } = {},
): Promise<ChangeRequestRow[]> {
  const conds = [] as ReturnType<typeof sql>[]
  if (opts.status) conds.push(sql`c.status = ${opts.status}`)
  if (opts.eventId) conds.push(sql`c.event_id = ${opts.eventId}`)
  // `mineId` restricts to what this user raised — see the route for who gets the full queue.
  if (opts.mineId) conds.push(sql`c.requested_by = ${opts.mineId}`)
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``
  return (await db.execute(sql`
    SELECT c.id, c.summary, c.status, c.reason, c.remark, c.event_id AS "eventId",
           e.code AS "eventCode", e.guest_name AS "guestName", u.full_name AS "requestedByName",
           c.requested_at AS "requestedAt", c.decided_at AS "decidedAt"
    FROM change_requests c JOIN events e ON e.id = c.event_id JOIN users u ON u.id = c.requested_by
    ${where}
    ORDER BY (c.status = 'pending') DESC, c.requested_at DESC
  `)) as unknown as ChangeRequestRow[]
}
