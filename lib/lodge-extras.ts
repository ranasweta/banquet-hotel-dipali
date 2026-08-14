import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { assertPaise } from '@/lib/money'
import { ROOM_GST_BP } from '@/lib/tax'

/**
 * The Lodge Manager's extras (client, 15 Aug 2026) — what the desk gave out during the event
 * and has been carrying on paper because the system had nowhere to put it.
 *
 *  - **Extra rooms** (`additional_rooms`): a party arrives bigger than it was booked and gets
 *    rooms out of whatever is free. Category, count and nights, priced from the lodge's rate
 *    for that category and SNAPSHOTTED at entry (rule 4) — re-pricing the lodge master
 *    tomorrow must not move a figure the guest was shown at checkout. They bill as `rooms`
 *    lines, so they carry the 5% the hotel actually collects.
 *  - **In-room dining** (`lodge_extras.in_room_dining_paise`): one rupee total for the whole
 *    stay. The kitchen's dockets are the itemisation; this is the figure the desk has. It
 *    bills as a `food` line — 18%, printed and collected from nobody (rule 11).
 *
 * WHY NOT EDIT THE BOOKING'S ROOMS. `room_requirements` is what was SOLD, frozen at its
 * confirmed rate (migration 0032), and it is the base of the 25% advance and the wedding 50%.
 * Adding four rooms to it in September would raise a threshold that fell due in June and make
 * a met milestone retrospectively short — the failure CLAUDE.md rule 12 describes for
 * maintenance, which is why maintenance sits outside the pre-event base. These sit beside it.
 *
 * THE CLOSE. Nothing here reaches the money until the Lodge Manager closes the log, exactly as
 * maintenance does (FR-5.2/5.3): an open log is still being typed, and a balance that moves
 * under the guest is worse than a late one. The close is one timestamp over both kinds, so the
 * bill, the proposal and the payable can never disagree about which of them counts.
 */

const OPEN_STATES = new Set(['in_progress', 'completed'])

type EventState = { status: string; closed: boolean }

async function loadEventState(exec: typeof db, eventId: string): Promise<EventState> {
  const [row] = (await exec.execute(sql`
    SELECT e.status::text AS status,
           EXISTS (SELECT 1 FROM lodge_extras x WHERE x.event_id = e.id AND x.closed_at IS NOT NULL) AS closed
    FROM events e WHERE e.id = ${eventId}
  `)) as unknown as EventState[]
  if (!row) throw notFound('Event not found')
  return row
}

/** Extras are writable only while In Progress / Completed, and only before the log is closed. */
function assertWritable(state: EventState): void {
  if (!OPEN_STATES.has(state.status)) {
    throw badRequest('Lodge extras can be logged only while an event is In Progress or Completed.')
  }
  if (state.closed) throw conflict('Lodge extras for this event are closed and can no longer change.')
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Ensures the event's `lodge_extras` row exists and stamps who touched it.
 *
 * The row is created on first use rather than with the event: most bookings never take an
 * extra, and a table of empty rows is a table nobody can read at a glance.
 */
async function touchHeader(tx: Tx, actor: Actor, eventId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO lodge_extras (event_id, updated_by) VALUES (${eventId}, ${actor.id})
    ON CONFLICT (event_id) DO UPDATE SET updated_by = ${actor.id}, updated_at = now()
  `)
}

// ── Extra rooms ──────────────────────────────────────────────────────────────

export type AdditionalRoomInput = {
  unitId: string
  roomType: string
  count: number
  nights: number
  remarks?: string
}

/**
 * Adds a line of extra rooms, priced at the lodge's rate for that category.
 *
 * The rate is looked up here and stored, never read live afterwards. A category the lodge has
 * no active room of is REFUSED rather than priced at zero — a missing rate is a gate, never a
 * zero (docs/SEED_ASSUMPTIONS.md), and zero here would give the rooms away silently.
 */
export async function addRoomLine(
  actor: Actor,
  eventId: string,
  input: AdditionalRoomInput,
): Promise<{ id: string; amountPaise: number }> {
  if (!Number.isInteger(input.count) || input.count < 1) throw badRequest('Enter at least one room.')
  if (!Number.isInteger(input.nights) || input.nights < 1) throw badRequest('Enter at least one night.')

  return db.transaction(async (tx) => {
    assertWritable(await loadEventState(tx, eventId))

    const [rate] = (await tx.execute(sql`
      SELECT min(r.rack_rate_paise)::bigint AS "ratePaise", u.name AS "unitName"
      FROM lodging_units u
      LEFT JOIN rooms r ON r.unit_id = u.id AND r.room_type = ${input.roomType} AND r.is_active
      WHERE u.id = ${input.unitId}
      GROUP BY u.name
    `)) as unknown as { ratePaise: number | null; unitName: string }[]
    if (!rate) throw notFound('Lodge not found')
    if (rate.ratePaise === null || Number(rate.ratePaise) <= 0) {
      throw badRequest(
        `${rate.unitName} has no priced ${input.roomType.replace(/_/g, ' ')} room — add the category in the lodge master first.`,
      )
    }

    const ratePaise = Number(rate.ratePaise)
    const amountPaise = input.count * input.nights * ratePaise
    const [row] = await tx
      .insert(schema.additionalRooms)
      .values({
        eventId,
        unitId: input.unitId,
        roomType: input.roomType,
        count: input.count,
        nights: input.nights,
        ratePaise,
        amountPaise,
        remarks: input.remarks?.trim() || null,
        createdBy: actor.id,
      })
      .returning({ id: schema.additionalRooms.id })

    await touchHeader(tx, actor, eventId)
    await audit(tx, actor, {
      entity: 'additional_rooms', entityId: row!.id, eventId, action: 'insert', field: 'rooms',
      newValue: `${rate.unitName} ${input.roomType} × ${input.count} × ${input.nights} night(s) @ ${ratePaise} = ${amountPaise}`,
    })
    return { id: row!.id, amountPaise }
  })
}

export async function removeRoomLine(actor: Actor, lineId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(schema.additionalRooms)
      .where(eq(schema.additionalRooms.id, lineId))
      .limit(1)
    if (!line) throw notFound('Extra room line not found')
    assertWritable(await loadEventState(tx, line.eventId))

    await tx.delete(schema.additionalRooms).where(eq(schema.additionalRooms.id, lineId))
    await touchHeader(tx, actor, line.eventId)
    await audit(tx, actor, {
      entity: 'additional_rooms', entityId: lineId, eventId: line.eventId, action: 'delete', field: 'rooms',
      oldValue: `${line.roomType} × ${line.count} × ${line.nights} night(s) = ${line.amountPaise}`,
    })
  })
}

// ── In-room dining ───────────────────────────────────────────────────────────

/**
 * Sets the event's in-room dining total. One box, overwritten as it grows (client's choice,
 * 15 Aug 2026) — the audit trail carries the old figure, so what it was made of is still
 * answerable even though the column holds only the latest.
 */
export async function setInRoomDining(actor: Actor, eventId: string, amountPaise: number): Promise<void> {
  assertPaise(amountPaise)
  if (amountPaise < 0) throw badRequest('In-room dining cannot be negative.')

  await db.transaction(async (tx) => {
    assertWritable(await loadEventState(tx, eventId))
    const [before] = (await tx.execute(sql`
      SELECT in_room_dining_paise AS "amountPaise" FROM lodge_extras WHERE event_id = ${eventId}
    `)) as unknown as { amountPaise: number }[]
    const oldPaise = before ? Number(before.amountPaise) : 0
    if (oldPaise === amountPaise) return

    await tx.execute(sql`
      INSERT INTO lodge_extras (event_id, in_room_dining_paise, updated_by)
      VALUES (${eventId}, ${amountPaise}, ${actor.id})
      ON CONFLICT (event_id) DO UPDATE
        SET in_room_dining_paise = ${amountPaise}, updated_by = ${actor.id}, updated_at = now()
    `)
    await audit(tx, actor, {
      entity: 'lodge_extras', entityId: eventId, eventId, action: before ? 'update' : 'insert',
      field: 'in_room_dining_paise', oldValue: before ? String(oldPaise) : null, newValue: String(amountPaise),
    })
  })
}

// ── The close ────────────────────────────────────────────────────────────────

/** Closes the event's lodge extras: from here they are frozen, and they reach the bill. */
export async function closeLodgeExtras(actor: Actor, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const state = await loadEventState(tx, eventId)
    if (!OPEN_STATES.has(state.status)) {
      throw badRequest('Lodge extras can be closed only for an In Progress or Completed event.')
    }
    if (state.closed) throw conflict('Lodge extras for this event are already closed.')

    await tx.execute(sql`
      INSERT INTO lodge_extras (event_id, closed_at, closed_by, updated_by)
      VALUES (${eventId}, now(), ${actor.id}, ${actor.id})
      ON CONFLICT (event_id) DO UPDATE
        SET closed_at = now(), closed_by = ${actor.id}, updated_by = ${actor.id}, updated_at = now()
    `)
    await audit(tx, actor, {
      entity: 'lodge_extras', entityId: eventId, eventId, action: 'lock', field: 'closed', newValue: 'closed',
    })
  })
}

// ── Reads ────────────────────────────────────────────────────────────────────

export type AdditionalRoomLine = {
  id: string
  unitId: string | null
  lodge: string
  roomType: string
  count: number
  nights: number
  ratePaise: number
  amountPaise: number
  remarks: string | null
}

/** A lodge + category the desk can hand out, with what it costs a night. */
export type RoomCategoryOption = { unitId: string; unitName: string; roomType: string; ratePaise: number }

export type LodgeExtrasView = {
  closed: boolean
  rooms: AdditionalRoomLine[]
  roomsPaise: number
  /** 5% on the extra rooms, rounded per line — the only tax here that is money. */
  roomsTaxPaise: number
  inRoomDiningPaise: number
  /** Rooms + their 5% + dining: what the close will add to the bill. */
  totalPaise: number
  /** Every priced lodge + category, for the form. Fetched here so the panel needs one request. */
  options: RoomCategoryOption[]
}

export async function getLodgeExtras(eventId: string): Promise<LodgeExtrasView> {
  const state = await loadEventState(db, eventId)

  const [rows, header, options] = await Promise.all([
    db.execute(sql`
      SELECT a.id, a.unit_id AS "unitId", COALESCE(u.name, 'Lodging') AS lodge, a.room_type AS "roomType",
             a.count::int AS count, a.nights::int AS nights,
             a.rate_paise AS "ratePaise", a.amount_paise AS "amountPaise", a.remarks
      FROM additional_rooms a
      LEFT JOIN lodging_units u ON u.id = a.unit_id
      WHERE a.event_id = ${eventId}
      ORDER BY a.created_at
    `) as unknown as Promise<AdditionalRoomLine[]>,
    db.execute(sql`
      SELECT in_room_dining_paise AS "amountPaise" FROM lodge_extras WHERE event_id = ${eventId}
    `) as unknown as Promise<{ amountPaise: number }[]>,
    // Only lodges that actually have a priced room of the category — the same rule the wizard's
    // room picker follows, so the desk is never offered something it cannot price.
    db.execute(sql`
      SELECT u.id AS "unitId", u.name AS "unitName", r.room_type AS "roomType",
             min(r.rack_rate_paise)::bigint AS "ratePaise"
      FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
      WHERE r.is_active
      GROUP BY u.id, u.name, r.room_type
      HAVING min(r.rack_rate_paise) > 0
      ORDER BY u.name, r.room_type
    `) as unknown as Promise<RoomCategoryOption[]>,
  ])

  const rooms = rows.map((r) => ({ ...r, ratePaise: Number(r.ratePaise), amountPaise: Number(r.amountPaise) }))
  const roomsPaise = rooms.reduce((n, r) => n + r.amountPaise, 0)
  // Per line, then summed — matches lib/invoice.ts, lib/proposal.ts and lib/payment-schedule.ts,
  // which would otherwise differ from this panel by a paisa.
  const roomsTaxPaise = rooms.reduce((n, r) => n + Math.round((r.amountPaise * ROOM_GST_BP) / 10000), 0)
  const inRoomDiningPaise = header[0] ? Number(header[0].amountPaise) : 0

  return {
    closed: state.closed,
    rooms,
    roomsPaise,
    roomsTaxPaise,
    inRoomDiningPaise,
    totalPaise: roomsPaise + roomsTaxPaise + inRoomDiningPaise,
    options: options.map((o) => ({ ...o, ratePaise: Number(o.ratePaise) })),
  }
}

/** Events the Lodge Manager may log extras against: In Progress or Completed, as maintenance. */
export async function listLodgeExtrasEvents(): Promise<
  { id: string; code: string; guestName: string; status: string; firstDate: string | null; lineCount: number; closed: boolean }[]
> {
  return (await db.execute(sql`
    SELECT e.id, e.code, e.guest_name AS "guestName", e.status::text AS status,
           (SELECT min(se.event_date)::text FROM sub_events se WHERE se.event_id = e.id) AS "firstDate",
           (SELECT count(*)::int FROM additional_rooms a WHERE a.event_id = e.id) AS "lineCount",
           EXISTS (SELECT 1 FROM lodge_extras x WHERE x.event_id = e.id AND x.closed_at IS NOT NULL) AS closed
    FROM events e
    WHERE e.status IN ('in_progress','completed')
    ORDER BY "firstDate" NULLS LAST, e.code
  `)) as unknown as {
    id: string; code: string; guestName: string; status: string; firstDate: string | null; lineCount: number; closed: boolean
  }[]
}
