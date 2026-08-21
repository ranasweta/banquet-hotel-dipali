import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { notFound } from '@/lib/api'
import { effectiveLineGaps, listDiscounts, lumpDiscountPaise, roomLineKey, type DiscountRow } from '@/lib/discounts'
import { crossesMidnight, prevDay, toMinutes } from '@/lib/occupancy'
import { VENUE_DAY_CHANGEOVER } from '@/lib/pricing'
import { percentOfPaise } from '@/lib/money'
import { ADVANCE_PCT, WEDDING_MILESTONE_PCT } from '@/lib/payment-schedule'
import { ROOM_GST_HIGH_BP, STANDARD_GST_BP, roomGstBp, taxOf } from '@/lib/tax'

/**
 * The guest-facing proposal, shaped exactly like `Hotel-Dipali-Proposal-TEMPLATE_1.html`.
 *
 * The bill (`lib/invoice.ts`) flattens everything into priced lines, which is right for
 * billing and wrong for this document: the template needs *structure* — each function with
 * its own venue, food and menu snapshot beside it, rooms grouped by lodge with their stay
 * dates, and the venue/food/rooms/tax split called out at a glance. So this module reads the
 * same snapshots and returns them assembled rather than flattened.
 *
 * Money follows the rules the rest of the system already enforces:
 *  • Two taxes, two behaviours (client's lead, 4 Aug 2026). Rooms carry GST that is real —
 *    inside the payable amount, inside the advance base. Venue, food, add-ons and extras carry
 *    18% which is printed and collected from nobody. Both are rounded PER LINE then summed, the
 *    same order of operations as lib/invoice.ts, so this document and the Draft cannot differ
 *    by a rounding paisa.
 *  • A room's own rate decides its band — 18% above ₹7,500 a night, 5% at or under it (client,
 *    17 Aug 2026), and BOTH are collected. `totals.roomTaxSplit` carries the two halves with
 *    the money each was charged on, because the guest has to be able to see WHICH rooms took
 *    18% rather than read one blended figure and wonder.
 *  • Because the 18% is never taken, the document carries TWO totals: `displayTotalPaise`, the
 *    "Total" with all tax on it, and `totalPaise`, the amount actually payable. Printing one
 *    number would have staff collecting the wrong one.
 *  • The 25% advance base is (venue + food + add-ons) + rooms + room tax − discount, which is
 *    the formula `confirmEvent` actually enforces (lib/confirm.ts). Printing anything else
 *    would quote the guest a number the system then refuses to accept.
 *  • A venue with no rate card prices at NOTHING, never at zero (BR-R1) — `venueRatePaise` is
 *    null and the document prints "on approval" rather than inventing ₹0.00.
 */


export type ProposalContact = { phone: string; label: string | null }

export type ProposalAddon = { description: string; qty: number; ratePaise: number; amountPaise: number }

export type ProposalDish = { name: string; note: string | null; isExtra: boolean }

export type ProposalSegment = {
  name: string
  /** NULL = every item in the category is included; the picker renders it read-only. */
  basePick: number | null
  extraPicks: number
  picked: number
  dishes: ProposalDish[]
}

export type ProposalMenu = {
  /** Addresses the tier when the document is edited rather than printed (approval bundles). */
  tierId: string
  tierName: string
  baseRatePaise: number
  surchargePaise: number
  chefPaise: number
  perPlatePaise: number
  segments: ProposalSegment[]
}

export type ProposalFunction = {
  /**
   * Row identity. The printed template never uses these, but the Higher Authority's approval
   * screen edits this very document (lib/approval-bundles.ts) and has to say WHICH function,
   * venue or menu it is changing. Carried here rather than assembled by a near-duplicate
   * query, so the figures the GM edits are the figures the guest was shown.
   */
  id: string
  venueId: string | null
  bundleId: string | null
  name: string
  date: string
  startTime: string
  endTime: string
  /** end_time <= start_time — the window runs past midnight into the next day. */
  overnight: boolean
  pax: number
  venueName: string | null
  isBundle: boolean
  bundleMembers: string[]
  /**
   * null = no rate card for this venue + event type. A gate, never a zero (BR-R1).
   *
   * ZERO here means something different and is not a gate: the venue-day is already charged on
   * an earlier function (see `venueCoveredBy`). Hiring a hall takes it 8 AM to 7:59 next
   * morning, so however many functions run inside that window, the hire is one charge.
   */
  venueRatePaise: number | null
  /**
   * The hire before the Discounted column touched it (client, 20 Aug 2026). Equal to
   * `venueRatePaise` when nothing was given, and printed beside it when something was — the
   * whole point of the column is that the guest sees what the hall lists at as well as what
   * they are being charged.
   */
  venueActualPaise: number | null
  /**
   * The function whose day-hire already covers this one — same venue, same date — or null when
   * this function carries the charge itself. Printed instead of a second venue line, because a
   * blank where a charge used to be reads as an omission.
   */
  venueCoveredBy: string | null
  menu: ProposalMenu | null
  foodAmountPaise: number
  /** Pax × the per-plate rate before any discount — the Actual column's food figure. */
  foodActualPaise: number
  addons: ProposalAddon[]
  /** Bottles ordered for this function (12 Aug 2026). Printed as its own Alcohol section. */
  bar: ProposalBarLine[]
  subtotalPaise: number
  /** The sub-total at list price, so the two columns each add up on their own. */
  actualSubtotalPaise: number
}

export type ProposalBarLine = {
  brandName: string
  bottles: number
  ratePaise: number
  amountPaise: number
}

export type ProposalRoomLine = {
  id: string
  unitId: string | null
  roomType: string
  count: number
  checkIn: string
  checkOut: string
  nights: number
  ratePaise: number
  amountPaise: number
  /** count × nights × the rack/frozen rate, before the Discounted column. */
  actualAmountPaise: number
  /**
   * 500 or 1800 — the band this line's nightly rate and category put it in. Derived here so the
   * printed document can mark the 18% rooms without carrying its own copy of the threshold and
   * the dormitory carve-out, which is how the page and the bill would drift apart.
   */
  gstRateBp: number
}

export type ProposalLodge = {
  name: string
  lines: ProposalRoomLine[]
  rooms: number
  roomNights: number
  subtotalPaise: number
  actualSubtotalPaise: number
}

/** One side of the room-tax bifurcation: what was charged, and the tax it drew. */
export type RoomTaxBand = { basePaise: number; taxPaise: number }

/**
 * Room GST split by the ₹7,500-a-night threshold (client, 17 Aug 2026), booked rooms and the
 * Lodge Manager's extras together — one pair of lines, as the document prints them.
 *
 * Both halves are COLLECTED and both are already inside `roomsTaxPaise` / `extraRoomsTaxPaise`;
 * this exists so the document can say which is which. `high.basePaise` is zero on the ordinary
 * booking, and the 18% line is then simply not printed.
 */
export type RoomTaxSplit = { low: RoomTaxBand; high: RoomTaxBand }

export type ProposalPayment = {
  id: string
  kind: string
  amountPaise: number
  mode: string
  receiptNo: string
  receivedOn: string
}

export type ProposalDocument = {
  event: {
    code: string
    guestName: string
    eventType: string
    eventTypeLabel: string
    isWedding: boolean
    status: string
    plannedFrom: string | null
    plannedTo: string | null
    firstDate: string | null
    lastDate: string | null
  }
  contacts: ProposalContact[]
  functions: ProposalFunction[]
  lodges: ProposalLodge[]
  /**
   * The discount ledger behind `totals.discountPaise`. The printed template shows only the
   * single netted figure; the approval screen has to show the GM each row he can revise or
   * remove, including one still pending his own decision.
   */
  discounts: DiscountRow[]
  /**
   * Everything billed on actuals: the Lodge Manager's closed extras (extra rooms, in-room
   * dining), the Utensil Manager's closed plates, closed maintenance and the Auditor's
   * adjustments. Empty until they exist.
   */
  extras: ProposalAddon[]
  payments: ProposalPayment[]
  totals: {
    /** Venue + food + add-ons — the "proposal total" the glance tile and BR-D2 both mean. */
    proposalPaise: number
    roomsPaise: number
    /** GST on the booked rooms — 5% or 18% per line by the nightly rate. Collected either way. */
    roomsTaxPaise: number
    /** Extra rooms given during the event. A subset of `extrasPaise`, kept apart for its tax. */
    extraRoomsPaise: number
    /** GST on those — collected, like any room tax, and outside the advance base. */
    extraRoomsTaxPaise: number
    /**
     * `roomsTaxPaise + extraRoomsTaxPaise` bifurcated by the ₹7,500 band, so the document can
     * print "GST 5% — rooms" and "GST 18% — rooms over ₹7,500" as separate lines. A view of
     * the two figures above, never an addition to them.
     */
    roomTaxSplit: RoomTaxSplit
    extrasPaise: number
    /** Pre-20-Aug-2026 LUMP discounts only — the line discounts are already off the lines. */
    discountPaise: number
    /** Venue + food + add-ons at list price: what the Actual column adds up to. */
    actualProposalPaise: number
    /** Rooms at list price. */
    actualRoomsPaise: number
    /** actual − discounted across every line: what the guest was given, pre-tax. */
    lineDiscountPaise: number
    /** proposal + rooms + extras − discount, before tax. */
    subtotalPaise: number
    /**
     * The AMOUNT PAYABLE — subtotal plus the 5% on rooms, booked and extra alike. What the
     * advance, the wedding milestone and the balance are all measured against.
     */
    totalPaise: number
    /** 18% on venue, food, add-ons and extras. Printed; never collected, never in a threshold. */
    shownGstPaise: number
    /** What the document prints as "Total": payable + the 18% nobody pays. */
    displayTotalPaise: number
    advancePaise: number
    /** The wedding's 50% top-up, due 30 days before the first function (BR-P2, amended). */
    weddingMilestonePaise: number
    balancePaise: number
    advancesReceivedPaise: number
  }
  counts: { functions: number; pax: number; rooms: number; roomNights: number }
  doc: { isDraft2: boolean; documentNo: string | null; issuedOn: string }
  /** Blank until the hotel supplies them (see `settings`, keys `bank_*`). */
  bank: { accountName: string; accountNo: string; ifsc: string; bank: string; upi: string }
}

type Row = Record<string, unknown>
const num = (v: unknown) => Number(v ?? 0)

/** primary → father → coordinator → anything else, so the card reads in the template's order. */
const CONTACT_ORDER = ['primary', 'father', 'coordinator']
const contactRank = (label: string | null) => {
  const i = CONTACT_ORDER.indexOf((label ?? '').toLowerCase())
  return i === -1 ? CONTACT_ORDER.length : i
}

export async function proposalDocument(eventId: string): Promise<ProposalDocument> {
  const [event] = (await db.execute(sql`
    SELECT e.code, e.guest_name AS "guestName", e.event_type AS "eventType",
           t.display_name AS "eventTypeLabel", t.is_wedding AS "isWedding",
           e.status::text AS status,
           e.planned_from::text AS "plannedFrom", e.planned_to::text AS "plannedTo",
           e.first_date::text AS "firstDate", e.last_date::text AS "lastDate"
    FROM events e JOIN event_types t ON t.code = e.event_type
    WHERE e.id = ${eventId}
  `)) as unknown as Row[]
  if (!event) throw notFound('Event not found')

  const contacts = (await db.execute(sql`
    SELECT phone, label FROM event_contacts WHERE event_id = ${eventId}
  `)) as unknown as ProposalContact[]
  contacts.sort((a, b) => contactRank(a.label) - contactRank(b.label) || a.phone.localeCompare(b.phone))

  // Every line's discounted price, as a gap below its actual (client, 20 Aug 2026). Fetched
  // once and applied below, so this document, the bill and the payable arithmetic all price the
  // same line the same way — see lib/discounts.ts.
  const gaps = await effectiveLineGaps(eventId)

  // ── Functions ────────────────────────────────────────────────────────────────
  // The venue rate is the confirm-time snapshot when there is one, otherwise the rate card
  // effective on the function's date, so an enquiry Draft prices live and a confirmed booking
  // prints exactly what it was confirmed at. NULL means no card exists — BR-R1's gate.
  // The chef's priced delicacy is a per-plate addition (lib/pricing.ts) and rides with food.
  const subs = (await db.execute(sql`
    SELECT se.id, se.name, se.event_date::text AS "date",
           se.start_time::text AS "startTime", se.end_time::text AS "endTime", se.pax,
           COALESCE(v.name, b.name) AS "venueName",
           (se.bundle_id IS NOT NULL) AS "isBundle",
           COALESCE(NULLIF(se.venue_rate_paise, 0),
             (SELECT rc.rate_paise FROM venue_rate_cards rc
               WHERE ((se.venue_id IS NOT NULL AND rc.venue_id = se.venue_id)
                   OR (se.bundle_id IS NOT NULL AND rc.bundle_id = se.bundle_id))
                 AND rc.event_type = e.event_type
                 AND rc.effective_from <= se.event_date
               ORDER BY rc.effective_from DESC LIMIT 1))::bigint AS "venueRatePaise",
           (SELECT array_agg(mv.name ORDER BY mv.name)
              FROM venue_bundle_members bm JOIN venues mv ON mv.id = bm.venue_id
             WHERE bm.bundle_id = se.bundle_id) AS "bundleMembers",
           se.venue_id AS "venueId", se.bundle_id AS "bundleId",
           m.id AS "menuId", m.tier_id AS "tierId", m.tier_name AS "tierName",
           m.base_rate_paise AS "baseRatePaise", m.surcharge_paise AS "surchargePaise",
           COALESCE((SELECT sum(c.charge_paise) FROM chef_requests c
                      WHERE c.sub_event_id = se.id AND c.status = 'priced'), 0)::bigint AS "chefPaise"
    FROM sub_events se
    JOIN events e ON e.id = se.event_id
    LEFT JOIN venues v ON v.id = se.venue_id
    LEFT JOIN venue_bundles b ON b.id = se.bundle_id
    LEFT JOIN sub_event_menus m ON m.sub_event_id = se.id
    WHERE se.event_id = ${eventId}
    ORDER BY se.event_date, se.start_time
  `)) as unknown as Row[]

  const addonRows = (await db.execute(sql`
    SELECT a.sub_event_id AS "subEventId", a.description, a.qty, a.rate_paise AS "ratePaise"
    FROM sub_event_addons a JOIN sub_events se ON se.id = a.sub_event_id
    WHERE se.event_id = ${eventId}
    ORDER BY a.description
  `)) as unknown as Row[]

  const barRows = (await db.execute(sql`
    SELECT b.sub_event_id AS "subEventId", b.brand_name AS "brandName", b.bottles,
           b.rate_paise AS "ratePaise"
    FROM sub_event_bar_items b JOIN sub_events se ON se.id = b.sub_event_id
    WHERE se.event_id = ${eventId}
    ORDER BY b.brand_name
  `)) as unknown as Row[]

  // Segment order comes from the master category's sort_order — the snapshot table keeps the
  // pick rules but not the running order, and "Welcome drink" must not sort after "Soup".
  const segRows = (await db.execute(sql`
    SELECT c.menu_id AS "menuId", c.category_name AS "categoryName",
           c.base_pick AS "basePick", c.extra_picks AS "extraPicks",
           COALESCE(mc.sort_order, 999) AS "sortOrder"
    FROM sub_event_menu_categories c
    JOIN sub_event_menus m ON m.id = c.menu_id
    JOIN sub_events se ON se.id = m.sub_event_id
    LEFT JOIN menu_categories mc ON mc.tier_id = m.tier_id AND mc.name = c.category_name
    WHERE se.event_id = ${eventId}
    ORDER BY "sortOrder", c.category_name
  `)) as unknown as Row[]

  const dishRows = (await db.execute(sql`
    SELECT s.menu_id AS "menuId", s.category_name AS "categoryName",
           s.item_name AS "itemName", s.note, s.is_extra AS "isExtra"
    FROM sub_event_menu_selections s
    JOIN sub_event_menus m ON m.id = s.menu_id
    JOIN sub_events se ON se.id = m.sub_event_id
    WHERE se.event_id = ${eventId}
    ORDER BY s.is_extra, s.item_name
  `)) as unknown as Row[]

  /** venue-day -> the function carrying its hire. `subs` is ordered by (date, start time). */
  const venueDayCarrier = new Map<string, { id: string; name: string }>()

  const functions: ProposalFunction[] = subs.map((s) => {
    const menuId = s.menuId as string | null
    const pax = num(s.pax)
    const chefPaise = num(s.chefPaise)
    const perPlatePaise = menuId ? num(s.baseRatePaise) + num(s.surchargePaise) + chefPaise : 0
    const foodActualPaise = perPlatePaise * pax
    const foodAmountPaise = Math.max(0, foodActualPaise - (gaps.get(`food:${s.id as string}`) ?? 0))

    const addons: ProposalAddon[] = addonRows
      .filter((a) => a.subEventId === s.id)
      .map((a) => ({
        description: a.description as string,
        qty: num(a.qty),
        ratePaise: num(a.ratePaise),
        amountPaise: num(a.qty) * num(a.ratePaise),
      }))

    const menu: ProposalMenu | null = menuId
      ? {
          tierId: s.tierId as string,
          tierName: s.tierName as string,
          baseRatePaise: num(s.baseRatePaise),
          surchargePaise: num(s.surchargePaise),
          chefPaise,
          perPlatePaise,
          segments: segRows
            .filter((c) => c.menuId === menuId)
            .map((c) => {
              const dishes = dishRows
                .filter((d) => d.menuId === menuId && d.categoryName === c.categoryName)
                .map((d) => ({ name: d.itemName as string, note: (d.note as string) ?? null, isExtra: Boolean(d.isExtra) }))
              return {
                name: c.categoryName as string,
                basePick: c.basePick == null ? null : num(c.basePick),
                extraPicks: num(c.extraPicks),
                picked: dishes.length,
                dishes,
              }
            }),
        }
      : null

    const bar: ProposalBarLine[] = barRows
      .filter((b) => b.subEventId === s.id)
      .map((b) => ({
        brandName: b.brandName as string,
        bottles: num(b.bottles),
        ratePaise: num(b.ratePaise),
        amountPaise: num(b.bottles) * num(b.ratePaise),
      }))

    // The hall is hired by the DAY, not by the function (client, 12 Aug 2026): the first
    // function on a venue-day carries the charge and the rest are covered by it. Same rule and
    // same carrier as lib/pricing.ts and lib/invoice.ts, so all three documents agree.
    // CHECKOUT decides: out by 8 AM and it is the tail of the night before, costing nothing;
    // still in the hall after 8 and it has run into a new let (client, 21 Aug 2026). A function
    // running past midnight is charged on the day it started. lib/pricing.ts owns the rule.
    const venueOf = (s.bundleId as string | null) ?? (s.venueId as string | null) ?? 'none'
    const venueDay =
      !crossesMidnight(s.startTime as string, s.endTime as string) &&
      toMinutes(s.endTime as string) <= toMinutes(VENUE_DAY_CHANGEOVER)
        ? prevDay(s.date as string)
        : (s.date as string)
    const dayKey = `${venueOf}|${venueDay}`
    const holder = venueDayCarrier.get(dayKey)
    const venueCoveredBy = holder && holder.id !== s.id ? holder.name : null
    if (!holder) venueDayCarrier.set(dayKey, { id: s.id as string, name: s.name as string })

    const rawVenueRate = s.venueRatePaise == null ? null : num(s.venueRatePaise)
    const venueActualPaise = venueCoveredBy ? 0 : rawVenueRate
    // What the guest is charged for the hall (client, 20 Aug 2026). `venueActualPaise` stays
    // beside it so the document prints both columns; a venue with no rate card is still null,
    // and a null is a gate, never a zero (BR-R1).
    const venueRatePaise =
      venueActualPaise == null ? null : Math.max(0, venueActualPaise - (gaps.get(`venue:${s.id as string}`) ?? 0))
    // The bar is in the subtotal because it is in `proposal_total_paise`. Printing the bottles
    // and leaving their money out would put a document in the guest's hand whose own figures
    // do not add up to the one they are asked to pay against.
    const otherPaise = addons.reduce((n, a) => n + a.amountPaise, 0) + bar.reduce((n, b) => n + b.amountPaise, 0)
    const subtotalPaise = (venueRatePaise ?? 0) + foodAmountPaise + otherPaise
    // Add-ons and the bar carry no Discounted cell, so they sit at the same figure in both
    // columns and the two sub-totals differ by exactly what was given on the venue and the food.
    const actualSubtotalPaise = (venueActualPaise ?? 0) + foodActualPaise + otherPaise

    return {
      id: s.id as string,
      venueId: (s.venueId as string) ?? null,
      bundleId: (s.bundleId as string) ?? null,
      name: s.name as string,
      date: s.date as string,
      startTime: s.startTime as string,
      endTime: s.endTime as string,
      overnight: (s.endTime as string) <= (s.startTime as string),
      pax,
      venueName: (s.venueName as string) ?? null,
      isBundle: Boolean(s.isBundle),
      bundleMembers: (s.bundleMembers as string[]) ?? [],
      venueRatePaise,
      venueActualPaise,
      venueCoveredBy,
      menu,
      foodAmountPaise,
      foodActualPaise,
      addons,
      bar,
      subtotalPaise,
      actualSubtotalPaise,
    }
  })

  // ── Rooms, grouped by lodge ──────────────────────────────────────────────────
  const roomRows = (await db.execute(sql`
    SELECT rr.id, rr.unit_id AS "unitId", COALESCE(u.name, 'Lodging') AS lodge, rr.room_type AS "roomType",
           rr.count::int AS count, rr.check_in::text AS "checkIn", rr.check_out::text AS "checkOut",
           (rr.check_out - rr.check_in)::int AS nights,
           COALESCE(rr.rate_paise, (SELECT min(r.rack_rate_paise) FROM rooms r
                      WHERE r.room_type = rr.room_type AND r.is_active
                        AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)), 0)::bigint AS "ratePaise"
    FROM room_requirements rr
    LEFT JOIN lodging_units u ON u.id = rr.unit_id
    WHERE rr.event_id = ${eventId}
    ORDER BY lodge, rr.room_type, rr.check_in
  `)) as unknown as Row[]

  const lodges: ProposalLodge[] = []
  let roomsPaise = 0
  let roomsTaxPaise = 0
  // The bifurcation the guest reads. Booked rooms and the lodge's extras both land here,
  // because the statement prints one 5% line and one 18% line over the two of them.
  const roomTaxSplit: RoomTaxSplit = {
    low: { basePaise: 0, taxPaise: 0 },
    high: { basePaise: 0, taxPaise: 0 },
  }
  /** Adds one room line to the band its nightly rate and category put it in; returns its tax. */
  const bandRoomTax = (ratePaise: number, amountPaise: number, roomType: string): number => {
    const bp = roomGstBp(ratePaise, roomType)
    const taxPaise = taxOf(amountPaise, bp)
    const band = bp === ROOM_GST_HIGH_BP ? roomTaxSplit.high : roomTaxSplit.low
    band.basePaise += amountPaise
    band.taxPaise += taxPaise
    return taxPaise
  }

  for (const r of roomRows) {
    const count = num(r.count)
    const nights = num(r.nights)
    const ratePaise = num(r.ratePaise)
    const qty = count * nights
    const actualAmountPaise = qty * ratePaise
    const key = roomLineKey({
      unitId: (r.unitId as string) ?? null,
      roomType: r.roomType as string,
      checkIn: r.checkIn as string,
      checkOut: r.checkOut as string,
    })
    const amountPaise = Math.max(0, actualAmountPaise - (gaps.get(key) ?? 0))
    roomsPaise += amountPaise
    // Per line, then summed — matches lib/pricing.ts and lib/invoice.ts exactly. Taxed on the
    // DISCOUNTED line and banded by the DISCOUNTED nightly rate (client, 20 Aug 2026).
    const effectiveNightly = qty > 0 ? Math.round(amountPaise / qty) : 0
    roomsTaxPaise += bandRoomTax(effectiveNightly, amountPaise, r.roomType as string)

    const name = r.lodge as string
    let lodge = lodges.find((l) => l.name === name)
    if (!lodge) {
      lodge = { name, lines: [], rooms: 0, roomNights: 0, subtotalPaise: 0, actualSubtotalPaise: 0 }
      lodges.push(lodge)
    }
    lodge.lines.push({
      id: r.id as string,
      unitId: (r.unitId as string) ?? null,
      roomType: r.roomType as string,
      count,
      checkIn: r.checkIn as string,
      checkOut: r.checkOut as string,
      nights,
      ratePaise,
      amountPaise,
      actualAmountPaise,
      gstRateBp: roomGstBp(effectiveNightly, r.roomType as string),
    })
    lodge.rooms += count
    lodge.roomNights += count * nights
    lodge.subtotalPaise += amountPaise
    lodge.actualSubtotalPaise += actualAmountPaise
  }

  // ── Extras: the Lodge Manager's, closed maintenance, the Auditor's adjustments ─
  // The template has no row for any of them, so the block stays blank until the app has some.
  //
  // The Lodge Manager's extras are CLOSED-only, exactly as maintenance is (migration 0034), and
  // they are the one kind of extra whose tax is COLLECTED: an extra room is a room, so its GST
  // is money and belongs beside `roomsTaxPaise` in the payable, not in the 18% nobody pays.
  // It is kept in its own total rather than folded into `roomsTaxPaise` because that figure
  // feeds `thresholdBasePaise` below, and a room given out in September must not move the
  // advance that fell due in June.
  const extraRoomRows = (await db.execute(sql`
    SELECT COALESCE(u.name, 'Lodging') || ' — extra ' || replace(a.room_type, '_', ' ')
             || ' × ' || a.count || ' room(s) × ' || a.nights || ' night(s)' AS description,
           a.room_type AS "roomType",
           (a.count * a.nights)::int AS qty, a.rate_paise AS "ratePaise", a.amount_paise AS "amountPaise"
    FROM additional_rooms a
    LEFT JOIN lodging_units u ON u.id = a.unit_id
    JOIN lodge_extras x ON x.event_id = a.event_id AND x.closed_at IS NOT NULL
    WHERE a.event_id = ${eventId}
    ORDER BY u.name, a.room_type, a.created_at
  `)) as unknown as Row[]
  const extraRoomsPaise = extraRoomRows.reduce((n, r) => n + num(r.amountPaise), 0)
  // Per line, then summed — matches lib/invoice.ts and lib/payment-schedule.ts to the paisa,
  // and banded by the same nightly rate a booked room is banded by.
  const extraRoomsTaxPaise = extraRoomRows.reduce(
    (n, r) => n + bandRoomTax(num(r.ratePaise), num(r.amountPaise), r.roomType as string),
    0,
  )

  // Plates issued on the day (migration 0035) — closed only, and food like any other plate:
  // 18%, shown and collected from nobody.
  const plates = (await db.execute(sql`
    SELECT 'Extra plates — ' || se.name AS description, p.plates::int AS qty,
           p.rate_paise AS "ratePaise", p.amount_paise AS "amountPaise",
           ${STANDARD_GST_BP}::int AS "gstRateBp"
    FROM extra_plate_entries p
    JOIN sub_events se ON se.id = p.sub_event_id
    JOIN utensil_extras x ON x.event_id = p.event_id AND x.closed_at IS NOT NULL
    WHERE p.event_id = ${eventId}
    ORDER BY se.event_date, se.start_time, p.created_at
  `)) as unknown as Row[]

  const dining = (await db.execute(sql`
    SELECT 'In-room dining' AS description, 1 AS qty,
           in_room_dining_paise AS "ratePaise", in_room_dining_paise AS "amountPaise",
           ${STANDARD_GST_BP}::int AS "gstRateBp"
    FROM lodge_extras
    WHERE event_id = ${eventId} AND closed_at IS NOT NULL AND in_room_dining_paise > 0
  `)) as unknown as Row[]

  const maint = (await db.execute(sql`
    SELECT item AS description, qty, rate_paise AS "ratePaise", amount_paise AS "amountPaise",
           ${STANDARD_GST_BP}::int AS "gstRateBp"
    FROM maintenance_entries WHERE event_id = ${eventId} AND is_closed
    ORDER BY created_at
  `)) as unknown as Row[]
  // The Auditor names the rate on their own lines (FR-7.4), so it is read rather than assumed —
  // an adjustment against a room line is 5%, not the 18% maintenance carries.
  const adjust = (await db.execute(sql`
    SELECT l.description, l.qty, l.rate_paise AS "ratePaise", l.amount_paise AS "amountPaise",
           l.gst_rate_bp AS "gstRateBp"
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
    WHERE i.event_id = ${eventId} AND i.superseded_at IS NULL AND l.section = 'adjustment'
    ORDER BY l.description
  `)) as unknown as Row[]
  // `extraRows` are the ones whose tax is SHOWN; the extra rooms are taxed above because theirs
  // is collected. Both kinds print in the same Extras block.
  const extraRows = [...plates, ...dining, ...maint, ...adjust]
  const extras: ProposalAddon[] = [...extraRoomRows, ...extraRows].map((m) => ({
    description: m.description as string,
    qty: num(m.qty),
    ratePaise: num(m.ratePaise),
    amountPaise: num(m.amountPaise),
  }))

  const payments = (await db.execute(sql`
    SELECT id, kind::text AS kind, amount_paise AS "amountPaise", mode,
           receipt_no AS "receiptNo", received_on::text AS "receivedOn"
    FROM payments WHERE event_id = ${eventId}
    ORDER BY received_on, receipt_no
  `)) as unknown as ProposalPayment[]
  const advancesReceivedPaise = payments.reduce(
    (n, p) => n + (p.kind === 'refund' ? -num(p.amountPaise) : num(p.amountPaise)),
    0,
  )

  const [inv] = (await db.execute(sql`
    SELECT invoice_no AS "documentNo", (finalised_at IS NOT NULL) AS finalised
    FROM invoices WHERE event_id = ${eventId} AND superseded_at IS NULL
  `)) as unknown as Row[]

  const proposalPaise = functions.reduce((n, f) => n + f.subtotalPaise, 0)
  const extrasPaise = extras.reduce((n, e) => n + e.amountPaise, 0)
  const discounts = await listDiscounts(eventId)
  // Only the pre-20-Aug LUMP rows still deduct here. Every line discount is already off the
  // line it prices — subtracting it again would take the same money off twice.
  const discountPaise = await lumpDiscountPaise(eventId)
  const subtotalPaise = proposalPaise + roomsPaise + extrasPaise - discountPaise
  // The Actual column's own arithmetic, so the guest can read what the booking lists at and
  // what the difference came to (client, 20 Aug 2026).
  const actualProposalPaise = functions.reduce((n, f) => n + f.actualSubtotalPaise, 0)
  const actualRoomsPaise = lodges.reduce((n, l) => n + l.actualSubtotalPaise, 0)
  const lineDiscountPaise = actualProposalPaise - proposalPaise + (actualRoomsPaise - roomsPaise)
  const totalPaise = subtotalPaise + roomsTaxPaise + extraRoomsTaxPaise

  // The 18% shown on everything but rooms, rounded per line and summed — the same lines
  // lib/invoice.ts pushes (one per venue, one per function's food, one per add-on, one per
  // bar brand, one per extra), so the Draft and the Draft 2 print the same figure to the
  // paisa. It is added to the printed Total and to nothing else: nobody pays it (client's
  // lead, 4 Aug 2026). Rounding PER LINE, brand by brand, for that reason — a bar total taxed
  // in one lump would drift a paisa from the bill and make the two documents disagree.
  const shownGstPaise =
    functions.reduce(
      (n, f) =>
        n +
        taxOf(f.venueRatePaise ?? 0, STANDARD_GST_BP) +
        taxOf(f.foodAmountPaise, STANDARD_GST_BP) +
        f.addons.reduce((m, a) => m + taxOf(a.amountPaise, STANDARD_GST_BP), 0) +
        f.bar.reduce((m, b) => m + taxOf(b.amountPaise, STANDARD_GST_BP), 0),
      0,
    ) + extraRows.reduce((n, e) => n + taxOf(num(e.amountPaise), num(e.gstRateBp)), 0)

  // The base confirmEvent enforces (lib/confirm.ts): venue+food+add-ons, rooms and room tax,
  // less the discount. Post-event extras are settled before checkout, not at the advance.
  const thresholdBasePaise = Math.max(0, proposalPaise + roomsPaise + roomsTaxPaise - discountPaise)
  const advancePaise = percentOfPaise(thresholdBasePaise, ADVANCE_PCT)
  const weddingMilestonePaise = percentOfPaise(thresholdBasePaise, WEDDING_MILESTONE_PCT)

  return {
    event: {
      code: event.code as string,
      guestName: event.guestName as string,
      eventType: event.eventType as string,
      eventTypeLabel: event.eventTypeLabel as string,
      isWedding: Boolean(event.isWedding),
      status: event.status as string,
      plannedFrom: (event.plannedFrom as string) ?? null,
      plannedTo: (event.plannedTo as string) ?? null,
      firstDate: (event.firstDate as string) ?? null,
      lastDate: (event.lastDate as string) ?? null,
    },
    contacts,
    functions,
    lodges,
    discounts,
    extras,
    payments,
    totals: {
      proposalPaise,
      roomsPaise,
      roomsTaxPaise,
      extraRoomsPaise,
      extraRoomsTaxPaise,
      roomTaxSplit,
      extrasPaise,
      discountPaise,
      actualProposalPaise,
      actualRoomsPaise,
      lineDiscountPaise,
      subtotalPaise,
      totalPaise,
      shownGstPaise,
      displayTotalPaise: totalPaise + shownGstPaise,
      advancePaise,
      weddingMilestonePaise,
      balancePaise: totalPaise - advancePaise,
      advancesReceivedPaise,
    },
    counts: {
      functions: functions.length,
      pax: functions.reduce((n, f) => n + f.pax, 0),
      rooms: lodges.reduce((n, l) => n + l.rooms, 0),
      roomNights: lodges.reduce((n, l) => n + l.roomNights, 0),
    },
    doc: {
      // Draft for an enquiry, Draft 2 once the booking is confirmed (client, 20 Jul 2026).
      isDraft2: (event.status as string) !== 'enquiry',
      documentNo: (inv?.documentNo as string) ?? null,
      issuedOn: new Date().toISOString().slice(0, 10),
    },
    bank: { accountName: '', accountNo: '', ifsc: '', bank: '', upi: '' },
  }
}
