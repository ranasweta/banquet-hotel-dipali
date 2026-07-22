import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound, ApiError } from '@/lib/api'
import { getIntSettings } from '@/lib/settings'

/**
 * Rooms module service layer (M5, FR-4.x, BR-L1/L2, BR-D1).
 *
 *  - Allocation blocks a specific room for a date range; the `room_allocations` GiST
 *    exclusion makes an overlapping allocation on one room physically impossible (FR-4.3),
 *    so a clash is a clean 409 even under concurrency.
 *  - Reaching 35+ rooms for an event defers the whole batch to a Higher Authority
 *    exception — nothing is inserted until it is approved (BR-L2, FR-4.7).
 *  - Per-room discount caps: Rs.500 for most types, Rs.1,000 for suites (BR-D1). Over the
 *    cap is refused here (the milestone's contract); the combined-10% escalation is M7.
 *  - Lawn weddings prefer Palace (BR-L1); allocating a non-Palace room needs an override
 *    note.
 *
 * Locked events are guarded by the `room_allocations` DB trigger; the service blocks first
 * with a clean 409 (CLAUDE.md rule 6).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const PREFERRED_LAWN_UNIT = 'Palace' // BR-L1
const SUITE_TYPES = new Set(['suite', 'presidential_suite']) // BR-D1 higher cap
const ALLOCATABLE = new Set(['confirmed', 'in_progress', 'completed'])
const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])
const EXCLUSION_VIOLATION = '23P01'

/** Postgres SQLSTATE, unwrapping Drizzle's error wrapper (see confirm.ts pgCode). */
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

// ── Rooms board (availability grid) ──────────────────────────────────────────

export async function listUnits(): Promise<{ id: string; name: string; roomCount: number }[]> {
  const rows = (await db.execute(sql`
    SELECT u.id, u.name, count(r.id)::int AS "roomCount"
    FROM lodging_units u
    LEFT JOIN rooms r ON r.unit_id = u.id AND r.is_active
    GROUP BY u.id, u.name
    ORDER BY u.name
  `)) as unknown as { id: string; name: string; roomCount: number }[]
  return rows
}

export type BoardRoom = {
  id: string
  roomNo: string
  block: string | null
  roomType: string
  beds: number
  rackRatePaise: number
  allocations: { id: string; eventId: string; code: string; guestName: string; checkIn: string; checkOut: string }[]
}

/** A unit's rooms with any allocations overlapping [from, to). Drives the availability grid. */
export async function getRoomsBoard(
  unitId: string,
  from: string,
  to: string,
): Promise<{ unit: { id: string; name: string }; rooms: BoardRoom[] }> {
  const [unit] = await db
    .select({ id: schema.lodgingUnits.id, name: schema.lodgingUnits.name })
    .from(schema.lodgingUnits)
    .where(eq(schema.lodgingUnits.id, unitId))
    .limit(1)
  if (!unit) throw notFound('Lodging unit not found')

  const rooms = await db
    .select({
      id: schema.rooms.id,
      roomNo: schema.rooms.roomNo,
      block: schema.rooms.block,
      roomType: schema.rooms.roomType,
      beds: schema.rooms.beds,
      rackRatePaise: schema.rooms.rackRatePaise,
    })
    .from(schema.rooms)
    .where(and(eq(schema.rooms.unitId, unitId), eq(schema.rooms.isActive, true)))
    .orderBy(asc(schema.rooms.block), asc(schema.rooms.roomNo))

  // Allocations on this unit's rooms overlapping the window.
  const allocs = (await db.execute(sql`
    SELECT a.id, a.room_id AS "roomId", a.event_id AS "eventId", e.code, e.guest_name AS "guestName",
           lower(a.stay)::text AS "checkIn", upper(a.stay)::text AS "checkOut"
    FROM room_allocations a
    JOIN rooms r ON r.id = a.room_id
    JOIN events e ON e.id = a.event_id
    WHERE r.unit_id = ${unitId}
      AND a.stay && daterange(${from}::date, ${to}::date, '[)')
    ORDER BY lower(a.stay)
  `)) as unknown as {
    id: string; roomId: string; eventId: string; code: string; guestName: string; checkIn: string; checkOut: string
  }[]

  const byRoom = new Map<string, BoardRoom['allocations']>()
  for (const a of allocs) {
    const list = byRoom.get(a.roomId) ?? []
    list.push({ id: a.id, eventId: a.eventId, code: a.code, guestName: a.guestName, checkIn: a.checkIn, checkOut: a.checkOut })
    byRoom.set(a.roomId, list)
  }

  return {
    unit,
    rooms: rooms.map((r) => ({ ...r, allocations: byRoom.get(r.id) ?? [] })),
  }
}

// ── Lodging calendar (FR-4.x, Lodge Manager 30-day occupancy) ────────────────

/**
 * The Lodge Manager's day-by-day occupancy view: cumulative counts per lodging unit per
 * room category, never room numbers. Three states, because two would lie:
 *
 *   locked    — the event is locked/billed/closed. Red: settled, untouchable.
 *   confirmed — confirmed/in progress/completed but not yet locked. Amber: sold, still moving.
 *   pending   — sitting inside a pending 35+ exception (BR-L2). Amber too, and the reason
 *               this query bothers with `exceptions` at all: a deferred large allocation
 *               writes NOTHING to room_allocations, so a calendar reading only that table
 *               would paint rooms free while the Authority is still deciding, and the Lodge
 *               Manager would promise them twice over.
 *
 * Categories are read from the data, not hardcoded — the room-type list is still awaiting
 * the hotel's real inventory (see docs/SEED_ASSUMPTIONS.md), so whatever the seed holds is
 * what renders.
 */

const OCCUPIED_STATES = sql`('confirmed','in_progress','completed','locked','billed','closed')`

export type LodgingInventory = { unitId: string; unitName: string; roomType: string; total: number }
export type LodgingCell = {
  date: string
  unitId: string
  roomType: string
  locked: number
  confirmed: number
  pending: number
}
export type LodgingCalendar = {
  from: string
  to: string
  inventory: LodgingInventory[]
  occupancy: LodgingCell[]
}

/**
 * Active room counts per unit per category — the denominator for every "how many left".
 *
 * `scopeUnitId` narrows the read to one lodge. A Lodge Manager is responsible for exactly
 * one (client, 21 Jul 2026: "the palace lodge manager should see palace data only"), and
 * the inventory itself stays single and shared — only the read is filtered.
 */
async function getInventory(scopeUnitId?: string | null): Promise<LodgingInventory[]> {
  return (await db.execute(sql`
    SELECT u.id AS "unitId", u.name AS "unitName", r.room_type AS "roomType", count(*)::int AS total
    FROM lodging_units u
    JOIN rooms r ON r.unit_id = u.id AND r.is_active
    WHERE (${scopeUnitId ?? null}::uuid IS NULL OR u.id = ${scopeUnitId ?? null}::uuid)
    GROUP BY u.id, u.name, r.room_type
    ORDER BY u.name, r.room_type
  `)) as unknown as LodgingInventory[]
}

/**
 * Occupancy for every date in [from, to] — both ends inclusive, matching the venue board's
 * day list (note `/rooms/board` uses a half-open range instead; these are different shapes).
 * Only non-empty cells come back; the client fills the rest from `inventory`.
 */
export async function getLodgingCalendar(
  from: string,
  to: string,
  scopeUnitId?: string | null,
): Promise<LodgingCalendar> {
  const [inventory, occupancy] = await Promise.all([
    getInventory(scopeUnitId),
    db.execute(sql`
      WITH days AS (
        SELECT gs::date AS date
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS gs
      ),
      alloc AS (
        -- Rooms are taken in bulk on the proposal (client, 21 Jul 2026): lodge + category +
        -- count + dates IS the booking. Occupancy is therefore the sum of those counts, not
        -- a count of assigned rooms. Requirements with no unit (pre-21 Jul) are skipped
        -- rather than guessed at — see migration 0009.
        SELECT d.date, rr.unit_id AS "unitId", rr.room_type AS "roomType",
               COALESCE(sum(rr.count) FILTER (WHERE e.status IN ('locked','billed','closed')), 0)::int AS locked,
               COALESCE(sum(rr.count) FILTER (WHERE e.status IN ('confirmed','in_progress','completed')), 0)::int AS confirmed
        FROM days d
        JOIN room_requirements rr
          ON d.date >= rr.check_in AND d.date < rr.check_out AND rr.unit_id IS NOT NULL
         AND (${scopeUnitId ?? null}::uuid IS NULL OR rr.unit_id = ${scopeUnitId ?? null}::uuid)
        JOIN events e ON e.id = rr.event_id AND e.status IN ${OCCUPIED_STATES}
        GROUP BY 1, 2, 3
      )
      -- pending is always 0 now; the column stays so the calendar's three-state shape
      -- survives. It used to count rooms held inside an undecided 35+ exception, back when
      -- a deferred allocation wrote nothing and the calendar would otherwise paint them
      -- free. Requirements ARE the booking today and are saved whether or not the Authority
      -- has ruled, so alloc already carries them — counting them again here booked the same
      -- room twice. Enquiries hold nothing (client, 21 Jul 2026), which is what the status
      -- filter on alloc enforces.
      SELECT date::text AS date, "unitId", "roomType",
             locked, confirmed, 0 AS pending
      FROM alloc
      ORDER BY 1, 2, 3
    `) as unknown as Promise<LodgingCell[]>,
  ])
  return { from, to, inventory, occupancy }
}

export type LodgingHolder = {
  unitId: string
  roomType: string
  eventId: string
  code: string
  guestName: string
  status: string
  state: 'locked' | 'confirmed' | 'pending'
  count: number
}
export type LodgingDay = { date: string; inventory: LodgingInventory[]; holders: LodgingHolder[] }

/** One date drilled down: who holds how many of which category, and therefore what is left. */
export async function getLodgingDay(date: string, scopeUnitId?: string | null): Promise<LodgingDay> {
  const [inventory, holders] = await Promise.all([
    getInventory(scopeUnitId),
    db.execute(sql`
      SELECT rr.unit_id AS "unitId", rr.room_type AS "roomType", e.id AS "eventId", e.code,
             e.guest_name AS "guestName", e.status,
             CASE WHEN e.status IN ('locked','billed','closed') THEN 'locked' ELSE 'confirmed' END AS state,
             COALESCE(sum(rr.count), 0)::int AS count
      FROM room_requirements rr
      JOIN events e ON e.id = rr.event_id AND e.status IN ${OCCUPIED_STATES}
      WHERE rr.unit_id IS NOT NULL
        AND (${scopeUnitId ?? null}::uuid IS NULL OR rr.unit_id = ${scopeUnitId ?? null}::uuid)
        AND ${date}::date >= rr.check_in AND ${date}::date < rr.check_out
      GROUP BY 1, 2, 3, 4, 5, 6
      -- No 'pending' arm: see getLodgingCalendar. Requirements are saved whether or not a
      -- 35+ request has been decided, so the first arm already holds them.
      ORDER BY 1, 2, 5
    `) as unknown as Promise<LodgingHolder[]>,
  ])
  return { date, inventory, holders }
}


// ── Room availability — the hard inventory cap ───────────────────────────────

/**
 * How many rooms of a category a lodge actually has free over a date range (client,
 * 21 Jul 2026). This is a PHYSICAL ceiling and is not the same thing as BR-L2: the 35+
 * rule sends a large booking to the Authority, this one refuses a booking the hotel
 * cannot honour. They stack — 40 rooms when 27 exist is blocked outright; 36 rooms that
 * do exist is allowed but escalated.
 *
 * Measured per NIGHT and reported at the tightest one. A stay of 1-5 Jul where nights
 * 1-2 have 20 of 27 taken and night 3 has 25 has two rooms free, not seven: the binding
 * constraint is the worst night in the range, and quoting anything else would promise a
 * room that vanishes mid-stay.
 *
 * Enquiries hold nothing (client, same conversation): only committed events count against
 * the inventory, so two managers can both be drafting the same rooms and whoever confirms
 * first takes them. `excludeEventId` keeps an event from competing with its own existing
 * rows when its requirements are re-saved.
 */
export type AvailabilityRequest = {
  unitId: string
  roomType: string
  checkIn: string
  checkOut: string
}
export type AvailabilityLine = AvailabilityRequest & {
  total: number
  peakBooked: number
  available: number
}

export async function getRoomAvailability(
  requests: AvailabilityRequest[],
  excludeEventId?: string,
  exec: Pick<typeof db, 'execute'> = db,
): Promise<AvailabilityLine[]> {
  if (!requests.length) return []

  const values = sql.join(
    requests.map(
      (r, i) =>
        sql`(${i}::int, ${r.unitId}::uuid, ${r.roomType}::text, ${r.checkIn}::date, ${r.checkOut}::date)`,
    ),
    sql`, `,
  )

  const rows = (await exec.execute(sql`
    WITH req(idx, unit_id, room_type, check_in, check_out) AS (VALUES ${values}),
    -- One row per requested night. check_out is the morning of departure, so the last
    -- occupied night is check_out - 1.
    nights AS (
      SELECT q.idx, q.unit_id, q.room_type, gs::date AS d
      FROM req q, generate_series(q.check_in, q.check_out - 1, interval '1 day') gs
    ),
    taken AS (
      SELECT n.idx, n.unit_id, n.room_type, n.d,
             COALESCE(sum(rr.count), 0)::int AS booked
      FROM nights n
      LEFT JOIN room_requirements rr
        ON rr.unit_id = n.unit_id
       AND rr.room_type = n.room_type
       AND n.d >= rr.check_in AND n.d < rr.check_out
       AND (${excludeEventId ?? null}::uuid IS NULL OR rr.event_id <> ${excludeEventId ?? null}::uuid)
      LEFT JOIN events e ON e.id = rr.event_id
      -- rr.event_id IS NULL keeps nights nobody has booked; the status filter drops
      -- enquiries, which hold no inventory.
      WHERE rr.event_id IS NULL OR e.status IN ${OCCUPIED_STATES}
      GROUP BY 1, 2, 3, 4
    ),
    inv AS (
      SELECT unit_id, room_type, count(*)::int AS total
      FROM rooms WHERE is_active GROUP BY 1, 2
    )
    SELECT q.idx,
           q.unit_id::text  AS "unitId",
           q.room_type      AS "roomType",
           q.check_in::text  AS "checkIn",
           q.check_out::text AS "checkOut",
           COALESCE(inv.total, 0)                    AS total,
           COALESCE(max(t.booked), 0)::int           AS "peakBooked",
           GREATEST(COALESCE(inv.total, 0) - COALESCE(max(t.booked), 0), 0)::int AS available
    FROM req q
    LEFT JOIN inv ON inv.unit_id = q.unit_id AND inv.room_type = q.room_type
    LEFT JOIN taken t ON t.idx = q.idx
    GROUP BY q.idx, q.unit_id, q.room_type, q.check_in, q.check_out, inv.total
    ORDER BY q.idx
  `)) as unknown as (AvailabilityLine & { idx: number })[]

  // `idx` exists only to keep the VALUES list and the result rows in step.
  return rows.map((r) => ({
    unitId: r.unitId,
    roomType: r.roomType,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    total: Number(r.total),
    peakBooked: Number(r.peakBooked),
    available: Number(r.available),
  }))
}

/**
 * The window rooms may be held for: the event's declared run (its From/To), with check-out
 * reaching the morning after the To date. Both ends are what `saveRoomRequirements` enforces,
 * so the form can bound its date pickers to exactly the same thing rather than letting a
 * manager pick a date that will be refused on save.
 *
 * Prefers the declared window (`events.planned_from/planned_to`, client 22 Jul 2026) so a
 * guest may stay the whole event even when a function isn't on every day; falls back to the
 * functions' span for a proposal made before that window was captured. Never the
 * `events.first_date` cache — that is only written at confirm and is NULL mid-proposal.
 */
export async function getEventRoomWindow(
  eventId: string,
): Promise<{ firstDate: string | null; lastDate: string | null; latestCheckOut: string | null }> {
  const [row] = (await db.execute(sql`
    SELECT COALESCE(e.planned_from, min(se.event_date))::text      AS "firstDate",
           COALESCE(e.planned_to,   max(se.event_date))::text      AS "lastDate",
           (COALESCE(e.planned_to,  max(se.event_date)) + 1)::text AS "latestCheckOut"
    FROM events e
    LEFT JOIN sub_events se ON se.event_id = e.id
    WHERE e.id = ${eventId}
    GROUP BY e.id
  `)) as unknown as { firstDate: string | null; lastDate: string | null; latestCheckOut: string | null }[]
  return row ?? { firstDate: null, lastDate: null, latestCheckOut: null }
}

// ── Room shortfalls — proposals whose rooms have been taken ──────────────────

/**
 * Live proposals that can no longer be honoured (client, 21 Jul 2026).
 *
 * Enquiries hold no inventory, so two managers may both be drafting the same rooms and
 * whoever commits first takes them. The loser is not blocked in advance — they are TOLD, so
 * they can change the dates, the category or the lodge. This is the detection behind that
 * notification.
 *
 * The same query also catches a room being retired under a booking that was fine when it was
 * made, which is the case no save-time check can ever prevent.
 *
 * Reads live rather than being stored: a shortfall stops existing the moment the booking is
 * changed, and a notification that has to be cleaned up would outlive the problem.
 */
export type RoomShortfall = {
  /**
   * The `room_requirements` row. Nothing else about a shortfall is unique: a proposal may
   * legitimately hold two lines of the same category in the same lodge from the same
   * check-in, differing only in check-out, and no constraint forbids two identical lines.
   * The feed keys its entries on this.
   */
  requirementId: string
  eventId: string
  eventCode: string
  guestName: string
  status: string
  createdBy: string
  unitId: string
  unitName: string
  roomType: string
  checkIn: string
  checkOut: string
  promised: number
  available: number
  shortfall: number
}

export async function listRoomShortfalls(
  opts: { ownerId?: string; unitId?: string } = {},
): Promise<RoomShortfall[]> {
  return (await db.execute(sql`
    WITH live AS (
      SELECT rr.id, rr.event_id, rr.unit_id, rr.room_type, rr.count, rr.check_in, rr.check_out
      FROM room_requirements rr
      JOIN events e ON e.id = rr.event_id
      -- Locked and beyond is settled; cancelled is gone. Everything still moving is in scope,
      -- including enquiries — an enquiry is exactly who needs to hear that its rooms went.
      WHERE rr.unit_id IS NOT NULL
        AND e.status IN ('enquiry','confirmed','in_progress','completed')
        AND (${opts.ownerId ?? null}::uuid IS NULL OR e.created_by = ${opts.ownerId ?? null}::uuid)
        AND (${opts.unitId ?? null}::uuid  IS NULL OR rr.unit_id = ${opts.unitId ?? null}::uuid)
    ),
    nights AS (
      SELECT l.id, l.event_id, l.unit_id, l.room_type, gs::date AS d
      FROM live l, generate_series(l.check_in, l.check_out - 1, interval '1 day') gs
    ),
    taken AS (
      SELECT n.id, n.d, COALESCE(sum(o.count), 0)::int AS booked
      FROM nights n
      LEFT JOIN room_requirements o
        ON o.unit_id = n.unit_id AND o.room_type = n.room_type
       AND n.d >= o.check_in AND n.d < o.check_out
       AND o.event_id <> n.event_id
      LEFT JOIN events oe ON oe.id = o.event_id
      -- Only committed events take inventory; an enquiry competing for the same rooms is
      -- not yet a reason to tell anyone anything.
      WHERE o.event_id IS NULL OR oe.status IN ${OCCUPIED_STATES}
      GROUP BY n.id, n.d
    ),
    inv AS (
      SELECT unit_id, room_type, count(*)::int AS total
      FROM rooms WHERE is_active GROUP BY 1, 2
    )
    SELECT l.id::text AS "requirementId",
           l.event_id::text AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
           e.status::text AS status, e.created_by::text AS "createdBy",
           l.unit_id::text AS "unitId", u.name AS "unitName", l.room_type AS "roomType",
           l.check_in::text AS "checkIn", l.check_out::text AS "checkOut",
           l.count::int AS promised,
           GREATEST(COALESCE(inv.total, 0) - COALESCE(max(t.booked), 0), 0)::int AS available,
           (l.count - GREATEST(COALESCE(inv.total, 0) - COALESCE(max(t.booked), 0), 0))::int AS shortfall
    FROM live l
    JOIN events e ON e.id = l.event_id
    JOIN lodging_units u ON u.id = l.unit_id
    LEFT JOIN inv ON inv.unit_id = l.unit_id AND inv.room_type = l.room_type
    LEFT JOIN taken t ON t.id = l.id
    GROUP BY l.id, l.event_id, e.code, e.guest_name, e.status, e.created_by,
             l.unit_id, u.name, l.room_type, l.check_in, l.check_out, l.count, inv.total
    HAVING l.count > GREATEST(COALESCE(inv.total, 0) - COALESCE(max(t.booked), 0), 0)
    ORDER BY e.code, u.name, l.room_type
  `)) as unknown as RoomShortfall[]
}

// ── Bulk room booking on the proposal (BR-L2) ────────────────────────────────

export type RoomRequirementInput = {
  unitId: string
  roomType: string
  count: number
  checkIn: string
  checkOut: string
}
export type SaveRequirementsResult = { lines: number; totalRooms: number; deferred: boolean }

/**
 * Replaces an event's room requirements. Rooms are taken in bulk here — lodge + category
 * + count + dates IS the booking (client, 21 Jul 2026) — and this is what the lodging
 * calendar reads. Editable until the event locks, because lodging keeps changing after a
 * booking is confirmed.
 *
 * BR-L2, rewired the same day: the 35+ rule used to count rows in `room_allocations`, which
 * nothing writes any more. It now counts the rooms asked for, and raises ONE pending request
 * per proposal listing every line, so the Authority tracks proposals rather than lines.
 *
 * The requirements are still saved when the threshold is crossed. Confirm refuses while the
 * request is pending (lib/confirm.ts), and for an already-confirmed event the lock
 * checklist does the same — it blocks on any pending approval. Saving a smaller set clears
 * the request, because the reason for it is gone.
 */
export async function saveRoomRequirements(
  actor: Actor,
  eventId: string,
  requirements: RoomRequirementInput[],
): Promise<SaveRequirementsResult> {
  const { large_allocation_rooms } = await getIntSettings(
    ['large_allocation_rooms'] as const,
    { large_allocation_rooms: 35 },
  )

  return db.transaction(async (tx) => {
    const [event] = await tx
      .select({ status: schema.events.status })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1)
    if (!event) throw notFound('Event not found')
    // Rooms stay editable after confirmation (client, 21 Jul 2026: "old proposal can be
    // updated with rooms and all"). A guest's lodging changes right up to the event, and
    // the proposal is the only place rooms are recorded now. Locked is still locked.
    if (LOCKED_STATES.has(event.status)) {
      throw conflict('This event is locked — its rooms can no longer be changed.')
    }
    if (event.status === 'cancelled') {
      throw badRequest('This event is cancelled.')
    }

    if (requirements.length) {
      // Rooms are bounded by the event's declared run (client, 22 Jul 2026): the From/To
      // captured at the top of the wizard and stored on the event, so a guest may stay the
      // whole event even when a function isn't on every day. Falls back to the functions'
      // span for a proposal made before that window was captured. Never the
      // events.first_date/last_date cache, which is only written at confirm.
      const [span] = (await tx.execute(sql`
        SELECT COALESCE(e.planned_from, min(se.event_date))::text AS "firstDate",
               COALESCE(e.planned_to,   max(se.event_date))::text AS "lastDate"
        FROM events e
        LEFT JOIN sub_events se ON se.event_id = e.id
        WHERE e.id = ${eventId}
        GROUP BY e.id
      `)) as unknown as { firstDate: string | null; lastDate: string | null }[]

      if (span?.firstDate && span.lastDate) {
        // Departure is the morning after the last function, so check-out may reach one
        // day past the event's last date.
        const latestCheckOut = new Date(`${span.lastDate}T00:00:00Z`)
        latestCheckOut.setUTCDate(latestCheckOut.getUTCDate() + 1)
        const maxOut = latestCheckOut.toISOString().slice(0, 10)

        for (const r of requirements) {
          if (r.checkIn < span.firstDate) {
            throw badRequest(
              `Check-in ${r.checkIn} is before the event starts on ${span.firstDate}.`,
            )
          }
          if (r.checkOut > maxOut) {
            throw badRequest(
              `Check-out ${r.checkOut} is after the event ends on ${span.lastDate} — the latest is ${maxOut}.`,
            )
          }
        }
      }

      // The hard inventory cap. Runs inside this transaction so the count it reads is the
      // one the insert lands against.
      const availability = await getRoomAvailability(requirements, eventId, tx)
      const over = requirements
        .map((r, i) => ({ r, a: availability[i]! }))
        .filter(({ r, a }) => r.count > a.available)
      if (over.length) {
        const detail = over
          .map(
            ({ r, a }) =>
              `${r.count} × ${r.roomType} (only ${a.available} of ${a.total} free ${r.checkIn}–${r.checkOut})`,
          )
          .join('; ')
        throw conflict(`More rooms than the lodge has free — ${detail}.`)
      }
    }

    await tx.delete(schema.roomRequirements).where(eq(schema.roomRequirements.eventId, eventId))
    if (requirements.length) {
      await tx.insert(schema.roomRequirements).values(
        requirements.map((r) => ({
          eventId,
          unitId: r.unitId,
          roomType: r.roomType,
          count: r.count,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
        })),
      )
    }

    await tx.delete(schema.exceptions).where(
      and(
        eq(schema.exceptions.eventId, eventId),
        eq(schema.exceptions.kind, 'room_allocation_35plus'),
        eq(schema.exceptions.status, 'pending'),
      ),
    )

    const totalRooms = requirements.reduce((n, r) => n + r.count, 0)
    const deferred = totalRooms >= large_allocation_rooms
    if (deferred) {
      const [exc] = await tx
        .insert(schema.exceptions)
        .values({
          eventId,
          kind: 'room_allocation_35plus',
          status: 'pending',
          payload: {
            requestedCount: totalRooms,
            threshold: large_allocation_rooms,
            lines: requirements.map((r) => ({
              unitId: r.unitId,
              roomType: r.roomType,
              count: r.count,
              checkIn: r.checkIn,
              checkOut: r.checkOut,
            })),
          },
          raisedBy: actor.id,
        })
        .returning({ id: schema.exceptions.id })
      await audit(tx, actor, {
        entity: 'exceptions',
        entityId: exc!.id,
        eventId,
        action: 'insert',
        field: 'room_allocation_35plus',
        newValue: `${totalRooms} room(s) across ${requirements.length} line(s)`,
      })
    }

    await audit(tx, actor, {
      entity: 'room_requirements',
      entityId: eventId,
      eventId,
      action: 'update',
      field: 'requirements',
      newValue: `${requirements.length} line(s), ${totalRooms} room(s)`,
    })

    return { lines: requirements.length, totalRooms, deferred }
  })
}

/** An event's booked rooms, in the shape the proposal and the event panel both edit. */
export async function listRoomRequirements(eventId: string): Promise<
  { unit_id: string; room_type: string; count: number; check_in: string; check_out: string }[]
> {
  return (await db.execute(sql`
    SELECT rr.unit_id AS unit_id, rr.room_type AS room_type, rr.count::int AS count,
           rr.check_in::text AS check_in, rr.check_out::text AS check_out
    FROM room_requirements rr
    WHERE rr.event_id = ${eventId}
    ORDER BY rr.check_in, rr.room_type
  `)) as unknown as { unit_id: string; room_type: string; count: number; check_in: string; check_out: string }[]
}

// ── Allocation ───────────────────────────────────────────────────────────────

export type AllocationInput = {
  roomId: string
  checkIn: string
  checkOut: string
  ratePaise?: number // defaults to the room's rack rate
  discountPaise?: number
  overrideNote?: string
}

export type AllocateResult =
  | { deferred: false; allocated: number }
  | { deferred: true; exceptionId: string; count: number }

type EventCtx = { id: string; status: string; eventType: string; isWedding: boolean; hasLawn: boolean }

async function loadEventCtx(tx: Tx, eventId: string): Promise<EventCtx> {
  const [row] = (await tx.execute(sql`
    SELECT e.id, e.status, e.event_type AS "eventType", et.is_wedding AS "isWedding",
           EXISTS (
             SELECT 1 FROM sub_events se JOIN venues v ON v.id = se.venue_id
             WHERE se.event_id = e.id AND v.kind = 'lawn'
           ) AS "hasLawn"
    FROM events e JOIN event_types et ON et.code = e.event_type
    WHERE e.id = ${eventId}
  `)) as unknown as EventCtx[]
  if (!row) throw notFound('Event not found')
  return row
}

/**
 * Allocates rooms to an event (FR-4.2). Validates every line first (room exists, discount
 * within the per-room cap, lawn-wedding override note), then either inserts the batch or,
 * if the event's total rooms would reach the large-allocation threshold, defers the whole
 * batch to a Higher Authority exception (BR-L2). Overlaps are caught by the DB exclusion.
 */
export async function allocateRooms(
  actor: Actor,
  eventId: string,
  allocations: AllocationInput[],
): Promise<AllocateResult> {
  if (allocations.length === 0) throw badRequest('Select at least one room to allocate')

  const caps = await getIntSettings(
    ['room_discount_cap_paise', 'suite_discount_cap_paise', 'large_allocation_rooms'] as const,
    { room_discount_cap_paise: 50000, suite_discount_cap_paise: 100000, large_allocation_rooms: 35 },
  )

  try {
    return await db.transaction(async (tx) => {
      const ev = await loadEventCtx(tx, eventId)
      if (LOCKED_STATES.has(ev.status)) throw conflict('This event is locked — rooms can no longer be changed.')
      if (!ALLOCATABLE.has(ev.status)) {
        throw badRequest('Rooms can be allocated once the booking is confirmed.')
      }

      // Resolve and validate each requested room.
      type Prepared = AllocationInput & { ratePaise: number; roomType: string; unitName: string; roomNo: string }
      const prepared: Prepared[] = []
      for (const a of allocations) {
        if (a.checkOut <= a.checkIn) throw badRequest(`Check-out must be after check-in for room stay ${a.checkIn}→${a.checkOut}`)
        const [room] = (await tx.execute(sql`
          SELECT r.room_type AS "roomType", r.room_no AS "roomNo", r.rack_rate_paise AS "rackRatePaise", u.name AS "unitName"
          FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
          WHERE r.id = ${a.roomId} AND r.is_active
        `)) as unknown as { roomType: string; roomNo: string; rackRatePaise: number; unitName: string }[]
        if (!room) throw badRequest('Unknown or inactive room in the allocation')

        const ratePaise = a.ratePaise ?? room.rackRatePaise
        if (ratePaise < 0) throw badRequest('Room rate cannot be negative')

        // BR-D1: per-room discount cap by type.
        const discount = a.discountPaise ?? 0
        if (discount < 0) throw badRequest('Discount cannot be negative')
        const cap = SUITE_TYPES.has(room.roomType) ? caps.suite_discount_cap_paise : caps.room_discount_cap_paise
        if (discount > cap) {
          throw badRequest(
            `A discount of ₹${(discount / 100).toLocaleString('en-IN')} exceeds the ₹${(cap / 100).toLocaleString('en-IN')} cap for a ${room.roomType.replace(/_/g, ' ')} (BR-D1).`,
          )
        }

        // BR-L1: lawn weddings prefer Palace; a non-Palace room needs an override note.
        if (ev.isWedding && ev.hasLawn && room.unitName !== PREFERRED_LAWN_UNIT && !a.overrideNote?.trim()) {
          throw badRequest(
            `Room ${room.roomNo} is in ${room.unitName}, not the preferred ${PREFERRED_LAWN_UNIT} for a lawn wedding. Add an override note to proceed (BR-L1).`,
          )
        }

        prepared.push({ ...a, ratePaise, discountPaise: discount, roomType: room.roomType, unitName: room.unitName, roomNo: room.roomNo })
      }

      // BR-L2: if the event's total rooms would reach the threshold, defer the whole batch.
      const [{ existing }] = (await tx.execute(sql`
        SELECT count(*)::int AS existing FROM room_allocations WHERE event_id = ${eventId}
      `)) as unknown as { existing: number }[]
      if (existing + prepared.length >= caps.large_allocation_rooms) {
        const [exc] = await tx
          .insert(schema.exceptions)
          .values({
            eventId,
            kind: 'room_allocation_35plus',
            status: 'pending',
            payload: {
              allocations: prepared.map((p) => ({
                roomId: p.roomId,
                checkIn: p.checkIn,
                checkOut: p.checkOut,
                ratePaise: p.ratePaise,
                discountPaise: p.discountPaise,
                overrideNote: p.overrideNote ?? null,
              })),
              requestedCount: prepared.length,
              existingCount: existing,
              threshold: caps.large_allocation_rooms,
            },
            raisedBy: actor.id,
          })
          .returning({ id: schema.exceptions.id })

        await audit(tx, actor, {
          entity: 'exceptions',
          entityId: exc!.id,
          eventId,
          action: 'insert',
          field: 'room_allocation_35plus',
          newValue: `${prepared.length} room(s), total ${existing + prepared.length}`,
        })
        return { deferred: true, exceptionId: exc!.id, count: prepared.length }
      }

      // Under the threshold: insert now in one statement; the exclusion constraint decides
      // overlaps for every row (against existing rows and each other).
      await tx.execute(sql`
        INSERT INTO room_allocations (event_id, room_id, stay, rate_paise, discount_paise, override_note, allocated_by)
        VALUES ${sql.join(
          prepared.map(
            (p) => sql`(${eventId}, ${p.roomId},
                        daterange(${p.checkIn}::date, ${p.checkOut}::date, '[)'),
                        ${p.ratePaise}, ${p.discountPaise}, ${p.overrideNote ?? null}, ${actor.id})`,
          ),
          sql`, `,
        )}
      `)
      await audit(
        tx,
        actor,
        prepared.map((p) => ({
          entity: 'room_allocations',
          eventId,
          action: 'insert' as const,
          field: 'room',
          newValue: `${p.unitName} ${p.roomNo} ${p.checkIn}→${p.checkOut}`,
        })),
      )
      return { deferred: false, allocated: prepared.length }
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict('One or more of these rooms is already allocated to another event for overlapping dates.')
    }
    throw err
  }
}

/** Removes an allocation (un-assign a room). */
export async function deallocateRoom(actor: Actor, allocationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = (await tx.execute(sql`
      SELECT a.event_id AS "eventId", e.status, r.room_no AS "roomNo"
      FROM room_allocations a JOIN events e ON e.id = a.event_id JOIN rooms r ON r.id = a.room_id
      WHERE a.id = ${allocationId}
    `)) as unknown as { eventId: string; status: string; roomNo: string }[]
    if (!row) throw notFound('Allocation not found')
    if (LOCKED_STATES.has(row.status)) throw conflict('This event is locked — rooms can no longer be changed.')

    await tx.delete(schema.roomAllocations).where(eq(schema.roomAllocations.id, allocationId))
    await audit(tx, actor, {
      entity: 'room_allocations',
      entityId: allocationId,
      eventId: row.eventId,
      action: 'delete',
      field: 'room',
      oldValue: row.roomNo,
    })
  })
}

// ── Reconciliation (FR-4.5) ──────────────────────────────────────────────────

export type ReconciliationLine = {
  unitId: string
  unitName: string
  roomType: string
  checkIn: string
  checkOut: string
  /** What the proposal sold. */
  promised: number
  /** Active rooms of this category in this lodge. */
  capacity: number
  /** Peak held by OTHER committed events over these nights. */
  takenByOthers: number
  /** capacity - takenByOthers: what is actually left for this event. */
  available: number
  /** How many of `promised` cannot be honoured. Zero is the goal. */
  shortfall: number
}
export type Reconciliation = {
  lines: ReconciliationLine[]
  totals: { promised: number; shortfall: number }
  /** Every line can be honoured — what the Lodge Manager's sign-off attests to. */
  deliverable: boolean
}


/**
 * Promised (room requirements) vs allocated (assigned rooms) vs occupied (allocations whose
 * stay covers today), per room type, with the variance the Lodge Manager must resolve
 * before their lock sign-off (FR-4.5).
 */
/**
 * Can the lodge actually deliver what the proposal sold? (FR-4.5, rewritten 21 Jul 2026.)
 *
 * It used to compare `room_requirements` against `room_allocations` — promised vs assigned.
 * Rooms stopped being assigned room-by-room when booking moved onto the proposal (migration
 * 0009), so nothing has written an allocation since: every event reported `allocated = 0`
 * and a variance of `-promised`, which is the one answer that is never informative. The
 * Lodge Manager's sign-off blocks the lock, and it was being asked to confirm a number that
 * was wrong by construction.
 *
 * The useful question under bulk booking is deliverability. The hard cap already stops an
 * overbooking at save time; this re-asks at lock, when the answer can have changed — another
 * event confirmed over the same nights, or rooms were deactivated. Measured against the
 * tightest night of each stay, and excluding this event so it never competes with itself.
 */
export async function getReconciliation(eventId: string): Promise<Reconciliation> {
  const [ev] = await db.select({ id: schema.events.id }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1)
  if (!ev) throw notFound('Event not found')

  const reqs = (await db.execute(sql`
    SELECT rr.unit_id AS "unitId", COALESCE(u.name, 'Unassigned lodge') AS "unitName",
           rr.room_type AS "roomType", rr.count::int AS promised,
           rr.check_in::text AS "checkIn", rr.check_out::text AS "checkOut"
    FROM room_requirements rr
    LEFT JOIN lodging_units u ON u.id = rr.unit_id
    WHERE rr.event_id = ${eventId}
    ORDER BY u.name, rr.room_type, rr.check_in
  `)) as unknown as {
    unitId: string | null; unitName: string; roomType: string
    promised: number; checkIn: string; checkOut: string
  }[]

  // Rows captured before migration 0009 carry no lodge and cannot be measured against one.
  // They are reported with a zero capacity rather than silently attributed somewhere.
  const measurable = reqs.filter((r) => r.unitId != null)
  const availability = await getRoomAvailability(
    measurable.map((r) => ({ unitId: r.unitId!, roomType: r.roomType, checkIn: r.checkIn, checkOut: r.checkOut })),
    eventId,
  )
  const availByIdx = new Map(measurable.map((r, i) => [r, availability[i]!]))

  const lines: ReconciliationLine[] = reqs.map((r) => {
    const a = availByIdx.get(r)
    const capacity = a?.total ?? 0
    const takenByOthers = a?.peakBooked ?? 0
    const available = a?.available ?? 0
    return {
      unitId: r.unitId ?? '',
      unitName: r.unitName,
      roomType: r.roomType,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      promised: r.promised,
      capacity,
      takenByOthers,
      available,
      shortfall: Math.max(0, r.promised - available),
    }
  })

  const totals = lines.reduce(
    (acc, l) => ({ promised: acc.promised + l.promised, shortfall: acc.shortfall + l.shortfall }),
    { promised: 0, shortfall: 0 },
  )
  return { lines, totals, deliverable: totals.shortfall === 0 }
}

