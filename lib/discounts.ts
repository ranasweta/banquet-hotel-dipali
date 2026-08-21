import 'server-only'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { percentOfPaise } from '@/lib/money'
import { AUTHORITY_ROLES } from '@/lib/post-confirm'
import { getIntSettings } from '@/lib/settings'
import { priceProposal } from '@/lib/pricing'
import { ROOM_GST_HIGH_BP, roomGstBp, taxOf } from '@/lib/tax'

/**
 * Discounts (M7, FR-11.x, BR-D2).
 *
 * A DISCOUNT IS THE PRICE WE ARE ACTUALLY CHARGING — not money taken off (client, 20 Aug 2026,
 * after the staff used the old panel in the field; see migration 0036). Every priced line
 * carries two figures: the ACTUAL, which is the rate card / menu snapshot / rack rate and never
 * moves, and the DISCOUNTED, prefilled with the actual and overwritten with what the guest is
 * really paying. Nothing is subtracted on screen or on the document, and the guest reads both
 * columns side by side.
 *
 * WHAT IS STORED IS THE GAP. `amount_paise` on a line row is (actual − discounted), never the
 * typed price, because "the Billing figure always follows the live feeding of pax, menu,
 * everything as it is" (client, same day). Pax moves, menus are swapped, rate cards are
 * re-dated; a frozen rupee price in the Discounted column would stop tracking the instant any
 * of that happened, while a gap keeps the column live:
 *
 *     Food, 250 pax × ₹700 = ₹1,75,000 actual.  Typed ₹1,50,000  →  gap ₹25,000.
 *     Pax later 300 → actual ₹2,10,000, and Discounted reads ₹1,85,000.
 *
 * A FLAT gap, not a per-plate one (client, asked and answered on 20 Aug): what is typed is what
 * the guest gets, the same rule the 4 Aug amendment settled for the old rupee amounts. Every
 * reader clamps at the line — `max(0, actual − gap)` — so a line that later shrinks below what
 * was given becomes free rather than a credit.
 *
 * THE LINE KEY, and why it is text rather than `ref_id`. Saving room requirements deletes and
 * re-inserts every row (rule 9), so a room discount pointing at a `room_requirements.id` would
 * be orphaned the next time anyone touched the rooms. A line is identified by what it IS:
 *
 *     venue:<sub_event_id>              the day's hire, on the function that carries it
 *     food:<sub_event_id>               pax × the snapshotted per-plate rate
 *     room:<unit|->:<type>:<in>:<out>   one category-and-stay line of the bulk booking
 *
 * TAX FOLLOWS THE MONEY (client, 20 Aug: "the money we will be collecting is what will be
 * taxed"). The 5%/18% on rooms is charged on the DISCOUNTED line, and the band is re-read off
 * the DISCOUNTED nightly rate — an ₹11,000 suite given for ₹7,000 a night is a 5% room. The
 * shown-and-never-collected 18% on venue and food is computed on the discounted figure too, so
 * the printed Total agrees with the columns above it. This is why the gap has to reach
 * `payableRows` and `computeBillLines` line by line instead of being one subtraction at the end.
 *
 * THE OLD LUMP DISCOUNTS SURVIVE (client, 20 Aug: "keep what we've already recorded as promised
 * to our guests"). A row with `line_key IS NULL` is one of them: it is subtracted at the end of
 * the bill exactly as it always was and, having no line to attach to, moves no tax. Nothing new
 * writes one from the UI; `addDiscount` remains for the Authority's bundled edits and for the
 * approval path that created them.
 *
 * THE 10% CAP IS UNCHANGED (BR-D2). It measures the same combined figure — every clamped gap
 * plus any surviving lump — against 10% of the total bill, and a save that crosses it goes to
 * the Higher Authority as ONE pending exception carrying every cell in that save. The Authority
 * is not bound by it (FR-11.3a) wherever he gives it, and his rows carry no exception. The
 * remark is no longer required (client, 20 Aug: "one per save, but not mandatory"), which
 * reverses FR-11.1 — the audit row still names who moved which line from what to what.
 */

const LOCKED_STATES = new Set(['locked', 'billed', 'closed'])
const LEDGER_HEADS = new Set(['menu', 'venue', 'room', 'overall'])
const MAX_BP = 10_000 // 100%
const APPROVED = ['approved', 'approved_modified']

/** The `discount_head` a line key belongs to, so head-keyed reporting still reads sensibly. */
const HEAD_OF_PREFIX: Record<string, string> = { venue: 'venue', food: 'menu', room: 'room' }

/** The stable identity of one room line: the category and the stay, not the row's id. */
export function roomLineKey(r: { unitId: string | null; roomType: string; checkIn: string; checkOut: string }): string {
  return `room:${r.unitId ?? '-'}:${r.roomType}:${r.checkIn}:${r.checkOut}`
}
/** The same key built in SQL, from a `room_requirements` alias. Written once, read by three files. */
export function roomLineKeySql(rr: string): SQL {
  return sql.raw(
    `('room:' || COALESCE(${rr}.unit_id::text, '-') || ':' || ${rr}.room_type || ':' || ${rr}.check_in::text || ':' || ${rr}.check_out::text)`,
  )
}

/**
 * The effective gap on one line, as a scalar sub-query — zero when the line has no discount or
 * when its discount is still waiting on the Authority. `payableRows`, `computeBillLines` and the
 * sheet below all price a line as `max(0, actual − this)`, so the three cannot disagree about
 * what a guest owes.
 */
export function effectiveGapSql(eventId: SQL, lineKey: SQL): SQL {
  return sql`COALESCE((SELECT d.amount_paise FROM discounts d
                        LEFT JOIN exceptions x ON x.id = d.exception_id
                       WHERE d.event_id = ${eventId} AND d.line_key = ${lineKey}
                         AND (d.exception_id IS NULL OR x.status::text IN ('approved','approved_modified'))), 0)::bigint`
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// The sheet: every discountable line, its actual price and its discounted one.
// ────────────────────────────────────────────────────────────────────────────────────────────

export type SheetLine = {
  /** The line key — what a save sends back. */
  key: string
  label: string
  actualPaise: number
  discountedPaise: number
  /** Whether this line's discount is still waiting on the Authority (shown, not applied). */
  pending: boolean
}
export type SheetRoomLine = SheetLine & {
  count: number
  nights: number
  /** Rack/frozen rate for one night, undiscounted — what the Actual column's arithmetic reads. */
  ratePaise: number
  /** The band this line is taxed at, off the DISCOUNTED nightly rate (client, 20 Aug 2026). */
  gstRateBp: number
  taxPaise: number
}
export type SheetFunction = {
  subEventId: string
  name: string
  eventDate: string
  startTime: string
  endTime: string
  pax: number
  venue: SheetLine
  food: SheetLine | null
  actualSubtotalPaise: number
  discountedSubtotalPaise: number
}
export type SheetRoomGroup = {
  unitId: string | null
  lodgeName: string | null
  lines: SheetRoomLine[]
  actualSubtotalPaise: number
  discountedSubtotalPaise: number
}
export type DiscountSheet = {
  functions: SheetFunction[]
  roomGroups: SheetRoomGroup[]
  /** Room GST on the ACTUAL prices, so the Actual column totals to something a guest can check. */
  roomsTaxActualPaise: number
  /** Room GST on what is collected — the figure that enters the payable and the balance. */
  roomsTaxPaise: number
  actualTotalPaise: number
  discountedTotalPaise: number
  /** Σ (actual − discounted) across every line, clamped. The old lump rows are NOT in it. */
  lineDiscountPaise: number
  /** Pre-20-Aug-2026 lump discounts, still effective and still subtracted at the end. */
  lumpDiscountPaise: number
  /** Whether any room on this booking is over ₹7,500 a night, so a label can say which bands apply. */
  hasHighTaxRoom: boolean
  /** No rate card for these functions (BR-R1) — confirm is blocked until one exists. */
  missing: { subEventId: string; name: string }[]
}

/** Every line gap on the event, effective and pending alike, so a screen can show both. */
async function gapRows(
  eventId: string,
  exec: Pick<typeof db, 'execute'> = db,
): Promise<Map<string, { gapPaise: number; pending: boolean }>> {
  const rows = (await exec.execute(sql`
    SELECT d.line_key AS "lineKey", d.amount_paise AS "amountPaise", x.status::text AS "excStatus"
    FROM discounts d LEFT JOIN exceptions x ON x.id = d.exception_id
    WHERE d.event_id = ${eventId} AND d.line_key IS NOT NULL
  `)) as unknown as { lineKey: string; amountPaise: number; excStatus: string | null }[]
  const map = new Map<string, { gapPaise: number; pending: boolean }>()
  for (const r of rows) {
    const effective = r.excStatus == null || APPROVED.includes(r.excStatus)
    // A rejected row is dead: it neither applies nor waits, and showing it as pending would
    // leave the counter chasing a decision that has already been made.
    if (!effective && r.excStatus === 'rejected') continue
    map.set(r.lineKey, { gapPaise: Number(r.amountPaise), pending: !effective })
  }
  return map
}

/**
 * Every line's effective gap, for a reader that already has the actuals in hand and only needs
 * to know what to take off them — `lib/proposal.ts`, which builds the printed document from its
 * own queries. A pending gap is absent: it is not in force until the Authority says so.
 */
export async function effectiveLineGaps(
  eventId: string,
  exec: Pick<typeof db, 'execute'> = db,
): Promise<Map<string, number>> {
  const rows = await gapRows(eventId, exec)
  const out = new Map<string, number>()
  for (const [key, g] of rows) if (!g.pending) out.set(key, g.gapPaise)
  return out
}

/**
 * The event's lump (pre-20-Aug) discounts that are in force. This is what still comes off at the
 * END of the bill; every line discount has already been applied to the line it prices, so adding
 * the two together anywhere would take the same money off twice.
 */
export async function lumpDiscountPaise(eventId: string, exec: Pick<typeof db, 'execute'> = db): Promise<number> {
  const subs = await headSubtotals(eventId, exec)
  const rows = (await exec.execute(sql`
    SELECT d.head::text AS head, d.percent_bp AS "percentBp", d.amount_paise AS "amountPaise",
           d.exception_id AS "exceptionId", x.status::text AS "excStatus"
    FROM discounts d LEFT JOIN exceptions x ON x.id = d.exception_id
    WHERE d.event_id = ${eventId} AND d.line_key IS NULL
  `)) as unknown as { head: string; percentBp: number | null; amountPaise: number; exceptionId: string | null; excStatus: string | null }[]
  const [alloc] = (await exec.execute(
    sql`SELECT COALESCE(sum(discount_paise), 0)::bigint AS total FROM room_allocations WHERE event_id = ${eventId}`,
  )) as unknown as { total: number }[]

  let total = Number(alloc!.total)
  for (const r of rows) {
    if (r.exceptionId && !APPROVED.includes(r.excStatus ?? '')) continue
    total += discountAmountPaise(
      { head: r.head, percentBp: r.percentBp == null ? null : Number(r.percentBp), amountPaise: Number(r.amountPaise) },
      subs,
    )
  }
  return total
}

/**
 * The Actual | Discounted sheet for one event — the single server-side answer to "what does
 * each line cost and what are we charging for it", read by the payment review, the billing
 * panel, the approvals queue, and the printed proposal. The screens render it; none of them
 * recompute it, which is the only way the four can agree once tax depends on the discount.
 */
export async function discountSheet(eventId: string, exec: Pick<typeof db, 'select' | 'execute'> = db): Promise<DiscountSheet> {
  const [ev] = await exec
    .select({ eventType: schema.events.eventType })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1)
  if (!ev) throw notFound('Event not found')

  const [gaps, subs, roomRows] = await Promise.all([
    gapRows(eventId, exec),
    exec.execute(sql`
      SELECT se.id, se.name, se.event_date::text AS "eventDate", se.start_time::text AS "startTime",
             se.end_time::text AS "endTime", se.pax::int AS pax,
             se.venue_id AS "venueId", se.bundle_id AS "bundleId",
             se.venue_rate_paise AS "venueRatePaise",
             COALESCE(v.name, b.name) AS "venueName",
             m.tier_name AS "tierName", (m.base_rate_paise + m.surcharge_paise) AS "perPlate"
      FROM sub_events se
      LEFT JOIN venues v ON v.id = se.venue_id
      LEFT JOIN venue_bundles b ON b.id = se.bundle_id
      LEFT JOIN sub_event_menus m ON m.sub_event_id = se.id
      WHERE se.event_id = ${eventId}
      ORDER BY se.event_date, se.start_time
    `) as unknown as Promise<{
      id: string; name: string; eventDate: string; startTime: string; endTime: string; pax: number
      venueId: string | null; bundleId: string | null; venueRatePaise: number; venueName: string | null
      tierName: string | null; perPlate: number | null
    }[]>,
    exec.execute(sql`
      SELECT rr.unit_id AS "unitId", u.name AS "lodgeName", rr.room_type AS "roomType",
             rr.count::int AS count, (rr.check_out - rr.check_in)::int AS nights,
             rr.check_in::text AS "checkIn", rr.check_out::text AS "checkOut",
             COALESCE(rr.rate_paise, (SELECT min(r.rack_rate_paise) FROM rooms r
                        WHERE r.room_type = rr.room_type AND r.is_active
                          AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)), 0)::bigint AS "ratePaise"
      FROM room_requirements rr
      LEFT JOIN lodging_units u ON u.id = rr.unit_id
      WHERE rr.event_id = ${eventId}
      ORDER BY u.name NULLS FIRST, rr.room_type, rr.check_in
    `) as unknown as Promise<{
      unitId: string | null; lodgeName: string | null; roomType: string; count: number
      nights: number; checkIn: string; checkOut: string; ratePaise: number
    }[]>,
  ])

  // The venue charge comes from lib/pricing.ts, never from a second copy of the rule here: the
  // hall is hired by the DAY and the day's earliest function carries the whole let (rule 3).
  // A covered function shows ₹0 against its venue, which is what the guest is being charged.
  const pricing = await priceProposal(
    ev.eventType,
    subs.map((s) => ({ id: s.id, name: s.name, eventDate: s.eventDate, startTime: s.startTime, endTime: s.endTime, venueId: s.venueId, bundleId: s.bundleId })),
    exec,
  )

  const line = (key: string, label: string, actualPaise: number): SheetLine => {
    const g = gaps.get(key)
    // A pending gap is DISPLAYED but not applied — the Authority has not agreed to it yet, and
    // a counter that collected on it would be short the moment he said no.
    const gapPaise = g && !g.pending ? g.gapPaise : 0
    return {
      key,
      label,
      actualPaise,
      discountedPaise: Math.max(0, actualPaise - gapPaise),
      pending: Boolean(g?.pending),
    }
  }

  const functions: SheetFunction[] = subs.map((s) => {
    // The same COALESCE the bill uses: the confirm-time snapshot when there is one, the rate
    // card otherwise. Reading only the card would price a confirmed booking at today's rates
    // and put a different Actual on this screen than on the guest's document. A function whose
    // venue-day is already paid for carries zero, which `priceProposal` has already decided.
    const covered = pricing.coveredBy.has(s.id)
    const snapshot = Number(s.venueRatePaise ?? 0)
    const venueActual = covered ? 0 : snapshot > 0 ? snapshot : (pricing.rates.get(s.id) ?? 0)
    const venue = line(`venue:${s.id}`, `Venue — ${s.venueName ?? 'not chosen'}`, venueActual)
    const food =
      s.perPlate == null
        ? null
        : line(
            `food:${s.id}`,
            `Food — ${s.tierName}, ${s.pax} pax × ${Number(s.perPlate) / 100}/plate`,
            s.pax * Number(s.perPlate),
          )
    return {
      subEventId: s.id,
      name: s.name,
      eventDate: s.eventDate,
      startTime: s.startTime,
      endTime: s.endTime,
      pax: s.pax,
      venue,
      food,
      actualSubtotalPaise: venue.actualPaise + (food?.actualPaise ?? 0),
      discountedSubtotalPaise: venue.discountedPaise + (food?.discountedPaise ?? 0),
    }
  })

  const groups = new Map<string, SheetRoomGroup>()
  let roomsTaxPaise = 0
  let roomsTaxActualPaise = 0
  let hasHighTaxRoom = false
  for (const r of roomRows) {
    const qty = Math.max(0, r.count) * Math.max(0, r.nights)
    const rate = Number(r.ratePaise)
    const key = roomLineKey({ unitId: r.unitId, roomType: r.roomType, checkIn: r.checkIn, checkOut: r.checkOut })
    const base = line(
      key,
      `${titleCase(r.roomType)} — ${r.count} room${r.count === 1 ? '' : 's'} × ${r.nights} night${r.nights === 1 ? '' : 's'}`,
      qty * rate,
    )
    // The band is re-read off what we are ACTUALLY charging for a night (client, 20 Aug 2026):
    // an ₹11,000 suite given for ₹7,000 a night is a 5% room, because ₹7,000 is what is
    // collected on it. Still the nightly figure and never the line total — six nights of a
    // ₹5,000 room is 5%, not 18% (rule 11).
    const effectiveNightly = qty > 0 ? Math.round(base.discountedPaise / qty) : 0
    const gstRateBp = roomGstBp(effectiveNightly, r.roomType)
    const taxPaise = taxOf(base.discountedPaise, gstRateBp)
    roomsTaxPaise += taxPaise
    roomsTaxActualPaise += taxOf(base.actualPaise, roomGstBp(rate, r.roomType))
    if (roomGstBp(rate, r.roomType) === ROOM_GST_HIGH_BP) hasHighTaxRoom = true

    const gk = r.unitId ?? '-'
    if (!groups.has(gk)) {
      groups.set(gk, { unitId: r.unitId, lodgeName: r.lodgeName, lines: [], actualSubtotalPaise: 0, discountedSubtotalPaise: 0 })
    }
    const g = groups.get(gk)!
    g.lines.push({ ...base, count: r.count, nights: r.nights, ratePaise: rate, gstRateBp, taxPaise })
    g.actualSubtotalPaise += base.actualPaise
    g.discountedSubtotalPaise += base.discountedPaise
  }
  const roomGroups = [...groups.values()]

  const actualTotalPaise =
    functions.reduce((n, f) => n + f.actualSubtotalPaise, 0) +
    roomGroups.reduce((n, g) => n + g.actualSubtotalPaise, 0) +
    roomsTaxActualPaise
  const discountedTotalPaise =
    functions.reduce((n, f) => n + f.discountedSubtotalPaise, 0) +
    roomGroups.reduce((n, g) => n + g.discountedSubtotalPaise, 0) +
    roomsTaxPaise

  return {
    functions,
    roomGroups,
    roomsTaxActualPaise,
    roomsTaxPaise,
    actualTotalPaise,
    discountedTotalPaise,
    // Pre-tax, because that is what the 10% cap measures and what "you saved this much" means.
    lineDiscountPaise:
      functions.reduce((n, f) => n + f.actualSubtotalPaise - f.discountedSubtotalPaise, 0) +
      roomGroups.reduce((n, g) => n + g.actualSubtotalPaise - g.discountedSubtotalPaise, 0),
    lumpDiscountPaise: await lumpDiscountPaise(eventId, exec),
    hasHighTaxRoom,
    missing: pricing.missing,
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// The 10% cap (BR-D2) — unchanged in substance, and now measured on the sheet.
// ────────────────────────────────────────────────────────────────────────────────────────────

type HeadSubtotals = { venue: number; menu: number; room: number; overall: number }

/**
 * The event's live per-head subtotals at their ACTUAL prices — what a legacy percentage row
 * recomputes against, and the base the cap is a percentage of. Deliberately undiscounted:
 * measuring the cap on prices a discount had already reduced would let each discount enlarge
 * the room the next one has.
 */
async function headSubtotals(eventId: string, exec: Pick<typeof db, 'execute'> = db): Promise<HeadSubtotals> {
  const [row] = (await exec.execute(sql`
    SELECT
      COALESCE((SELECT sum(COALESCE(NULLIF(se.venue_rate_paise, 0),
                 (SELECT rc.rate_paise FROM venue_rate_cards rc
                   WHERE ((se.venue_id IS NOT NULL AND rc.venue_id = se.venue_id)
                       OR (se.bundle_id IS NOT NULL AND rc.bundle_id = se.bundle_id))
                     AND rc.event_type = e.event_type
                     AND rc.effective_from <= se.event_date
                   ORDER BY rc.effective_from DESC LIMIT 1), 0))
                 FROM sub_events se JOIN events e ON e.id = se.event_id
                WHERE se.event_id = ${eventId}), 0)::bigint AS venue,
      (COALESCE((SELECT sum(se.pax::bigint * (m.base_rate_paise + m.surcharge_paise))
                   FROM sub_event_menus m JOIN sub_events se ON se.id = m.sub_event_id
                  WHERE se.event_id = ${eventId}), 0)
       + COALESCE((SELECT sum(a.qty::bigint * a.rate_paise)
                     FROM sub_event_addons a JOIN sub_events se ON se.id = a.sub_event_id
                    WHERE se.event_id = ${eventId}), 0))::bigint AS menu,
      COALESCE((SELECT sum(rr.count::bigint * (rr.check_out - rr.check_in)
                          * COALESCE(rr.rate_paise, (SELECT min(r.rack_rate_paise) FROM rooms r
                                       WHERE r.room_type = rr.room_type AND r.is_active
                                         AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)), 0))
                 FROM room_requirements rr WHERE rr.event_id = ${eventId}), 0)::bigint AS room
  `)) as unknown as { venue: number; menu: number; room: number }[]
  const venue = Number(row!.venue)
  const menu = Number(row!.menu)
  const room = Number(row!.room)
  return { venue, menu, room, overall: venue + menu + room }
}

/** The current rupee value of one LUMP discount row — a percentage of its head, or a fixed amount. */
function discountAmountPaise(
  row: { head: string; percentBp: number | null; amountPaise: number },
  subs: HeadSubtotals,
): number {
  if (row.percentBp != null) {
    return Math.round((subs[row.head as keyof HeadSubtotals] * row.percentBp) / MAX_BP)
  }
  return row.amountPaise
}

/**
 * Everything the guest has actually been given: every clamped line gap plus any surviving lump
 * row. This is what the cap measures and what a screen means by "less discounts". It is NOT
 * what the bill subtracts at the end — the line half of it is already off the lines themselves.
 */
export async function givenDiscountPaise(
  eventId: string,
  exec: Pick<typeof db, 'select' | 'execute'> = db,
): Promise<number> {
  const sheet = await discountSheet(eventId, exec)
  return sheet.lineDiscountPaise + sheet.lumpDiscountPaise
}

export type DiscountCap = {
  capPct: number
  /** The undiscounted bill the cap is a percentage of: venue + food + rooms, no tax. */
  capBasePaise: number
  capPaise: number
  /** Effective discounts already given — what is eaten out of the cap. */
  usedPaise: number
  /** capPaise − usedPaise, floored at zero: what a manager still has to give. */
  headroomPaise: number
}

/**
 * The 10% ceiling and how much of it is spent. One definition, read by the save below, by
 * confirm's re-test, and by the screen that warns a manager before he crosses it.
 *
 * A confirmed booking measures against its stored proposal total (venue+food) plus rooms; an
 * enquiry has no stored total yet, so it measures the live overall. Tax is in neither.
 */
export async function discountCap(
  eventId: string,
  exec: Pick<typeof db, 'execute' | 'select'> = db,
): Promise<DiscountCap> {
  const { discount_cap_pct } = await getIntSettings(['discount_cap_pct'] as const, { discount_cap_pct: 10 })
  const [ev] = await exec
    .select({ proposalTotalPaise: schema.events.proposalTotalPaise })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1)
  if (!ev) throw notFound('Event not found')
  const subs = await headSubtotals(eventId, exec)
  const capBasePaise = ev.proposalTotalPaise > 0 ? ev.proposalTotalPaise + subs.room : subs.overall
  const capPaise = percentOfPaise(capBasePaise, discount_cap_pct)
  const usedPaise = await givenDiscountPaise(eventId, exec)
  return {
    capPct: discount_cap_pct,
    capBasePaise,
    capPaise,
    usedPaise,
    headroomPaise: Math.max(0, capPaise - usedPaise),
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// The save: one Discounted column, one remark, one decision.
// ────────────────────────────────────────────────────────────────────────────────────────────

export type LineDiscountInput = { key: string; discountedPaise: number }
export type SetLineDiscountsResult = {
  deferred: boolean
  changed: number
  exceptionId?: string
  combinedPaise: number
  capPaise: number
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Writes the Discounted column. Every line named is set to the price being given — send the
 * actual back to clear a line's discount.
 *
 * ONE DECISION PER SAVE, not one per cell. A save whose combined discount crosses the 10% cap
 * goes to the Higher Authority as a single `discount_over_cap` request carrying every cell in
 * it, and none of those cells take effect until he approves. Splitting it per cell would leave
 * a booking half-discounted at a price nobody quoted, and would put six rows in his queue for
 * one conversation.
 *
 * `tx` is threaded through so the Authority's bundled edit applies this inside its own
 * transaction, under the override GUC, rather than in a second one that could half-commit.
 */
export async function setLineDiscounts(
  actor: Actor,
  eventId: string,
  lines: LineDiscountInput[],
  remark = '',
  tx?: Tx,
): Promise<SetLineDiscountsResult> {
  if (lines.length === 0) return { deferred: false, changed: 0, combinedPaise: 0, capPaise: 0 }
  for (const l of lines) {
    if (!Number.isInteger(l.discountedPaise) || l.discountedPaise < 0) {
      throw badRequest('A discounted price must be a whole number of paise, and never negative.')
    }
  }

  const run = async (t: Tx): Promise<SetLineDiscountsResult> => {
    const [ev] = await t.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1)
    if (!ev) throw notFound('Event not found')
    if (LOCKED_STATES.has(ev.status)) throw conflict('This event is locked — discounts can no longer change.')

    const sheet = await discountSheet(eventId, t)
    const actuals = new Map<string, { actual: number; label: string; wasPaise: number }>()
    for (const f of sheet.functions) {
      for (const l of [f.venue, f.food]) {
        if (l) actuals.set(l.key, { actual: l.actualPaise, label: `${f.name}: ${l.label}`, wasPaise: l.discountedPaise })
      }
    }
    for (const g of sheet.roomGroups) {
      for (const l of g.lines) {
        actuals.set(l.key, { actual: l.actualPaise, label: `${g.lodgeName ?? 'Lodge'}: ${l.label}`, wasPaise: l.discountedPaise })
      }
    }

    // The gaps this event carries once the save lands: what is effective already, with the
    // submitted cells written over it. Untouched lines keep what they had.
    const gaps = new Map<string, number>()
    for (const [key, meta] of actuals) {
      if (meta.actual > meta.wasPaise) gaps.set(key, meta.actual - meta.wasPaise)
    }
    for (const l of lines) {
      const meta = actuals.get(l.key)
      if (!meta) throw badRequest('That line is no longer on this booking — reload it and try again.')
      if (l.discountedPaise > meta.actual) {
        throw badRequest(`A discounted price cannot be more than the actual price (${meta.label}).`)
      }
      const gap = meta.actual - l.discountedPaise
      if (gap > 0) gaps.set(l.key, gap)
      else gaps.delete(l.key)
    }

    const combinedPaise = [...gaps.values()].reduce((n, g) => n + g, 0) + sheet.lumpDiscountPaise
    const { capBasePaise, capPaise } = await discountCap(eventId, t)
    // The cap routes a large discount TO the Authority; it has nothing to do when he is the one
    // giving it (FR-11.3a). His rows carry no exception, which is what every reader above takes
    // as "in force".
    const uncapped = AUTHORITY_ROLES.has(actor.roleName)
    const overCap = !uncapped && combinedPaise > capPaise

    // Whatever these lines held goes, pending request and all: one line holds one price, and a
    // superseded request must not sit in the queue waiting to overwrite the price that replaced it.
    const touched = sql.join(
      lines.map((l) => sql`${l.key}`),
      sql`, `,
    )
    const old = (await t.execute(sql`
      SELECT id, exception_id AS "exceptionId" FROM discounts
      WHERE event_id = ${eventId} AND line_key IN (${touched})
    `)) as unknown as { id: string; exceptionId: string | null }[]
    if (old.length > 0) {
      await t.execute(sql`DELETE FROM discounts WHERE event_id = ${eventId} AND line_key IN (${touched})`)
      for (const o of old) {
        if (o.exceptionId) {
          await t.delete(schema.exceptions).where(and(eq(schema.exceptions.id, o.exceptionId), eq(schema.exceptions.status, 'pending')))
        }
      }
    }

    const writes = lines.filter((l) => (gaps.get(l.key) ?? 0) > 0)
    let exceptionId: string | null = null
    if (overCap && writes.length > 0) {
      const [exc] = await t
        .insert(schema.exceptions)
        .values({
          eventId,
          kind: 'discount_over_cap',
          status: 'pending',
          payload: {
            // `amountPaise` is what the approvals queue prints in its one-line summary, so it
            // stays the headline figure: the combined discount this save would put in force.
            amountPaise: combinedPaise,
            combinedPaise,
            capPaise,
            capBasePaise,
            remark,
            lines: writes.map((l) => ({
              key: l.key,
              label: actuals.get(l.key)!.label,
              actualPaise: actuals.get(l.key)!.actual,
              discountedPaise: l.discountedPaise,
            })),
          },
          raisedBy: actor.id,
        })
        .returning({ id: schema.exceptions.id })
      exceptionId = exc!.id
    }

    for (const l of writes) {
      const prefix = l.key.split(':')[0]!
      await t.insert(schema.discounts).values({
        eventId,
        head: (HEAD_OF_PREFIX[prefix] ?? 'overall') as 'menu',
        lineKey: l.key,
        percentBp: null,
        amountPaise: gaps.get(l.key)!,
        remark,
        exceptionId,
        givenBy: actor.id,
      })
    }

    // Line by line, in rupees, so the trail says which price moved and to what — not "the
    // discounts changed". This is the whole record now that the remark is optional.
    let changed = 0
    for (const l of lines) {
      const meta = actuals.get(l.key)!
      if (meta.wasPaise === l.discountedPaise) continue
      changed += 1
      await audit(t, actor, {
        entity: 'discounts',
        entityId: eventId,
        eventId,
        action: 'update',
        field: meta.label,
        oldValue: rupees(meta.wasPaise),
        newValue: `${rupees(l.discountedPaise)} of ${rupees(meta.actual)}${
          overCap ? ' (over cap — pending)' : uncapped && combinedPaise > capPaise ? ' (Authority, uncapped)' : ''
        }${remark ? ` — ${remark}` : ''}`,
      })
    }

    return {
      deferred: Boolean(exceptionId),
      changed,
      ...(exceptionId ? { exceptionId } : {}),
      combinedPaise,
      capPaise,
    }
  }
  return tx ? run(tx) : db.transaction(run)
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`
/** "executive_deluxe" → "Executive Deluxe". The category, not the whole sentence around it. */
const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// ────────────────────────────────────────────────────────────────────────────────────────────
// The lump discounts of before 20 Aug 2026. Nothing new writes one from a screen; they are kept
// because they were promised to guests, and `addDiscount` still serves the Authority's bundled
// edits and the approval path that created them.
// ────────────────────────────────────────────────────────────────────────────────────────────

export type DiscountInput = { head: string; percentBp?: number; amountPaise?: number; remark: string; refId?: string }
export type AddDiscountResult =
  | { deferred: false; discountId: string; combinedPaise: number; capPaise: number }
  | { deferred: true; discountId: string; exceptionId: string; combinedPaise: number; capPaise: number }

/**
 * Records a lump discount against a head — a rupee amount, or a percentage for the
 * approval-bundle path and older callers. Within the 10% cap it takes effect immediately; over
 * the cap it is saved linked to a pending `discount_over_cap` exception and takes effect only
 * on approval.
 */
export async function addDiscount(actor: Actor, eventId: string, input: DiscountInput): Promise<AddDiscountResult> {
  if (!LEDGER_HEADS.has(input.head)) {
    throw badRequest('Head must be menu, venue, room or overall.')
  }
  const hasPct = input.percentBp != null
  const hasAmt = input.amountPaise != null
  if (hasPct === hasAmt) throw badRequest('Give either a percentage or a rupee amount — exactly one.')
  if (hasPct && (input.percentBp! <= 0 || input.percentBp! > MAX_BP)) throw badRequest('Percentage must be between 0 and 100.')
  if (hasAmt && input.amountPaise! <= 0) throw badRequest('Discount amount must be positive')

  return db.transaction(async (tx) => {
    const [ev] = await tx
      .select({ status: schema.events.status })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1)
    if (!ev) throw notFound('Event not found')
    if (LOCKED_STATES.has(ev.status)) throw conflict('This event is locked — discounts can no longer change.')

    const subs = await headSubtotals(eventId, tx)
    const thisAmount = hasPct ? Math.round((subs[input.head as keyof HeadSubtotals] * input.percentBp!) / MAX_BP) : input.amountPaise!
    if (thisAmount <= 0) throw badRequest('This head has no charge to discount yet — price the proposal first.')

    const { capBasePaise, capPaise, usedPaise } = await discountCap(eventId, tx)
    const combinedPaise = usedPaise + thisAmount
    const uncapped = AUTHORITY_ROLES.has(actor.roleName)
    const overCap = !uncapped && combinedPaise > capPaise

    let exceptionId: string | null = null
    if (overCap) {
      const [exc] = await tx
        .insert(schema.exceptions)
        .values({
          eventId,
          kind: 'discount_over_cap',
          status: 'pending',
          payload: {
            head: input.head,
            percentBp: hasPct ? input.percentBp : null,
            amountPaise: thisAmount,
            remark: input.remark.trim(),
            combinedPaise,
            capPaise,
            capBasePaise,
          },
          raisedBy: actor.id,
        })
        .returning({ id: schema.exceptions.id })
      exceptionId = exc!.id
    }

    const [disc] = await tx
      .insert(schema.discounts)
      .values({
        eventId,
        head: input.head as 'menu',
        refId: input.refId ?? null,
        percentBp: hasPct ? input.percentBp! : null,
        amountPaise: thisAmount,
        remark: input.remark.trim(),
        exceptionId,
        givenBy: actor.id,
      })
      .returning({ id: schema.discounts.id })

    await audit(tx, actor, {
      entity: 'discounts',
      entityId: disc!.id,
      eventId,
      action: 'insert',
      field: input.head,
      newValue: `${hasPct ? `${input.percentBp! / 100}%` : rupees(thisAmount)}${
        overCap ? ' (over cap — pending)' : uncapped && combinedPaise > capPaise ? ' (Authority, uncapped)' : ''
      }`,
    })

    if (overCap) {
      await audit(tx, actor, {
        entity: 'exceptions',
        entityId: exceptionId!,
        eventId,
        action: 'insert',
        field: 'discount_over_cap',
        newValue: `combined ${rupees(combinedPaise)} > cap ${rupees(capPaise)}`,
      })
      return { deferred: true, discountId: disc!.id, exceptionId: exceptionId!, combinedPaise, capPaise }
    }
    return { deferred: false, discountId: disc!.id, combinedPaise, capPaise }
  })
}

export type DiscountRow = {
  id: string
  head: string
  percentBp: number | null
  amountPaise: number
  remark: string
  status: 'effective' | 'pending' | 'rejected'
  givenAt: string
}

/**
 * The event's LUMP discounts, each with its live rupee value and effective/pending/rejected tag.
 * Line discounts are not here — they are prices, and they are read off the sheet.
 */
export async function listDiscounts(eventId: string): Promise<DiscountRow[]> {
  const subs = await headSubtotals(eventId)
  const rows = (await db.execute(sql`
    SELECT d.id, d.head::text AS head, d.percent_bp AS "percentBp", d.amount_paise AS "amountPaise",
           d.remark, d.given_at AS "givenAt", x.status::text AS "excStatus", d.exception_id AS "exceptionId"
    FROM discounts d LEFT JOIN exceptions x ON x.id = d.exception_id
    WHERE d.event_id = ${eventId} AND d.line_key IS NULL
    ORDER BY d.given_at
  `)) as unknown as { id: string; head: string; percentBp: number | null; amountPaise: number; remark: string; givenAt: string; excStatus: string | null; exceptionId: string | null }[]

  return rows.map((r) => {
    const percentBp = r.percentBp == null ? null : Number(r.percentBp)
    return {
      id: r.id,
      head: r.head,
      percentBp,
      amountPaise: discountAmountPaise({ head: r.head, percentBp, amountPaise: Number(r.amountPaise) }, subs),
      remark: r.remark,
      status: !r.exceptionId
        ? 'effective'
        : r.excStatus === 'approved' || r.excStatus === 'approved_modified'
          ? 'effective'
          : r.excStatus === 'rejected'
            ? 'rejected'
            : 'pending',
      givenAt: r.givenAt,
    }
  })
}

/** Removes a lump discount (and its pending exception, if any). */
export async function deleteDiscount(actor: Actor, discountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [d] = await tx
      .select({ id: schema.discounts.id, eventId: schema.discounts.eventId, exceptionId: schema.discounts.exceptionId, head: schema.discounts.head })
      .from(schema.discounts)
      .where(eq(schema.discounts.id, discountId))
      .limit(1)
    if (!d) throw notFound('Discount not found')
    const [ev] = await tx.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, d.eventId)).limit(1)
    if (ev && LOCKED_STATES.has(ev.status)) throw conflict('This event is locked — discounts can no longer change.')

    await tx.delete(schema.discounts).where(eq(schema.discounts.id, discountId))
    // Clear a still-pending exception so it leaves the queue with the discount.
    if (d.exceptionId) {
      await tx
        .delete(schema.exceptions)
        .where(and(eq(schema.exceptions.id, d.exceptionId), eq(schema.exceptions.status, 'pending')))
    }
    await audit(tx, actor, { entity: 'discounts', entityId: discountId, eventId: d.eventId, action: 'delete', field: d.head, oldValue: 'removed' })
  })
}
