import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { deleteStored } from '@/lib/storage'

/**
 * Extra plates (client, 15 Aug 2026) — the Utensil Manager's log.
 *
 * On the day, more guests arrive than a function was catered for and the kitchen issues extra
 * plates. He records how many, against which FUNCTION, with a remark and a photograph of them.
 *
 * WHY A FUNCTION AND NOT JUST A BOOKING. The price is the function's own per-plate rate, and a
 * wedding's Sangeet is Silver where its Reception is Gold. The rate is composed exactly as
 * `computeBillLines` and `payableRows` compose it for a catered plate —
 *
 *     base_rate_paise + surcharge_paise + priced chef delicacies
 *
 * — so an extra plate and a booked plate at the same function cost the same to the paisa. It is
 * SNAPSHOTTED at entry (rule 4): re-pricing the tier tomorrow cannot move a plate already
 * served. A function with no saved menu has no rate and is refused, never priced at zero.
 *
 * WHY THE PHOTO IS MANDATORY. This is the one charge in the system a member of staff can invent
 * outright — there is no booking, no rate card and no guest signature behind it, only a number
 * somebody counted at the pass. The photo is what the Auditor and the Higher Authority check it
 * against, so an entry without one does not exist rather than existing and being flagged. It is
 * encrypted at rest and served only behind `utensils:view` (rule 7).
 *
 * THE CLOSE. Nothing here is charged until he closes the log, exactly as Maintenance and the
 * lodge's extras work: an open log is still being counted. Closed-only is enforced identically
 * in the bill, the payable and the proposal, so the three cannot disagree.
 */

const OPEN_STATES = new Set(['in_progress', 'completed'])

type EventState = { status: string; closed: boolean }

async function loadEventState(exec: typeof db, eventId: string): Promise<EventState> {
  const [row] = (await exec.execute(sql`
    SELECT e.status::text AS status,
           EXISTS (SELECT 1 FROM utensil_extras x WHERE x.event_id = e.id AND x.closed_at IS NOT NULL) AS closed
    FROM events e WHERE e.id = ${eventId}
  `)) as unknown as EventState[]
  if (!row) throw notFound('Event not found')
  return row
}

/** Plates are writable only while In Progress / Completed, and only before the log is closed. */
function assertWritable(state: EventState): void {
  if (!OPEN_STATES.has(state.status)) {
    throw badRequest('Extra plates can be logged only while an event is In Progress or Completed.')
  }
  if (state.closed) throw conflict('Extra plates for this event are closed and can no longer change.')
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Ensures the event's `utensil_extras` row exists and stamps who touched it. */
async function touchHeader(tx: Tx, actor: Actor, eventId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO utensil_extras (event_id, updated_by) VALUES (${eventId}, ${actor.id})
    ON CONFLICT (event_id) DO UPDATE SET updated_by = ${actor.id}, updated_at = now()
  `)
}

/**
 * The per-plate rate of a function, composed exactly as the bill composes it for a booked
 * plate. NULL when the function has no saved menu — the caller turns that into a refusal.
 */
const platRateSql = (subEventId: string) => sql`
  SELECT se.event_id AS "eventId", se.name AS "functionName",
         (m.base_rate_paise + m.surcharge_paise
          + COALESCE((SELECT sum(c.charge_paise) FROM chef_requests c
                       WHERE c.sub_event_id = se.id AND c.status = 'priced'), 0))::bigint AS "ratePaise"
  FROM sub_events se
  LEFT JOIN sub_event_menus m ON m.sub_event_id = se.id
  WHERE se.id = ${subEventId}
`

export type ExtraPlatesInput = {
  subEventId: string
  plates: number
  fileKey: string
  remarks?: string
}

/**
 * Logs plates issued at a function.
 *
 * `fileKey` is required by the signature as well as the column: the photo is stored by the
 * route before this is called, so an entry can never be written without one.
 */
export async function addPlates(
  actor: Actor,
  input: ExtraPlatesInput,
): Promise<{ id: string; eventId: string; amountPaise: number }> {
  if (!Number.isInteger(input.plates) || input.plates < 1) throw badRequest('Enter at least one plate.')
  if (!input.fileKey) throw badRequest('A photo of the plates is required.')

  return db.transaction(async (tx) => {
    const [fn] = (await tx.execute(platRateSql(input.subEventId))) as unknown as {
      eventId: string; functionName: string; ratePaise: number | null
    }[]
    if (!fn) throw notFound('Function not found')
    assertWritable(await loadEventState(tx, fn.eventId))
    // A missing rate is a gate, never a zero: without a menu there is no per-plate price, and
    // billing at zero would give the plates away silently.
    if (fn.ratePaise === null || Number(fn.ratePaise) <= 0) {
      throw badRequest(
        `${fn.functionName} has no saved menu, so a plate there has no price — save the menu first.`,
      )
    }

    const ratePaise = Number(fn.ratePaise)
    const amountPaise = input.plates * ratePaise
    const [row] = await tx
      .insert(schema.extraPlateEntries)
      .values({
        eventId: fn.eventId,
        subEventId: input.subEventId,
        plates: input.plates,
        ratePaise,
        amountPaise,
        remarks: input.remarks?.trim() || null,
        fileKey: input.fileKey,
        createdBy: actor.id,
      })
      .returning({ id: schema.extraPlateEntries.id })

    await touchHeader(tx, actor, fn.eventId)
    await audit(tx, actor, {
      entity: 'extra_plate_entries', entityId: row!.id, eventId: fn.eventId, action: 'insert', field: 'plates',
      newValue: `${fn.functionName}: ${input.plates} plate(s) @ ${ratePaise} = ${amountPaise}`,
    })
    return { id: row!.id, eventId: fn.eventId, amountPaise }
  })
}

/** Removes an entry, before the close. The photo goes with it — nothing is charged for it now. */
export async function removePlates(actor: Actor, entryId: string): Promise<void> {
  const fileKey = await db.transaction(async (tx) => {
    const [e] = await tx
      .select()
      .from(schema.extraPlateEntries)
      .where(eq(schema.extraPlateEntries.id, entryId))
      .limit(1)
    if (!e) throw notFound('Entry not found')
    assertWritable(await loadEventState(tx, e.eventId))

    await tx.delete(schema.extraPlateEntries).where(eq(schema.extraPlateEntries.id, entryId))
    await touchHeader(tx, actor, e.eventId)
    await audit(tx, actor, {
      entity: 'extra_plate_entries', entityId: entryId, eventId: e.eventId, action: 'delete', field: 'plates',
      oldValue: `${e.plates} plate(s) @ ${e.ratePaise} = ${e.amountPaise}`,
    })
    return e.fileKey
  })
  // Outside the transaction: the row is gone either way, and a storage hiccup must not roll
  // back a delete the audit log has already recorded.
  await deleteStored(fileKey).catch(() => {})
}

/** Closes the event's plate log: from here the entries are frozen, and they reach the bill. */
export async function closeUtensilExtras(actor: Actor, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const state = await loadEventState(tx, eventId)
    if (!OPEN_STATES.has(state.status)) {
      throw badRequest('Extra plates can be closed only for an In Progress or Completed event.')
    }
    if (state.closed) throw conflict('Extra plates for this event are already closed.')

    await tx.execute(sql`
      INSERT INTO utensil_extras (event_id, closed_at, closed_by, updated_by)
      VALUES (${eventId}, now(), ${actor.id}, ${actor.id})
      ON CONFLICT (event_id) DO UPDATE
        SET closed_at = now(), closed_by = ${actor.id}, updated_by = ${actor.id}, updated_at = now()
    `)
    await audit(tx, actor, {
      entity: 'utensil_extras', entityId: eventId, eventId, action: 'lock', field: 'closed', newValue: 'closed',
    })
  })
}

// ── Reads ────────────────────────────────────────────────────────────────────

export type PlateLine = {
  id: string
  subEventId: string
  functionName: string
  eventDate: string
  plates: number
  ratePaise: number
  amountPaise: number
  remarks: string | null
  createdBy: string
}

/** A function the plates can be charged against, with what one plate there costs. */
export type PlateFunctionOption = {
  subEventId: string
  name: string
  eventDate: string
  tierName: string | null
  ratePaise: number | null
}

export type UtensilExtrasView = {
  closed: boolean
  entries: PlateLine[]
  totalPaise: number
  /** The event's functions and their per-plate rates, so the panel needs one request. */
  functions: PlateFunctionOption[]
}

export async function getUtensilExtras(eventId: string): Promise<UtensilExtrasView> {
  const state = await loadEventState(db, eventId)

  const [rows, functions] = await Promise.all([
    db.execute(sql`
      SELECT p.id, p.sub_event_id AS "subEventId", se.name AS "functionName",
             se.event_date::text AS "eventDate", p.plates::int AS plates,
             p.rate_paise AS "ratePaise", p.amount_paise AS "amountPaise", p.remarks,
             u.full_name AS "createdBy"
      FROM extra_plate_entries p
      JOIN sub_events se ON se.id = p.sub_event_id
      JOIN users u ON u.id = p.created_by
      WHERE p.event_id = ${eventId}
      ORDER BY p.created_at
    `) as unknown as Promise<PlateLine[]>,
    // Every function, with its rate — including the ones with no menu, shown unpriced so the
    // screen can say WHY it cannot take plates there rather than silently omitting it.
    db.execute(sql`
      SELECT se.id AS "subEventId", se.name, se.event_date::text AS "eventDate",
             m.tier_name AS "tierName",
             CASE WHEN m.sub_event_id IS NULL THEN NULL ELSE
               (m.base_rate_paise + m.surcharge_paise
                + COALESCE((SELECT sum(c.charge_paise) FROM chef_requests c
                             WHERE c.sub_event_id = se.id AND c.status = 'priced'), 0))::bigint
             END AS "ratePaise"
      FROM sub_events se
      LEFT JOIN sub_event_menus m ON m.sub_event_id = se.id
      WHERE se.event_id = ${eventId}
      ORDER BY se.event_date, se.start_time
    `) as unknown as Promise<PlateFunctionOption[]>,
  ])

  const entries = rows.map((r) => ({
    ...r,
    ratePaise: Number(r.ratePaise),
    amountPaise: Number(r.amountPaise),
  }))
  return {
    closed: state.closed,
    entries,
    totalPaise: entries.reduce((n, e) => n + e.amountPaise, 0),
    functions: functions.map((f) => ({ ...f, ratePaise: f.ratePaise === null ? null : Number(f.ratePaise) })),
  }
}

/** Events the Utensil Manager may log against: In Progress or Completed, as Maintenance sees. */
export async function listUtensilEvents(): Promise<
  { id: string; code: string; guestName: string; status: string; firstDate: string | null; entryCount: number; closed: boolean }[]
> {
  return (await db.execute(sql`
    SELECT e.id, e.code, e.guest_name AS "guestName", e.status::text AS status,
           (SELECT min(se.event_date)::text FROM sub_events se WHERE se.event_id = e.id) AS "firstDate",
           (SELECT count(*)::int FROM extra_plate_entries p WHERE p.event_id = e.id) AS "entryCount",
           EXISTS (SELECT 1 FROM utensil_extras x WHERE x.event_id = e.id AND x.closed_at IS NOT NULL) AS closed
    FROM events e
    WHERE e.status IN ('in_progress','completed')
    ORDER BY (e.status = 'in_progress') DESC, "firstDate" NULLS LAST, e.code
  `)) as unknown as {
    id: string; code: string; guestName: string; status: string; firstDate: string | null; entryCount: number; closed: boolean
  }[]
}

/** The file_key of an entry's photo, for a permission-checked download. */
export async function platePhotoKey(entryId: string): Promise<string> {
  const [e] = await db
    .select({ fileKey: schema.extraPlateEntries.fileKey })
    .from(schema.extraPlateEntries)
    .where(eq(schema.extraPlateEntries.id, entryId))
    .limit(1)
  if (!e) throw notFound('Entry not found')
  return e.fileKey
}
