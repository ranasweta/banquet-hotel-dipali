import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { assertPaise } from '@/lib/money'

/**
 * The lodge master (client, 13 Aug 2026) — the venue master's counterpart for rooms: lodges,
 * the categories in each, how many rooms of each there are and what one costs a night.
 *
 * **THE SCREEN IS CATEGORY-WISE; THE TABLE IS ROOM-WISE.** `rooms` holds one row per physical
 * room, and it has to: the hard inventory cap counts real rooms, and refusing "40 deluxe when
 * 27 exist" is the whole point of it (rule 9). But nobody prices a hotel room by room — every
 * room of a category already carries the same rate, and pricing reads `min(rack_rate_paise)`
 * per category anyway. So this module presents a category as {count, rate} and does the
 * room-row bookkeeping underneath, which is what "category wise room and their pricing" asks
 * for and also the only shape that cannot drift: change the rate and every room moves together.
 *
 * **SHRINKING IS GUARDED, GROWING IS NOT.** Rooms already committed to confirmed bookings are
 * counted per night (`room_requirements`); dropping a category below its busiest committed
 * night would promise rooms the hotel no longer has, and the guest finds out at check-in. So a
 * reduction is refused with the number that blocks it, and the Auditor is told which night.
 * Adding rooms can hurt nobody and is free.
 *
 * **RATES ARE NOT DATED HERE**, unlike venues and menu tiers. A room's rate is snapshotted
 * nowhere: `computeBillLines` and the payable read `min(rack_rate_paise)` live. Dating the
 * rack rate without also snapshotting it onto the booking would be a false promise — the
 * change would still reach every existing bill. Re-pricing therefore moves unbilled bookings,
 * and the screen says so out loud rather than implying a protection that is not there.
 */

/** How the seed numbers rooms: a per-lodge letter and a running number (P101, C101, DORM-A). */
function roomNoPrefix(lodgeName: string): string {
  return (lodgeName.trim()[0] ?? 'R').toUpperCase()
}

// ── Read ─────────────────────────────────────────────────────────────────────

export type LodgeCategory = {
  roomType: string
  /** Active rooms of this category — the ceiling the availability check enforces. */
  rooms: number
  ratePaise: number
  beds: number
  /** The most this category is committed to on any single night; a floor under `rooms`. */
  committedPeak: number
}
export type Lodge = { id: string; name: string; categories: LodgeCategory[] }

/**
 * The busiest committed night per (lodge, category) — the floor a reduction cannot go under.
 *
 * Only committed events count, exactly as the availability check has it: enquiries hold
 * nothing, so a draft proposal never freezes the Auditor out of shrinking a category.
 */
async function committedPeaks(): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    -- One row per night per requirement, summed across events, then the worst night kept.
    SELECT unit_id AS "unitId", room_type AS "roomType", max(booked)::int AS peak
    FROM (
      SELECT rr.unit_id, rr.room_type, d.day, sum(rr.count)::int AS booked
      FROM room_requirements rr
      JOIN events e ON e.id = rr.event_id
      CROSS JOIN LATERAL generate_series(rr.check_in, rr.check_out - 1, INTERVAL '1 day') AS d(day)
      WHERE e.status IN ('confirmed','in_progress','completed','locked','billed','closed')
        AND rr.check_out > CURRENT_DATE
      GROUP BY rr.unit_id, rr.room_type, d.day
    ) nights
    GROUP BY unit_id, room_type
  `)) as unknown as { unitId: string; roomType: string; peak: number }[]
  return new Map(rows.map((r) => [`${r.unitId}|${r.roomType}`, r.peak]))
}

export async function getLodgeCatalog(): Promise<Lodge[]> {
  const [lodges, cats, peaks] = await Promise.all([
    db.execute(sql`SELECT id, name FROM lodging_units ORDER BY name`) as unknown as Promise<
      { id: string; name: string }[]
    >,
    db.execute(sql`
      SELECT unit_id AS "unitId", room_type AS "roomType", count(*)::int AS rooms,
             min(rack_rate_paise) AS "ratePaise", min(beds)::int AS beds
      FROM rooms WHERE is_active
      GROUP BY unit_id, room_type
      ORDER BY room_type
    `) as unknown as Promise<(Omit<LodgeCategory, 'committedPeak'> & { unitId: string })[]>,
    committedPeaks(),
  ])

  const byUnit = new Map<string, LodgeCategory[]>()
  for (const c of cats) {
    const { unitId, ...rest } = c
    byUnit.set(unitId, [
      ...(byUnit.get(unitId) ?? []),
      { ...rest, ratePaise: Number(rest.ratePaise), committedPeak: peaks.get(`${unitId}|${c.roomType}`) ?? 0 },
    ])
  }
  return lodges.map((l) => ({ ...l, categories: byUnit.get(l.id) ?? [] }))
}

// ── Lodges ───────────────────────────────────────────────────────────────────

export async function createLodge(actor: Actor, name: string): Promise<{ id: string }> {
  const clean = name.trim()
  if (!clean) throw badRequest('A lodge needs a name.')
  return db.transaction(async (tx) => {
    const [existing] = (await tx.execute(sql`
      SELECT id FROM lodging_units WHERE lower(name) = lower(${clean})
    `)) as unknown as { id: string }[]
    if (existing) throw conflict(`A lodge called "${clean}" already exists.`)

    const [l] = (await tx.execute(sql`
      INSERT INTO lodging_units (name) VALUES (${clean}) RETURNING id
    `)) as unknown as { id: string }[]
    await audit(tx, actor, {
      entity: 'lodging_units', entityId: l!.id, action: 'insert', field: 'name', newValue: clean,
    })
    return { id: l!.id }
  })
}

// ── Categories ───────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function loadLodge(tx: Tx, unitId: string): Promise<{ id: string; name: string }> {
  const [l] = (await tx.execute(sql`
    SELECT id, name FROM lodging_units WHERE id = ${unitId}
  `)) as unknown as { id: string; name: string }[]
  if (!l) throw notFound('Lodge not found')
  return l
}

/** Refuses a reduction that would drop below what is already promised on some night. */
async function assertNotOversold(tx: Tx, unitId: string, roomType: string, nextCount: number): Promise<void> {
  const [row] = (await tx.execute(sql`
    SELECT COALESCE(max(booked), 0)::int AS peak FROM (
      SELECT sum(rr.count)::int AS booked
      FROM room_requirements rr
      JOIN events e ON e.id = rr.event_id
      CROSS JOIN LATERAL generate_series(rr.check_in, rr.check_out - 1, INTERVAL '1 day') AS d(day)
      WHERE rr.unit_id = ${unitId} AND rr.room_type = ${roomType}
        AND e.status IN ('confirmed','in_progress','completed','locked','billed','closed')
        AND rr.check_out > CURRENT_DATE
      GROUP BY d.day
    ) nights
  `)) as unknown as { peak: number }[]
  const peak = row?.peak ?? 0
  if (nextCount < peak) {
    throw conflict(
      `${peak} ${roomType.replace(/_/g, ' ')} room(s) are already promised on the busiest night, ` +
        `so this cannot go below ${peak}. Cancel or reduce those bookings first.`,
    )
  }
}

function assertRoomType(roomType: string): string {
  const clean = roomType.trim().toLowerCase().replace(/\s+/g, '_')
  if (!/^[a-z][a-z0-9_]*$/.test(clean)) {
    throw badRequest('A category is a short name like "deluxe" or "semi suite".')
  }
  return clean
}

/**
 * Sets how many rooms of a category the lodge has, adding or retiring rows to match.
 *
 * Rooms are RETIRED (`is_active = false`), not deleted, when the count comes down: a room row
 * may be named on an old booking, and the inventory count already reads active rooms only.
 * Growing reactivates retired rows before it numbers new ones, so a category that shrank and
 * grew again does not leave a hole in the numbering.
 */
export async function setCategoryCount(
  actor: Actor,
  unitId: string,
  roomType: string,
  count: number,
): Promise<void> {
  if (!Number.isInteger(count) || count < 0) throw badRequest('A room count is a whole number, zero or more.')
  const type = assertRoomType(roomType)

  await db.transaction(async (tx) => {
    const lodge = await loadLodge(tx, unitId)
    const [{ n: current }] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE unit_id = ${unitId} AND room_type = ${type} AND is_active
    `)) as unknown as { n: number }[]
    if (current === count) return
    if (count < current) await assertNotOversold(tx, unitId, type, count)

    if (count < current) {
      await tx.execute(sql`
        UPDATE rooms SET is_active = false
         WHERE id IN (
           SELECT id FROM rooms WHERE unit_id = ${unitId} AND room_type = ${type} AND is_active
           ORDER BY room_no DESC LIMIT ${current - count}
         )
      `)
    } else {
      const wanted = count - current
      // Bring retired rows back before numbering new ones, so a category that shrank and grew
      // again does not leave a hole in the numbering.
      const revived = (await tx.execute(sql`
        UPDATE rooms SET is_active = true
         WHERE id IN (
           SELECT id FROM rooms
            WHERE unit_id = ${unitId} AND room_type = ${type} AND NOT is_active
            ORDER BY room_no LIMIT ${wanted}
         )
        RETURNING id
      `)) as unknown as { id: string }[]

      const stillNeeded = wanted - revived.length
      if (stillNeeded > 0) {
        const [rate] = (await tx.execute(sql`
          SELECT COALESCE(min(rack_rate_paise), 0) AS rate, COALESCE(min(beds), 2)::int AS beds
          FROM rooms WHERE unit_id = ${unitId} AND room_type = ${type}
        `)) as unknown as { rate: number; beds: number }[]
        if (Number(rate!.rate) <= 0) {
          throw badRequest(`Set a nightly rate for ${type.replace(/_/g, ' ')} before adding rooms to it.`)
        }
        // Numbered after the lodge's highest existing room, so a new row can never collide
        // with a retired one and trip UNIQUE (unit_id, room_no).
        await tx.execute(sql`
          INSERT INTO rooms (unit_id, room_no, room_type, beds, rack_rate_paise)
          SELECT ${unitId},
                 ${roomNoPrefix(lodge.name)} || (COALESCE((
                   SELECT max(NULLIF(regexp_replace(room_no, '\\D', '', 'g'), '')::int) FROM rooms WHERE unit_id = ${unitId}
                 ), 100) + g)::text,
                 ${type}, ${rate!.beds}, ${rate!.rate}
          FROM generate_series(1, ${stillNeeded}) AS g
        `)
      }
    }

    await audit(tx, actor, {
      entity: 'rooms', entityId: unitId, action: 'update', field: `${type} room count`,
      oldValue: String(current), newValue: String(count),
    })
  })
}

/**
 * Re-prices every room of a category.
 *
 * This DOES move unbilled bookings. Room charges are read live from `min(rack_rate_paise)` —
 * nothing snapshots them onto the event the way a menu or a venue rate is snapshotted — so a
 * change here reaches every proposal and every unissued Draft for that category. Issued
 * documents are safe: an invoice keeps the lines it was issued with.
 */
export async function setCategoryRate(
  actor: Actor,
  unitId: string,
  roomType: string,
  ratePaise: number,
): Promise<void> {
  assertPaise(ratePaise)
  if (ratePaise <= 0) throw badRequest('A room has to cost more than zero a night.')
  const type = assertRoomType(roomType)

  await db.transaction(async (tx) => {
    await loadLodge(tx, unitId)
    const [before] = (await tx.execute(sql`
      SELECT min(rack_rate_paise) AS rate FROM rooms WHERE unit_id = ${unitId} AND room_type = ${type}
    `)) as unknown as { rate: number | null }[]
    if (before?.rate == null) throw notFound('That category is not in this lodge.')

    await tx.execute(sql`
      UPDATE rooms SET rack_rate_paise = ${ratePaise} WHERE unit_id = ${unitId} AND room_type = ${type}
    `)
    await audit(tx, actor, {
      entity: 'rooms', entityId: unitId, action: 'update', field: `${type} nightly rate`,
      oldValue: String(before.rate), newValue: String(ratePaise),
    })
  })
}

/** Adds a category to a lodge: a name, a nightly rate, and how many rooms of it there are. */
export async function addCategory(
  actor: Actor,
  unitId: string,
  input: { roomType: string; ratePaise: number; rooms: number; beds: number },
): Promise<void> {
  const type = assertRoomType(input.roomType)
  assertPaise(input.ratePaise)
  if (input.ratePaise <= 0) throw badRequest('A room has to cost more than zero a night.')
  if (!Number.isInteger(input.rooms) || input.rooms < 1) throw badRequest('Add at least one room.')
  if (!Number.isInteger(input.beds) || input.beds < 1) throw badRequest('A room has at least one bed.')

  await db.transaction(async (tx) => {
    const lodge = await loadLodge(tx, unitId)
    const [{ n }] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE unit_id = ${unitId} AND room_type = ${type}
    `)) as unknown as { n: number }[]
    if (n > 0) throw conflict(`${lodge.name} already has a ${type.replace(/_/g, ' ')} category.`)

    await tx.execute(sql`
      INSERT INTO rooms (unit_id, room_no, room_type, beds, rack_rate_paise)
      SELECT ${unitId},
             ${roomNoPrefix(lodge.name)} || (COALESCE((
               SELECT max(NULLIF(regexp_replace(room_no, '\\D', '', 'g'), '')::int) FROM rooms WHERE unit_id = ${unitId}
             ), 100) + g)::text,
             ${type}, ${input.beds}, ${input.ratePaise}
      FROM generate_series(1, ${input.rooms}) AS g
    `)
    await audit(tx, actor, {
      entity: 'rooms', entityId: unitId, action: 'insert', field: 'category',
      newValue: `${lodge.name} · ${type} × ${input.rooms} @ ${input.ratePaise} paise`,
    })
  })
}

/**
 * Removes a category from a lodge — the same guard as shrinking it to zero, because that is
 * what it is. Rooms are retired rather than deleted so old bookings still explain themselves.
 */
export async function removeCategory(actor: Actor, unitId: string, roomType: string): Promise<void> {
  const type = assertRoomType(roomType)
  await db.transaction(async (tx) => {
    const lodge = await loadLodge(tx, unitId)
    const [{ n }] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE unit_id = ${unitId} AND room_type = ${type} AND is_active
    `)) as unknown as { n: number }[]
    if (n === 0) throw notFound('That category is not in this lodge.')
    await assertNotOversold(tx, unitId, type, 0)

    await tx.execute(sql`
      UPDATE rooms SET is_active = false WHERE unit_id = ${unitId} AND room_type = ${type}
    `)
    await audit(tx, actor, {
      entity: 'rooms', entityId: unitId, action: 'delete', field: 'category',
      oldValue: `${lodge.name} · ${type} × ${n}`,
    })
  })
}
