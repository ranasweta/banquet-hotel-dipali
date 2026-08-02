import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api'
import { applyMove, type ResolvedSchedule } from '@/lib/change-requests'
import { recomputeProposal } from '@/lib/post-confirm'
import { reissueInvoice } from '@/lib/invoice'
import { getRoomAvailability } from '@/lib/rooms'
import { formatPaise } from '@/lib/money'

/**
 * The Higher Authority's proposal editor (client's lead, 1 Aug 2026).
 *
 * The GM does not send instructions back to the Booking Manager and wait — he edits the
 * booking himself, from the approvals screen, and what he saves IS the proposal. That replaces
 * the `counter_change` flow, which recorded his intent and applied nothing (lib/approvals.ts),
 * and it is the reason for the two rule amendments this module carries:
 *
 *   • CLAUDE.md rule 6, `locked means locked`, gains exactly one exception. The DB triggers
 *     cannot see an actor, so this module announces itself with a transaction-local GUC
 *     (migration 0025). `set_config(..., true)` is LOCAL: it dies with the transaction and can
 *     never leak onto the next borrower of a pooled connection. Nothing else in the codebase
 *     sets it, so every other write still meets the guard exactly as before.
 *   • Editing a billed booking invalidates a document the guest already holds, so saving
 *     re-issues it as a new version rather than quietly changing the numbers under an issued
 *     one (lib/invoice.ts, reissueInvoice).
 *
 * What is NOT overridden is anything physical or historical. The venue GiST exclusion still
 * decides double-bookings, the lodge inventory cap still bounds rooms, and `audit_log` remains
 * append-only. The Authority outranks the workflow; he does not outrank the building.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Only these two roles may edit through this path — the same set that decides approvals. */
export const AUTHORITY_ROLES = new Set(['higher_authority', 'auditor'])
const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])
const REISSUE_STATES = new Set(['billed', 'closed'])
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type FunctionEdit = {
  id: string
  name?: string
  eventDate?: string
  startTime?: string
  endTime?: string
  venueId?: string | null
  bundleId?: string | null
  pax?: number
}

/** The complete dish list the GM is leaving ticked for one segment. Absent = unticked. */
export type MenuEdit = { subEventId: string; categoryName: string; dishes: string[] }

export type RoomEdit = { unitId: string; roomType: string; count: number; checkIn: string; checkOut: string }

export type DiscountEdit = {
  head: string
  /** Exactly one of the two. A rupee figure from the Authority is uncapped — see below. */
  amountPaise?: number
  percentBp?: number
  remark: string
}

export type GmProposalEdits = {
  event?: { guestName?: string; plannedFrom?: string | null; plannedTo?: string | null }
  functions?: FunctionEdit[]
  menus?: MenuEdit[]
  /** Full replacement of the room booking, matching saveRoomRequirements' semantics. */
  rooms?: RoomEdit[]
  addDiscounts?: DiscountEdit[]
  removeDiscountIds?: string[]
  /** Why. Mandatory whenever a locked booking is touched — it lands in the audit trail. */
  reason?: string
}

export type GmEditResult = {
  changes: string[]
  invoiceReissued: boolean
  invoiceNo: string | null
}

/** Turns the override on for the remainder of THIS transaction only. */
async function enableOverride(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.gm_override', 'on', true)`)
}

/**
 * Applies the Authority's edits to a proposal inside a caller-supplied transaction, so a
 * bundle decision and the edits it implies commit as one unit (lib/approval-bundles.ts).
 *
 * Returns a human list of what changed — it is shown to the GM and, through the audit trail,
 * becomes the Booking Manager's notification (lib/notifications.ts).
 */
export async function applyGmProposalEdits(
  tx: Tx,
  actor: Actor,
  eventId: string,
  edits: GmProposalEdits,
): Promise<GmEditResult> {
  if (!AUTHORITY_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Higher Authority can edit a proposal directly.')
  }

  const [ev] = await tx
    .select({ status: schema.events.status, eventType: schema.events.eventType, guestName: schema.events.guestName, code: schema.events.code })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .for('update')
    .limit(1)
  if (!ev) throw notFound('Event not found')
  if (ev.status === 'cancelled') throw conflict('This booking is cancelled.')

  const locked = LOCKED_STATES.has(ev.status)
  if (locked) {
    if (!edits.reason?.trim()) {
      throw badRequest(`This booking is ${ev.status}. Editing it needs a reason, which is recorded against the change.`)
    }
    await enableOverride(tx)
  }

  const changes: string[] = []

  // ── Event header ───────────────────────────────────────────────────────────
  if (edits.event) {
    const set: Record<string, unknown> = {}
    if (edits.event.guestName != null && edits.event.guestName.trim() !== ev.guestName) {
      const next = edits.event.guestName.trim()
      if (!next) throw badRequest('Guest name cannot be empty.')
      set.guestName = next
      changes.push(`guest name ${ev.guestName} → ${next}`)
      await audit(tx, actor, { entity: 'events', entityId: eventId, eventId, action: 'update', field: 'guest_name', oldValue: ev.guestName, newValue: next })
    }
    if (edits.event.plannedFrom !== undefined) {
      if (edits.event.plannedFrom && !ISO_DATE.test(edits.event.plannedFrom)) throw badRequest('Invalid From date')
      set.plannedFrom = edits.event.plannedFrom
      changes.push(`event runs from ${edits.event.plannedFrom ?? '—'}`)
    }
    if (edits.event.plannedTo !== undefined) {
      if (edits.event.plannedTo && !ISO_DATE.test(edits.event.plannedTo)) throw badRequest('Invalid To date')
      set.plannedTo = edits.event.plannedTo
      changes.push(`event runs to ${edits.event.plannedTo ?? '—'}`)
    }
    if (Object.keys(set).length) {
      await tx.update(schema.events).set(set).where(eq(schema.events.id, eventId))
    }
  }

  // ── Functions: name, pax, and the schedule ─────────────────────────────────
  for (const f of edits.functions ?? []) {
    const [cur] = (await tx.execute(sql`
      SELECT se.id, se.name, se.event_date::text AS "eventDate", se.start_time::text AS "startTime",
             se.end_time::text AS "endTime", se.venue_id AS "venueId", se.bundle_id AS "bundleId", se.pax
        FROM sub_events se WHERE se.id = ${f.id} AND se.event_id = ${eventId}
    `)) as unknown as { id: string; name: string; eventDate: string; startTime: string; endTime: string; venueId: string | null; bundleId: string | null; pax: number }[]
    if (!cur) throw notFound('That function is not part of this booking.')

    if (f.name != null && f.name.trim() && f.name.trim() !== cur.name) {
      await tx.update(schema.subEvents).set({ name: f.name.trim() }).where(eq(schema.subEvents.id, f.id))
      await audit(tx, actor, { entity: 'sub_events', entityId: f.id, eventId, action: 'update', field: 'name', oldValue: cur.name, newValue: f.name.trim() })
      changes.push(`function renamed ${cur.name} → ${f.name.trim()}`)
    }

    if (f.pax != null && f.pax !== cur.pax) {
      if (!Number.isInteger(f.pax) || f.pax <= 0) throw badRequest('Pax must be a positive whole number.')
      await tx.update(schema.subEvents).set({ pax: f.pax }).where(eq(schema.subEvents.id, f.id))
      await audit(tx, actor, { entity: 'sub_events', entityId: f.id, eventId, action: 'update', field: 'pax', oldValue: String(cur.pax), newValue: String(f.pax) })
      changes.push(`${cur.name}: pax ${cur.pax} → ${f.pax}`)
    }

    // A venue/date/time change re-books the slot through the SAME path a change request takes,
    // so the calendar and the GiST exclusion stay authoritative.
    const next: ResolvedSchedule = {
      eventDate: f.eventDate ?? cur.eventDate,
      startTime: (f.startTime ?? cur.startTime).slice(0, 5),
      endTime: (f.endTime ?? cur.endTime).slice(0, 5),
      venueId: f.venueId !== undefined ? f.venueId : f.bundleId ? null : cur.venueId,
      bundleId: f.bundleId !== undefined ? f.bundleId : f.venueId ? null : cur.bundleId,
    }
    const moved =
      next.eventDate !== cur.eventDate ||
      next.startTime !== cur.startTime.slice(0, 5) ||
      next.endTime !== cur.endTime.slice(0, 5) ||
      next.venueId !== cur.venueId ||
      next.bundleId !== cur.bundleId
    if (moved) {
      if (!ISO_DATE.test(next.eventDate)) throw badRequest('Invalid date')
      if (!HHMM.test(next.startTime) || !HHMM.test(next.endTime)) throw badRequest('Invalid time')
      if (next.startTime === next.endTime) throw badRequest('Start and end time cannot be equal')
      if (Boolean(next.venueId) === Boolean(next.bundleId)) {
        throw badRequest('A function takes either a venue or a bundle — exactly one.')
      }
      await applyMove(tx, actor, f.id, eventId, next)
      changes.push(
        `${cur.name}: ${cur.eventDate} ${cur.startTime.slice(0, 5)}–${cur.endTime.slice(0, 5)}` +
          ` → ${next.eventDate} ${next.startTime}–${next.endTime}`,
      )
    }
  }

  // ── Menus: whatever the GM leaves ticked is what the guest gets ────────────
  for (const m of edits.menus ?? []) {
    changes.push(...(await applyMenuEdit(tx, actor, eventId, m)))
  }

  // ── Rooms: a full replacement of the booking ───────────────────────────────
  if (edits.rooms) {
    changes.push(...(await applyRoomEdit(tx, actor, eventId, edits.rooms)))
  }

  // ── Discounts ──────────────────────────────────────────────────────────────
  for (const id of edits.removeDiscountIds ?? []) {
    const [d] = await tx
      .select({ id: schema.discounts.id, head: schema.discounts.head, amountPaise: schema.discounts.amountPaise, exceptionId: schema.discounts.exceptionId })
      .from(schema.discounts)
      .where(and(eq(schema.discounts.id, id), eq(schema.discounts.eventId, eventId)))
      .limit(1)
    if (!d) throw notFound('That discount is not on this booking.')
    await tx.delete(schema.discounts).where(eq(schema.discounts.id, id))
    if (d.exceptionId) {
      await tx.delete(schema.exceptions).where(and(eq(schema.exceptions.id, d.exceptionId), eq(schema.exceptions.status, 'pending')))
    }
    await audit(tx, actor, { entity: 'discounts', entityId: id, eventId, action: 'delete', field: d.head, oldValue: formatPaise(d.amountPaise), newValue: 'removed' })
    changes.push(`${d.head} discount of ${formatPaise(d.amountPaise)} removed`)
  }
  for (const add of edits.addDiscounts ?? []) {
    changes.push(await addAuthorityDiscount(tx, actor, eventId, add))
  }

  // ── Recompute and, past billing, re-issue ──────────────────────────────────
  if (changes.length === 0) return { changes, invoiceReissued: false, invoiceNo: null }

  await recomputeProposal(tx, eventId, ev.eventType)
  await tx.update(schema.events).set({ updatedAt: new Date().toISOString() }).where(eq(schema.events.id, eventId))

  let invoiceReissued = false
  let invoiceNo: string | null = null
  if (locked) {
    const result = await reissueInvoice(tx, actor, eventId, edits.reason!.trim())
    invoiceReissued = result.reissued
    invoiceNo = result.invoiceNo
  }

  /**
   * One summary row per save, on top of the field-level rows each branch already wrote.
   *
   * The detail rows are the audit trail and answer "what exactly changed". This row answers
   * "the Authority revised this booking", which is a different question and the one the
   * Booking Manager needs — it is what `lib/notifications.ts` turns into their notification.
   * Deriving that from the field-level rows instead would send them six notifications for one
   * save, and `field` is where the distinction has to live because entity/action are shared.
   */
  await audit(tx, actor, {
    entity: 'events',
    entityId: eventId,
    eventId,
    action: 'update',
    field: locked ? 'authority_override' : 'authority_edit',
    oldValue: ev.status,
    newValue:
      changes.join('; ') +
      (edits.reason?.trim() ? ` — ${edits.reason.trim()}` : '') +
      (invoiceReissued ? ` (document re-issued as ${invoiceNo})` : ''),
  })

  return { changes, invoiceReissued, invoiceNo }
}

/**
 * Sets a segment's dish list to exactly what the GM left ticked.
 *
 * The pick ceiling is not enforced against him — deciding how many picks a segment carries is
 * the whole point of a menu-increase approval, so whatever he leaves ticked becomes the
 * sanctioned count. `approved_extra_picks` is moved up (or down) to match, which is what makes
 * a tick an approval and an untick a refusal without a second decision step.
 */
async function applyMenuEdit(tx: Tx, actor: Actor, eventId: string, m: MenuEdit): Promise<string[]> {
  const [menu] = (await tx.execute(sql`
    SELECT mu.id AS "menuId", se.name AS "subEventName", c.base_pick AS "basePick",
           c.extra_picks AS "extraPicks", c.approved_extra_picks AS "approvedExtraPicks",
           c.submitted_extra_picks AS "submittedExtraPicks"
      FROM sub_event_menus mu
      JOIN sub_events se ON se.id = mu.sub_event_id
      JOIN sub_event_menu_categories c ON c.menu_id = mu.id AND c.category_name = ${m.categoryName}
     WHERE mu.sub_event_id = ${m.subEventId} AND se.event_id = ${eventId}
  `)) as unknown as { menuId: string; subEventName: string; basePick: number | null; extraPicks: number; approvedExtraPicks: number; submittedExtraPicks: number }[]
  if (!menu) throw notFound(`No “${m.categoryName}” on that function's menu.`)

  // pick_count NULL means every item in the category is included (SEED_ASSUMPTIONS). It is
  // read-only in the manager's picker and it stays read-only here — there is no "some" to pick.
  if (menu.basePick == null) {
    throw badRequest(`“${m.categoryName}” includes every item — there is nothing to tick or untick.`)
  }

  const dishes = [...new Set(m.dishes.map((d) => d.trim()).filter(Boolean))]

  // Validated against the POOLED master menu, not the tier's own list: a guest may take a Gold
  // dessert on a Silver plate and it simply spends a pick (19 Jul 2026). The GM picks from the
  // same pool the Booking Manager did — he may overrule the count, not invent a dish.
  if (dishes.length) {
    const valid = (await tx.execute(sql`
      SELECT DISTINCT i.name FROM menu_items i
        JOIN menu_categories c ON c.id = i.category_id
       WHERE i.is_active AND c.name = ${m.categoryName}
    `)) as unknown as { name: string }[]
    const allowed = new Set(valid.map((v) => v.name))
    const unknown = dishes.filter((d) => !allowed.has(d))
    if (unknown.length) {
      throw badRequest(`Not on the ${m.categoryName} menu: ${unknown.join(', ')}.`)
    }
  }

  const before = (await tx.execute(sql`
    SELECT item_name AS "itemName" FROM sub_event_menu_selections
     WHERE menu_id = ${menu.menuId} AND category_name = ${m.categoryName}
     ORDER BY item_name
  `)) as unknown as { itemName: string }[]
  const had = new Set(before.map((b) => b.itemName))
  const added = dishes.filter((d) => !had.has(d))
  const dropped = [...had].filter((d) => !dishes.includes(d))
  if (!added.length && !dropped.length) return []

  const extras = Math.max(0, dishes.length - menu.basePick)

  await tx.execute(sql`
    DELETE FROM sub_event_menu_selections
     WHERE menu_id = ${menu.menuId} AND category_name = ${m.categoryName}
  `)
  if (dishes.length) {
    // The first base_pick dishes are the included ones; anything past that is an extra, which
    // is what colours it in the picker and what the Authority was asked about.
    await tx.execute(sql`
      INSERT INTO sub_event_menu_selections (menu_id, category_name, item_name, is_extra)
      VALUES ${sql.join(
        dishes.map((d, i) => sql`(${menu.menuId}, ${m.categoryName}, ${d}, ${i >= menu.basePick!})`),
        sql`, `,
      )}
    `)
  }
  // All three counters move together, and they must: the table checks
  // `submitted_extra_picks >= approved_extra_picks AND submitted_extra_picks <= extra_picks`
  // (migration 0013). Carrying the old, lower `submitted` forward while raising `approved`
  // broke the first half and the whole save failed on a constraint.
  //
  // Setting all three to the surviving count is also what the act MEANS. The three counters
  // exist to track a request travelling from the manager to the Authority — taken, sent,
  // granted. When the Authority himself decides by ticking, that journey happens in one
  // moment: nothing he leaves ticked is still awaiting his own decision.
  await tx.execute(sql`
    UPDATE sub_event_menu_categories
       SET extra_picks = ${extras},
           approved_extra_picks = ${extras},
           submitted_extra_picks = ${extras}
     WHERE menu_id = ${menu.menuId} AND category_name = ${m.categoryName}
  `)
  // Recomputed, never forced: dropping an extra leaves the base picks intact, so the menu is
  // usually still complete and must not be left blocking the lock checklist.
  await tx.execute(sql`
    UPDATE sub_event_menus mu
       SET is_complete = NOT EXISTS (
         SELECT 1 FROM sub_event_menu_categories c
          WHERE c.menu_id = mu.id AND c.base_pick IS NOT NULL
            AND (SELECT count(*) FROM sub_event_menu_selections s
                  WHERE s.menu_id = c.menu_id AND s.category_name = c.category_name) < c.base_pick
       )
     WHERE mu.id = ${menu.menuId}
  `)

  await audit(tx, actor, {
    entity: 'sub_event_menu_selections',
    entityId: menu.menuId,
    eventId,
    action: 'update',
    field: `${menu.subEventName} · ${m.categoryName}`,
    oldValue: [...had].sort().join(', ') || '(none)',
    newValue: dishes.join(', ') || '(none)',
  })

  const parts: string[] = []
  if (added.length) parts.push(`+${added.join(', ')}`)
  if (dropped.length) parts.push(`−${dropped.join(', ')}`)
  return [`${menu.subEventName} · ${m.categoryName}: ${parts.join(' ')}`]
}

/**
 * Replaces the room booking. The lodge's physical inventory still bounds it — the Authority
 * can approve a request for 40 rooms, but he cannot conjure a 41st room that does not exist,
 * and the same in-transaction availability check the Lodge Manager meets decides that.
 *
 * The 35+ rule (BR-L2) is an approval, and he IS the approver, so crossing the threshold here
 * does not raise a fresh request against himself — it settles any that was pending.
 */
async function applyRoomEdit(tx: Tx, actor: Actor, eventId: string, rooms: RoomEdit[]): Promise<string[]> {
  const existing = (await tx.execute(sql`
    SELECT unit_id AS "unitId", room_type AS "roomType", count::int AS count,
           check_in::text AS "checkIn", check_out::text AS "checkOut"
      FROM room_requirements WHERE event_id = ${eventId}
     ORDER BY unit_id, room_type, check_in, check_out
  `)) as unknown as RoomEdit[]

  // An unchanged submission must be a no-op, not a rewrite. The screen sends the whole room
  // list whenever it is touched at all, and treating an identical list as a change would log
  // a phantom edit and — on a billed booking — burn a document number re-issuing the same bill.
  const key = (r: RoomEdit) => `${r.unitId}|${r.roomType}|${r.count}|${r.checkIn}|${r.checkOut}`
  const sorted = [...rooms].sort((a, b) => key(a).localeCompare(key(b)))
  if (existing.length === rooms.length && existing.every((e, i) => key(e) === key(sorted[i]!))) {
    return []
  }

  for (const r of rooms) {
    if (!Number.isInteger(r.count) || r.count <= 0) throw badRequest('Room count must be a positive whole number.')
    if (!ISO_DATE.test(r.checkIn) || !ISO_DATE.test(r.checkOut)) throw badRequest('Invalid room dates.')
    if (r.checkOut <= r.checkIn) throw badRequest('Check-out must be after check-in.')
  }

  if (rooms.length) {
    const availability = await getRoomAvailability(rooms, eventId, tx)
    const over = rooms.map((r, i) => ({ r, a: availability[i]! })).filter(({ r, a }) => r.count > a.available)
    if (over.length) {
      const detail = over
        .map(({ r, a }) => `${r.count} × ${r.roomType} (only ${a.available} of ${a.total} free ${r.checkIn}–${r.checkOut})`)
        .join('; ')
      throw conflict(`More rooms than the lodge has free — ${detail}. This is the building, not a rule that can be waived.`)
    }
  }

  await tx.delete(schema.roomRequirements).where(eq(schema.roomRequirements.eventId, eventId))
  if (rooms.length) {
    await tx.insert(schema.roomRequirements).values(
      rooms.map((r) => ({ eventId, unitId: r.unitId, roomType: r.roomType, count: r.count, checkIn: r.checkIn, checkOut: r.checkOut })),
    )
  }

  const totalRooms = rooms.reduce((n, r) => n + r.count, 0)
  const wasRooms = existing.reduce((n, r) => n + r.count, 0)

  await audit(tx, actor, {
    entity: 'room_requirements',
    entityId: eventId,
    eventId,
    action: 'update',
    field: 'requirements',
    oldValue: `${existing.length} line(s), ${wasRooms} room(s)`,
    newValue: `${rooms.length} line(s), ${totalRooms} room(s)`,
  })
  return [`rooms ${wasRooms} → ${totalRooms} (${rooms.length} line(s))`]
}

/**
 * Records a discount given directly by the Authority — uncapped, effective at once.
 *
 * BR-D2 holds the combined discount to 10% of the bill and sends anything over it to the
 * Higher Authority. When the Higher Authority is the one giving it, that round trip has no
 * one at the other end: the row is written with no `exception_id`, which is precisely what
 * `effectiveDiscountPaise` reads as "in force". A rupee figure is stored as a fixed amount
 * (BR-D2 amended, 1 Aug 2026); a percentage still recomputes live against its head.
 */
async function addAuthorityDiscount(tx: Tx, actor: Actor, eventId: string, input: DiscountEdit): Promise<string> {
  const hasPct = input.percentBp != null
  const hasAmt = input.amountPaise != null
  if (hasPct === hasAmt) throw badRequest('Give either a percentage or a rupee amount — exactly one.')
  if (hasAmt && (!Number.isInteger(input.amountPaise!) || input.amountPaise! <= 0)) {
    throw badRequest('A discount amount must be a positive whole number of paise.')
  }
  if (hasPct && (input.percentBp! <= 0 || input.percentBp! > 10_000)) {
    throw badRequest('Percentage must be between 0 and 100.')
  }
  if (!input.remark.trim()) throw badRequest('A remark is required for every discount (FR-11.1).')
  if (!['menu', 'venue', 'room', 'overall'].includes(input.head)) {
    throw badRequest('Head must be menu, venue, room or overall.')
  }

  const [disc] = await tx
    .insert(schema.discounts)
    .values({
      eventId,
      head: input.head as 'menu',
      percentBp: hasPct ? input.percentBp! : null,
      amountPaise: hasAmt ? input.amountPaise! : 0,
      remark: input.remark.trim(),
      exceptionId: null,
      givenBy: actor.id,
    })
    .returning({ id: schema.discounts.id })

  const label = hasPct ? `${input.percentBp! / 100}% of ${input.head}` : formatPaise(input.amountPaise!)
  await audit(tx, actor, {
    entity: 'discounts',
    entityId: disc!.id,
    eventId,
    action: 'insert',
    field: input.head,
    newValue: `${label} — Authority, uncapped (${input.remark.trim()})`,
  })
  return `${input.head} discount ${label} given`
}

/**
 * The standalone entry point: the Authority edits a proposal without deciding anything.
 * `applyGmProposalEdits` is the composable half, used by the bundle decision.
 */
export async function editProposalAsAuthority(
  actor: Actor,
  eventId: string,
  edits: GmProposalEdits,
): Promise<GmEditResult> {
  return db.transaction(async (tx) => applyGmProposalEdits(tx, actor, eventId, edits))
}

/** Whether this actor may edit this event through the Authority path, and what saving will do. */
export function authorityEditContext(status: string, actor: Actor) {
  return {
    canEdit: AUTHORITY_ROLES.has(actor.roleName) && status !== 'cancelled',
    overridesLock: LOCKED_STATES.has(status),
    reissuesInvoice: REISSUE_STATES.has(status),
  }
}
