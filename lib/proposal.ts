import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { notFound } from '@/lib/api'
import { effectiveDiscountPaise } from '@/lib/discounts'
import { percentOfPaise } from '@/lib/money'

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
 *  • Rooms are the only taxed head, at 5%, rounded PER LINE then summed — the same order of
 *    operations as lib/pricing.ts and lib/invoice.ts, so this document and the Draft cannot
 *    differ by a rounding paisa.
 *  • The 25% advance base is (venue + food + add-ons) + rooms + room tax − discount, which is
 *    the formula `confirmEvent` actually enforces (lib/confirm.ts). Printing anything else
 *    would quote the guest a number the system then refuses to accept.
 *  • A venue with no rate card prices at NOTHING, never at zero (BR-R1) — `venueRatePaise` is
 *    null and the document prints "on approval" rather than inventing ₹0.00.
 */

const ROOM_TAX_BP = 500
const ADVANCE_PCT = 25

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
  tierName: string
  baseRatePaise: number
  surchargePaise: number
  chefPaise: number
  perPlatePaise: number
  segments: ProposalSegment[]
}

export type ProposalFunction = {
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
  /** null = no rate card for this venue + event type. A gate, never a zero (BR-R1). */
  venueRatePaise: number | null
  menu: ProposalMenu | null
  foodAmountPaise: number
  addons: ProposalAddon[]
  subtotalPaise: number
}

export type ProposalRoomLine = {
  roomType: string
  count: number
  checkIn: string
  checkOut: string
  nights: number
  ratePaise: number
  amountPaise: number
}

export type ProposalLodge = {
  name: string
  lines: ProposalRoomLine[]
  rooms: number
  roomNights: number
  subtotalPaise: number
}

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
  /** Maintenance entries and Auditor adjustments. Empty until they exist in the app. */
  extras: ProposalAddon[]
  payments: ProposalPayment[]
  totals: {
    /** Venue + food + add-ons — the "proposal total" the glance tile and BR-D2 both mean. */
    proposalPaise: number
    roomsPaise: number
    roomsTaxPaise: number
    extrasPaise: number
    discountPaise: number
    /** proposal + rooms + extras − discount, before tax. */
    subtotalPaise: number
    totalPaise: number
    advancePaise: number
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
           m.id AS "menuId", m.tier_name AS "tierName",
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

  const functions: ProposalFunction[] = subs.map((s) => {
    const menuId = s.menuId as string | null
    const pax = num(s.pax)
    const chefPaise = num(s.chefPaise)
    const perPlatePaise = menuId ? num(s.baseRatePaise) + num(s.surchargePaise) + chefPaise : 0
    const foodAmountPaise = perPlatePaise * pax

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

    const venueRatePaise = s.venueRatePaise == null ? null : num(s.venueRatePaise)
    const subtotalPaise =
      (venueRatePaise ?? 0) + foodAmountPaise + addons.reduce((n, a) => n + a.amountPaise, 0)

    return {
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
      menu,
      foodAmountPaise,
      addons,
      subtotalPaise,
    }
  })

  // ── Rooms, grouped by lodge ──────────────────────────────────────────────────
  const roomRows = (await db.execute(sql`
    SELECT COALESCE(u.name, 'Lodging') AS lodge, rr.room_type AS "roomType",
           rr.count::int AS count, rr.check_in::text AS "checkIn", rr.check_out::text AS "checkOut",
           (rr.check_out - rr.check_in)::int AS nights,
           COALESCE((SELECT min(r.rack_rate_paise) FROM rooms r
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
  for (const r of roomRows) {
    const count = num(r.count)
    const nights = num(r.nights)
    const ratePaise = num(r.ratePaise)
    const amountPaise = count * nights * ratePaise
    roomsPaise += amountPaise
    // Per line, then summed — matches lib/pricing.ts and lib/invoice.ts exactly.
    roomsTaxPaise += Math.round((amountPaise * ROOM_TAX_BP) / 10000)

    const name = r.lodge as string
    let lodge = lodges.find((l) => l.name === name)
    if (!lodge) {
      lodge = { name, lines: [], rooms: 0, roomNights: 0, subtotalPaise: 0 }
      lodges.push(lodge)
    }
    lodge.lines.push({
      roomType: r.roomType as string,
      count,
      checkIn: r.checkIn as string,
      checkOut: r.checkOut as string,
      nights,
      ratePaise,
      amountPaise,
    })
    lodge.rooms += count
    lodge.roomNights += count * nights
    lodge.subtotalPaise += amountPaise
  }

  // ── Extras: closed maintenance + the Auditor's adjustments ───────────────────
  // The template has no row for either, so both stay blank until the app has them.
  const maint = (await db.execute(sql`
    SELECT item AS description, qty, rate_paise AS "ratePaise", amount_paise AS "amountPaise"
    FROM maintenance_entries WHERE event_id = ${eventId} AND is_closed
    ORDER BY created_at
  `)) as unknown as Row[]
  const adjust = (await db.execute(sql`
    SELECT l.description, l.qty, l.rate_paise AS "ratePaise", l.amount_paise AS "amountPaise"
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
    WHERE i.event_id = ${eventId} AND l.section = 'adjustment'
    ORDER BY l.description
  `)) as unknown as Row[]
  const extras: ProposalAddon[] = [...maint, ...adjust].map((m) => ({
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
    FROM invoices WHERE event_id = ${eventId}
  `)) as unknown as Row[]

  const proposalPaise = functions.reduce((n, f) => n + f.subtotalPaise, 0)
  const extrasPaise = extras.reduce((n, e) => n + e.amountPaise, 0)
  const discountPaise = await effectiveDiscountPaise(eventId)
  const subtotalPaise = proposalPaise + roomsPaise + extrasPaise - discountPaise
  const totalPaise = subtotalPaise + roomsTaxPaise
  // The base confirmEvent enforces (lib/confirm.ts): venue+food+add-ons, rooms and room tax,
  // less the discount. Post-event extras are settled before checkout, not at the advance.
  const advancePaise = percentOfPaise(
    Math.max(0, proposalPaise + roomsPaise + roomsTaxPaise - discountPaise),
    ADVANCE_PCT,
  )

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
    extras,
    payments,
    totals: {
      proposalPaise,
      roomsPaise,
      roomsTaxPaise,
      extrasPaise,
      discountPaise,
      subtotalPaise,
      totalPaise,
      advancePaise,
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
