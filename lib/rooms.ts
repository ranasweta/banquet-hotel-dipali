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

/** Active room counts per unit per category — the denominator for every "how many left". */
async function getInventory(): Promise<LodgingInventory[]> {
  return (await db.execute(sql`
    SELECT u.id AS "unitId", u.name AS "unitName", r.room_type AS "roomType", count(*)::int AS total
    FROM lodging_units u
    JOIN rooms r ON r.unit_id = u.id AND r.is_active
    GROUP BY u.id, u.name, r.room_type
    ORDER BY u.name, r.room_type
  `)) as unknown as LodgingInventory[]
}

/**
 * Occupancy for every date in [from, to] — both ends inclusive, matching the venue board's
 * day list (note `/rooms/board` uses a half-open range instead; these are different shapes).
 * Only non-empty cells come back; the client fills the rest from `inventory`.
 */
export async function getLodgingCalendar(from: string, to: string): Promise<LodgingCalendar> {
  const [inventory, occupancy] = await Promise.all([
    getInventory(),
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
        JOIN events e ON e.id = rr.event_id AND e.status IN ${OCCUPIED_STATES}
        GROUP BY 1, 2, 3
      ),
      pend AS (
        SELECT d.date, r.unit_id AS "unitId", r.room_type AS "roomType", count(*)::int AS pending
        FROM exceptions x
        JOIN events e ON e.id = x.event_id AND e.status IN ${OCCUPIED_STATES}
        CROSS JOIN LATERAL jsonb_array_elements(x.payload->'allocations') AS el
        JOIN rooms r ON r.id = (el->>'roomId')::uuid AND r.is_active
        JOIN days d ON d.date >= (el->>'checkIn')::date AND d.date < (el->>'checkOut')::date
        WHERE x.kind = 'room_allocation_35plus' AND x.status = 'pending'
        GROUP BY 1, 2, 3
      )
      SELECT date::text AS date, "unitId", "roomType",
             sum(locked)::int AS locked, sum(confirmed)::int AS confirmed, sum(pending)::int AS pending
      FROM (
        SELECT date, "unitId", "roomType", locked, confirmed, 0 AS pending FROM alloc
        UNION ALL
        SELECT date, "unitId", "roomType", 0, 0, pending FROM pend
      ) t
      GROUP BY 1, 2, 3
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
export async function getLodgingDay(date: string): Promise<LodgingDay> {
  const [inventory, holders] = await Promise.all([
    getInventory(),
    db.execute(sql`
      SELECT rr.unit_id AS "unitId", rr.room_type AS "roomType", e.id AS "eventId", e.code,
             e.guest_name AS "guestName", e.status,
             CASE WHEN e.status IN ('locked','billed','closed') THEN 'locked' ELSE 'confirmed' END AS state,
             COALESCE(sum(rr.count), 0)::int AS count
      FROM room_requirements rr
      JOIN events e ON e.id = rr.event_id AND e.status IN ${OCCUPIED_STATES}
      WHERE rr.unit_id IS NOT NULL
        AND ${date}::date >= rr.check_in AND ${date}::date < rr.check_out
      GROUP BY 1, 2, 3, 4, 5, 6

      UNION ALL

      SELECT r.unit_id, r.room_type, e.id, e.code, e.guest_name, e.status, 'pending', count(*)::int
      FROM exceptions x
      JOIN events e ON e.id = x.event_id AND e.status IN ${OCCUPIED_STATES}
      CROSS JOIN LATERAL jsonb_array_elements(x.payload->'allocations') AS el
      JOIN rooms r ON r.id = (el->>'roomId')::uuid AND r.is_active
      WHERE x.kind = 'room_allocation_35plus' AND x.status = 'pending'
        AND ${date}::date >= (el->>'checkIn')::date
        AND ${date}::date <  (el->>'checkOut')::date
      GROUP BY 1, 2, 3, 4, 5, 6

      ORDER BY 1, 2, 5
    `) as unknown as Promise<LodgingHolder[]>,
  ])
  return { date, inventory, holders }
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
 * Replaces an enquiry's room requirements. Rooms are taken in bulk here — lodge + category
 * + count + dates IS the booking (client, 21 Jul 2026) — and this is what the lodging
 * calendar reads.
 *
 * BR-L2, rewired the same day: the 35+ rule used to count rows in `room_allocations`, which
 * nothing writes any more. It now counts the rooms asked for, and raises ONE pending request
 * per proposal listing every line, so the Authority tracks proposals rather than lines.
 *
 * The requirements are still saved when the threshold is crossed. An enquiry occupies
 * nothing — the calendar counts confirmed events only — so the gate that matters is
 * CONFIRM, which refuses while the request is pending (see lib/confirm.ts). Saving a
 * smaller set clears the pending request, because the reason for it is gone.
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
    if (event.status !== 'enquiry') {
      throw badRequest('Room requirements can only be set on an enquiry')
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

export type Reconciliation = {
  byType: { roomType: string; promised: number; allocated: number; occupied: number; variance: number }[]
  totals: { promised: number; allocated: number; occupied: number; variance: number }
  allocations: {
    id: string; roomNo: string; unitName: string; roomType: string
    checkIn: string; checkOut: string; ratePaise: number; discountPaise: number; overrideNote: string | null
  }[]
}

/**
 * Promised (room requirements) vs allocated (assigned rooms) vs occupied (allocations whose
 * stay covers today), per room type, with the variance the Lodge Manager must resolve
 * before their lock sign-off (FR-4.5).
 */
export async function getReconciliation(eventId: string): Promise<Reconciliation> {
  const [ev] = await db.select({ id: schema.events.id }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1)
  if (!ev) throw notFound('Event not found')

  const promised = (await db.execute(sql`
    SELECT room_type AS "roomType", COALESCE(sum(count), 0)::int AS n
    FROM room_requirements WHERE event_id = ${eventId} GROUP BY room_type
  `)) as unknown as { roomType: string; n: number }[]

  const allocated = (await db.execute(sql`
    SELECT r.room_type AS "roomType",
           count(*)::int AS n,
           count(*) FILTER (WHERE a.stay @> CURRENT_DATE)::int AS occupied
    FROM room_allocations a JOIN rooms r ON r.id = a.room_id
    WHERE a.event_id = ${eventId} GROUP BY r.room_type
  `)) as unknown as { roomType: string; n: number; occupied: number }[]

  const list = (await db.execute(sql`
    SELECT a.id, r.room_no AS "roomNo", u.name AS "unitName", r.room_type AS "roomType",
           lower(a.stay)::text AS "checkIn", upper(a.stay)::text AS "checkOut",
           a.rate_paise AS "ratePaise", a.discount_paise AS "discountPaise", a.override_note AS "overrideNote"
    FROM room_allocations a JOIN rooms r ON r.id = a.room_id JOIN lodging_units u ON u.id = r.unit_id
    WHERE a.event_id = ${eventId}
    ORDER BY u.name, r.room_no
  `)) as unknown as Reconciliation['allocations']

  const types = new Set<string>([...promised.map((p) => p.roomType), ...allocated.map((a) => a.roomType)])
  const pMap = new Map(promised.map((p) => [p.roomType, p.n]))
  const aMap = new Map(allocated.map((a) => [a.roomType, a]))
  const byType = [...types].sort().map((t) => {
    const p = pMap.get(t) ?? 0
    const a = aMap.get(t)
    const alloc = a?.n ?? 0
    const occ = a?.occupied ?? 0
    return { roomType: t, promised: p, allocated: alloc, occupied: occ, variance: alloc - p }
  })
  const totals = byType.reduce(
    (acc, r) => ({
      promised: acc.promised + r.promised,
      allocated: acc.allocated + r.allocated,
      occupied: acc.occupied + r.occupied,
      variance: acc.variance + r.variance,
    }),
    { promised: 0, allocated: 0, occupied: 0, variance: 0 },
  )
  return { byType, totals, allocations: list }
}
