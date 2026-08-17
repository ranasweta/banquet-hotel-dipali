import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { assertPaise } from '@/lib/money'
import { roomGstBp } from '@/lib/tax'

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
 * **RATES ARE NOT DATED HERE**, unlike venues and menu tiers — they are FROZEN AT CONFIRM
 * instead (migration 0032). `room_requirements.rate_paise` is written when a booking is
 * confirmed, and every reader is `COALESCE(rr.rate_paise, <live min>)`. So re-pricing a
 * category reaches enquiries, which are still quotes, and leaves confirmed bookings on the
 * rate they were promised. That is what dating the rack rate would have been for, done at the
 * point where it matters — and it is why the screen no longer warns that a new rate moves
 * everything unbilled. It does not.
 *
 * The one thing to know is the other direction: a post-confirm edit to a booking's rooms
 * re-freezes at TODAY's rate (`freezeRoomRates`), exactly as a post-confirm venue edit
 * re-prices. Changing a rate here and then editing that booking's rooms does move it.
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
  /**
   * 500 or 1800 — the GST this category's guests are charged, from `lib/tax.ts` (rule 11).
   *
   * Shown on this screen because this screen is where it is DECIDED: the rate typed here is
   * what puts a category over ₹7,500 and into the 18% band, and the dormitory carve-out is
   * keyed on the name typed here. Both are invisible otherwise until a guest reads a bill.
   */
  gstRateBp: number
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
    `) as unknown as Promise<(Omit<LodgeCategory, 'committedPeak' | 'gstRateBp'> & { unitId: string })[]>,
    committedPeaks(),
  ])

  const byUnit = new Map<string, LodgeCategory[]>()
  for (const c of cats) {
    const { unitId, ...rest } = c
    const ratePaise = Number(rest.ratePaise)
    byUnit.set(unitId, [
      ...(byUnit.get(unitId) ?? []),
      {
        ...rest,
        ratePaise,
        committedPeak: peaks.get(`${unitId}|${c.roomType}`) ?? 0,
        gstRateBp: roomGstBp(ratePaise, c.roomType),
      },
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
 * **This moves ENQUIRIES, not confirmed bookings.** A room's rate is snapshotted onto
 * `room_requirements` at confirmation (migration 0032) and every reader is
 * `COALESCE(rr.rate_paise, <live min>)`, so a booking that has been promised a price keeps it.
 * An enquiry has no snapshot and is still a quote, so it re-prices — which is the point.
 * Issued documents are safe twice over: an invoice keeps the lines it was issued with.
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

/**
 * Renames a category — the same rooms under a different label (client, 17 Aug 2026).
 *
 * **THE NAME IS THE KEY, SO THE RENAME HAS TO CASCADE.** `room_type` is plain text with no
 * foreign key: pricing, the availability check and the bill all join `rooms` to a booking on
 * the string. Renaming `rooms` alone would leave every requirement pointing at a category that
 * no longer exists, and `min(rack_rate_paise)` would find nothing — a confirmed booking would
 * survive on its frozen rate (migration 0032) while every enquiry quietly re-priced to ZERO,
 * which is the one thing a missing rate must never do (docs/SEED_ASSUMPTIONS.md).
 *
 * **THREE TABLES HOLD A LIVE CATEGORY NAME AND ALL THREE MOVE** — `rooms` (retired rows
 * included: they are the same category, and one that shrank and grew again must not come back
 * under its old name), `room_requirements` (what was sold) and `additional_rooms` (what the
 * desk handed over). Nothing else in the schema stores one. What deliberately does NOT move:
 *
 *   invoice_lines.description   a document the guest holds. It says what it said when it was
 *                               issued, and a redraft rebuilds it from the booking anyway.
 *   audit_log                   append-only by construction, and the record of the rename is
 *                               itself one of its rows.
 *   exceptions.payload          the 35+ rooms request records what was ASKED FOR at the time;
 *                               it is read for display only (lib/approvals.ts) and inserts
 *                               nothing, so a stale name there breaks no lookup.
 *
 * **ROWS THAT NAME NO LODGE.** `room_requirements.unit_id` is nullable — rows captured before
 * the proposal asked which lodge (migration 0009) — and they price off `min(rack_rate_paise)`
 * across every lodge carrying the name. Renaming one lodge's category leaves them alone while
 * ANOTHER lodge still has the old name, because they may well have meant that one. Once no
 * lodge anywhere has it, they would resolve to nothing and price at zero, so at that point
 * they follow the rename too. That is the only reading under which they are not orphaned.
 */
export async function renameCategory(
  actor: Actor,
  unitId: string,
  roomType: string,
  nextRoomType: string,
): Promise<string> {
  const from = assertRoomType(roomType)
  const to = assertRoomType(nextRoomType)
  if (from === to) return to

  await db.transaction(async (tx) => {
    const lodge = await loadLodge(tx, unitId)
    const [{ n }] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE unit_id = ${unitId} AND room_type = ${from}
    `)) as unknown as { n: number }[]
    if (n === 0) throw notFound('That category is not in this lodge.')

    // Retired rows count: renaming onto them would merge two categories into one and there
    // would be no way back to the pair.
    const [{ n: clash }] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE unit_id = ${unitId} AND room_type = ${to}
    `)) as unknown as { n: number }[]
    if (clash > 0) throw conflict(`${lodge.name} already has a ${to.replace(/_/g, ' ')} category.`)

    await tx.execute(sql`
      UPDATE rooms SET room_type = ${to} WHERE unit_id = ${unitId} AND room_type = ${from}
    `)
    await tx.execute(sql`
      UPDATE room_requirements SET room_type = ${to}
       WHERE unit_id = ${unitId} AND room_type = ${from}
    `)
    await tx.execute(sql`
      UPDATE additional_rooms SET room_type = ${to}
       WHERE unit_id = ${unitId} AND room_type = ${from}
    `)

    // The lodge-less rows, once — and only once — no lodge anywhere still answers to the old
    // name. Run AFTER the `rooms` update above, so "anywhere" means after this rename.
    const [{ n: elsewhere }] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE room_type = ${from}
    `)) as unknown as { n: number }[]
    // The NAME only. `unit_id` stays NULL: which lodge those rooms came from was never
    // recorded and must not be invented here (migration 0009's note). Renaming is enough —
    // their `unit_id IS NULL` lookup matches whichever lodge carries the name, which after
    // this rename is this one.
    if (elsewhere === 0) {
      await tx.execute(sql`
        UPDATE room_requirements SET room_type = ${to} WHERE unit_id IS NULL AND room_type = ${from}
      `)
      await tx.execute(sql`
        UPDATE additional_rooms SET room_type = ${to} WHERE unit_id IS NULL AND room_type = ${from}
      `)
    }

    await audit(tx, actor, {
      entity: 'rooms', entityId: unitId, action: 'update', field: 'category name',
      oldValue: `${lodge.name} · ${from}`, newValue: `${lodge.name} · ${to}`,
    })
  })
  // The normalised name, so a caller that goes on to re-price or resize the same category in
  // the same request addresses it by the name it now has.
  return to
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
