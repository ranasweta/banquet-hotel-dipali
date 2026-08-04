import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { effectiveDiscountPaise } from '@/lib/discounts'
import { percentOfPaise } from '@/lib/money'
import { ROOM_GST_BP } from '@/lib/tax'

/**
 * What the guest actually owes, and when — the one arithmetic every screen measures against
 * (client's lead, 4 Aug 2026).
 *
 * THE PAYABLE AMOUNT. Venue + food + add-ons + rooms, less discounts, plus the 5% room tax.
 * The 18% GST introduced on 4 Aug is printed on the document and collected from nobody, so
 * it appears nowhere in this file. Neither does it enter the 10% discount cap — that is
 * measured pre-tax on the undiscounted bill and stays where it is, in lib/discounts.ts.
 *
 * THE MILESTONES.
 *   advance          25% of payable, at confirm. Short is allowed now (see lib/confirm.ts):
 *                    the money is taken, the dates are held, and the debt shows on the
 *                    calendar until it clears.
 *   wedding balance  50% of payable, cumulative, 30 days before the first function. Was the
 *                    whole remaining 75% until 4 Aug 2026; the rest settles at billing.
 *   settlement       100% of payable, at billing.
 * Over-payment is never refused — each milestone is a floor, not a figure.
 *
 * WHY ONE MODULE. Three places computed a balance before this and all three disagreed:
 * `getLedger` and `reminders.outstandingPaise` both measured `proposal_total_paise` alone,
 * which is venue+food — so every booking with rooms under-stated its balance by the whole
 * lodging charge, and wedding reminders stopped chasing early. They read this now.
 *
 * The SQL below is the single definition of the payable arithmetic; `payableBreakdown` and
 * the calendar's bulk lookup both go through it, so a month grid cannot disagree with the
 * booking it links to. It mirrors `roomEstimatePaise` line for line — rounded per room line,
 * then summed — so the wizard's live room estimate and this can never differ by a paisa.
 */

export const ADVANCE_PCT = 25
export const WEDDING_MILESTONE_PCT = 50
/** Days before the first function that the wedding milestone falls due (BR-P2). */
export const WEDDING_MILESTONE_DAYS = 30

export type PayableBreakdown = {
  /** Venue + food + add-ons — what `proposal_total_paise` means. */
  proposalPaise: number
  roomsPaise: number
  /** 5% on rooms, rounded per line. The only tax that is money. */
  roomsTaxPaise: number
  discountPaise: number
  /** proposal + rooms + room tax − discount. Every threshold is a percentage of this. */
  payablePaise: number
  paidPaise: number
  balancePaise: number
}

type PayableRow = {
  eventId: string
  venue: number
  food: number
  addons: number
  rooms: number
  roomsTax: number
  paid: number
  firstDate: string | null
  isWedding: boolean
}

/**
 * The payable arithmetic for a set of events, before discounts.
 *
 * Venue reads the confirm-time snapshot when there is one and the rate card effective on the
 * function's date otherwise, so an enquiry prices live and a confirmed booking prices at what
 * it was confirmed at — the same COALESCE the bill and the proposal document use. Food carries
 * the Chef's priced delicacy, matching `foodAndAddonTotal`, because that is the figure
 * `confirmEvent` quoted the guest.
 *
 * `firstDate` comes from `min(sub_events.event_date)`, never `events.first_date` — that column
 * is a cache written at confirm and can be NULL or stale after a function moves.
 */
async function payableRows(
  eventIds: string[],
  exec: Pick<typeof db, 'execute'> = db,
): Promise<PayableRow[]> {
  if (eventIds.length === 0) return []
  const ids = sql.join(
    eventIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const rows = (await exec.execute(sql`
    WITH room_lines AS (
      SELECT rr.event_id,
             (GREATEST(rr.count, 0)::bigint
              * GREATEST(rr.check_out - rr.check_in, 0)
              * COALESCE((SELECT min(r.rack_rate_paise) FROM rooms r
                           WHERE r.room_type = rr.room_type AND r.is_active
                             AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)), 0)) AS amount
      FROM room_requirements rr
      WHERE rr.event_id IN (${ids})
    )
    SELECT e.id AS "eventId",
           t.is_wedding AS "isWedding",
           (SELECT min(se.event_date)::text FROM sub_events se WHERE se.event_id = e.id) AS "firstDate",
           COALESCE((SELECT sum(COALESCE(NULLIF(se.venue_rate_paise, 0),
                      (SELECT rc.rate_paise FROM venue_rate_cards rc
                        WHERE ((se.venue_id IS NOT NULL AND rc.venue_id = se.venue_id)
                            OR (se.bundle_id IS NOT NULL AND rc.bundle_id = se.bundle_id))
                          AND rc.event_type = e.event_type
                          AND rc.effective_from <= se.event_date
                        ORDER BY rc.effective_from DESC LIMIT 1), 0))
                      FROM sub_events se WHERE se.event_id = e.id), 0)::bigint AS venue,
           COALESCE((SELECT sum(se.pax::bigint * (m.base_rate_paise + m.surcharge_paise
                      + COALESCE((SELECT sum(c.charge_paise) FROM chef_requests c
                                   WHERE c.sub_event_id = se.id AND c.status = 'priced'), 0)))
                      FROM sub_event_menus m JOIN sub_events se ON se.id = m.sub_event_id
                     WHERE se.event_id = e.id), 0)::bigint AS food,
           COALESCE((SELECT sum(a.qty::bigint * a.rate_paise)
                      FROM sub_event_addons a JOIN sub_events se ON se.id = a.sub_event_id
                     WHERE se.event_id = e.id), 0)::bigint AS addons,
           COALESCE((SELECT sum(rl.amount) FROM room_lines rl WHERE rl.event_id = e.id), 0)::bigint AS rooms,
           COALESCE((SELECT sum(round(rl.amount::numeric * ${ROOM_GST_BP} / 10000))
                      FROM room_lines rl WHERE rl.event_id = e.id), 0)::bigint AS "roomsTax",
           COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount_paise ELSE p.amount_paise END)
                      FROM payments p WHERE p.event_id = e.id), 0)::bigint AS paid
    FROM events e
    JOIN event_types t ON t.code = e.event_type
    WHERE e.id IN (${ids})
  `)) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    eventId: r.eventId as string,
    venue: Number(r.venue),
    food: Number(r.food),
    addons: Number(r.addons),
    rooms: Number(r.rooms),
    roomsTax: Number(r.roomsTax),
    paid: Number(r.paid),
    firstDate: (r.firstDate as string) ?? null,
    isWedding: Boolean(r.isWedding),
  }))
}

/** Payable before discounts — proposal + rooms + room tax. */
const grossPayable = (r: PayableRow) => r.venue + r.food + r.addons + r.rooms + r.roomsTax

/**
 * The event's payable amount and running balance. `exec` is threaded through so the confirm
 * transaction prices against its own uncommitted advance row rather than a stale read.
 */
export async function payableBreakdown(
  eventId: string,
  exec: Pick<typeof db, 'execute'> = db,
): Promise<PayableBreakdown> {
  const [row] = await payableRows([eventId], exec)
  if (!row) throw new Error(`payableBreakdown: event ${eventId} not found`)
  const discountPaise = await effectiveDiscountPaise(eventId, exec)
  const payablePaise = Math.max(0, grossPayable(row) - discountPaise)
  return {
    proposalPaise: row.venue + row.food + row.addons,
    roomsPaise: row.rooms,
    roomsTaxPaise: row.roomsTax,
    discountPaise,
    payablePaise,
    paidPaise: row.paid,
    balancePaise: payablePaise - row.paid,
  }
}

export type Milestone = {
  key: 'advance' | 'wedding_balance' | 'settlement'
  label: string
  /** Percentage of the payable amount this milestone must bring the total paid up to. */
  percent: number
  requiredPaise: number
  paidPaise: number
  /** required − paid, floored at zero. Zero means met. */
  shortfallPaise: number
  /** NULL where the milestone is due on the spot rather than on a date. */
  dueOn: string | null
  overdue: boolean
}

export type PaymentSchedule = PayableBreakdown & {
  milestones: Milestone[]
  /** The advance milestone's shortfall — what the calendar's "Downpayment due" reads. */
  advanceShortfallPaise: number
}

function minusDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() - days)
  return t.toISOString().slice(0, 10)
}

/**
 * The event's milestones with what each needs, what has arrived and what is short — the
 * panel a booking manager reads when a guest reopens their proposal.
 */
export async function paymentSchedule(eventId: string, asOf?: string): Promise<PaymentSchedule> {
  const [row] = await payableRows([eventId])
  if (!row) throw new Error(`paymentSchedule: event ${eventId} not found`)
  const discountPaise = await effectiveDiscountPaise(eventId)
  const payablePaise = Math.max(0, grossPayable(row) - discountPaise)
  const paid = row.paid
  const today = asOf ?? new Date().toLocaleDateString('en-CA')

  const milestone = (
    key: Milestone['key'],
    label: string,
    percent: number,
    dueOn: string | null,
  ): Milestone => {
    const requiredPaise = percentOfPaise(payablePaise, percent)
    const shortfallPaise = Math.max(0, requiredPaise - paid)
    return {
      key,
      label,
      percent,
      requiredPaise,
      paidPaise: paid,
      shortfallPaise,
      dueOn,
      overdue: shortfallPaise > 0 && dueOn != null && dueOn < today,
    }
  }

  const milestones: Milestone[] = [milestone('advance', 'Booking advance', ADVANCE_PCT, null)]
  if (row.isWedding && row.firstDate) {
    milestones.push(
      milestone(
        'wedding_balance',
        'Wedding balance',
        WEDDING_MILESTONE_PCT,
        minusDays(row.firstDate, WEDDING_MILESTONE_DAYS),
      ),
    )
  }
  milestones.push(milestone('settlement', 'Settlement', 100, null))

  return {
    proposalPaise: row.venue + row.food + row.addons,
    roomsPaise: row.rooms,
    roomsTaxPaise: row.roomsTax,
    discountPaise,
    payablePaise,
    paidPaise: paid,
    balancePaise: payablePaise - paid,
    milestones,
    advanceShortfallPaise: milestones[0]!.shortfallPaise,
  }
}

/**
 * What each of these events is still short of its 25% advance, for the calendar's
 * "Downpayment due" marker. Absent from the map means fully covered.
 *
 * The discount lookup runs only for bookings that could possibly be short: a discount can
 * only ever LOWER what a quarter comes to, so anything already covering the undiscounted
 * quarter is settled and needs no second query. A month grid of paid-up bookings therefore
 * costs exactly one query, and only genuinely short ones pay for the exact figure.
 */
export async function advanceShortfallByEvent(eventIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const rows = await payableRows(eventIds)
  for (const r of rows) {
    const gross = grossPayable(r)
    if (r.paid >= percentOfPaise(gross, ADVANCE_PCT)) continue
    const discount = await effectiveDiscountPaise(r.eventId)
    const required = percentOfPaise(Math.max(0, gross - discount), ADVANCE_PCT)
    if (r.paid < required) out.set(r.eventId, required - r.paid)
  }
  return out
}
