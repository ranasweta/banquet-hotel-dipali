import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { listExceptions, type ExceptionRow } from '@/lib/approvals'

/**
 * Booking-manager home dashboard (the landing every signed-in user lands on). One read
 * that answers "what needs my attention today": today's functions, the next-7-day outlook,
 * open enquiries still to be locked in, anything waiting on an approval, and balances that
 * fall inside the 30-day payment window (BR-P2).
 *
 * Two deliberate data choices, both learned from the live data:
 *  - The agenda reads `sub_events.event_date` directly, never `events.first_date`. first_date
 *    is a derived cache that some rows (e.g. seeded/imported bookings) never had backfilled;
 *    the sub-events are the ground truth for "what happens on a day".
 *  - Money maths mirror lib/reminders.ts exactly (proposal − room discounts − approved
 *    discounts − net payments) so a balance shown here equals the balance shown by the
 *    reminder job. sum() over int8 returns numeric (a string over the wire), so every
 *    aggregate is coerced with Number() on the way out.
 */

// Confirmed-and-beyond: the operational lifecycle. Enquiries never reach the day agenda,
// matching the calendar board and day sheet (FR-2.5, FR-2.4).
const OPERATIONAL = sql`('confirmed','in_progress','completed','locked','billed','closed')`

export type AgendaFunction = {
  subEventId: string
  eventId: string
  eventCode: string
  guestName: string
  eventType: string
  status: string
  name: string
  eventDate: string
  startTime: string
  endTime: string
  pax: number
  venueName: string | null
}

export type OpenEnquiry = {
  id: string
  code: string
  guestName: string
  eventType: string
  idleDays: number
  stale: boolean
  contactPhone: string | null
}

export type PendingChangeRequest = {
  id: string
  summary: string
  reason: string | null
  requestedAt: string
  eventId: string
  eventCode: string
  guestName: string
  requestedByName: string
}

export type PaymentDue = {
  eventId: string
  code: string
  guestName: string
  eventType: string
  eventDate: string
  daysToEvent: number
  balanceDueOn: string
  outstandingPaise: number
  proposalTotalPaise: number
}

export type BookingDashboard = {
  asOf: string
  today: AgendaFunction[]
  upcoming: AgendaFunction[]
  openEnquiries: OpenEnquiry[]
  approvals: { exceptions: ExceptionRow[]; changeRequests: PendingChangeRequest[]; total: number }
  paymentsDue: PaymentDue[]
}

/** YYYY-MM-DD in the server's local zone (matches the calendar route's notion of "today"). */
export function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA')
}

const agendaColumns = sql`
  se.id AS "subEventId", se.event_id AS "eventId", se.name,
  se.event_date::text AS "eventDate", se.start_time::text AS "startTime", se.end_time::text AS "endTime",
  se.pax, e.code AS "eventCode", e.guest_name AS "guestName", e.event_type AS "eventType", e.status::text AS status,
  COALESCE(v.name, b.name) AS "venueName"`

const agendaFrom = sql`
  FROM sub_events se
  JOIN events e ON e.id = se.event_id
  LEFT JOIN venues v ON v.id = se.venue_id
  LEFT JOIN venue_bundles b ON b.id = se.bundle_id`

/** Assembles the whole dashboard for `asOf` (defaults to today). Runs the sections in parallel. */
export async function getBookingDashboard(asOf: string = todayLocal()): Promise<BookingDashboard> {
  const [today, upcoming, openEnquiries, changeRequests, paymentsDue, exceptions] = await Promise.all([
    // Today's functions.
    db.execute(sql`
      SELECT ${agendaColumns} ${agendaFrom}
      WHERE se.event_date = ${asOf}::date AND e.status IN ${OPERATIONAL}
      ORDER BY se.start_time, "venueName"
    `) as unknown as Promise<AgendaFunction[]>,

    // The next seven days (tomorrow … +7), so the today hero and this list never overlap.
    db.execute(sql`
      SELECT ${agendaColumns} ${agendaFrom}
      WHERE se.event_date > ${asOf}::date AND se.event_date <= ${asOf}::date + 7
        AND e.status IN ${OPERATIONAL}
      ORDER BY se.event_date, se.start_time, "venueName"
    `) as unknown as Promise<AgendaFunction[]>,

    // Open enquiries still to be locked in. Oldest-touched first (the ones going cold);
    // `stale` uses the configurable threshold (FR-1.8), defaulting to 7 days.
    db.execute(sql`
      SELECT e.id, e.code, e.guest_name AS "guestName", e.event_type AS "eventType",
             GREATEST(0, EXTRACT(DAY FROM (now() - e.updated_at))::int) AS "idleDays",
             (e.updated_at < now() - (COALESCE((SELECT value::int FROM settings WHERE key = 'stale_enquiry_days'), 7) || ' days')::interval) AS stale,
             (SELECT phone FROM event_contacts c WHERE c.event_id = e.id ORDER BY c.label NULLS LAST LIMIT 1) AS "contactPhone"
      FROM events e
      WHERE e.status = 'enquiry'
      ORDER BY e.updated_at ASC
      LIMIT 50
    `) as unknown as Promise<OpenEnquiry[]>,

    // Pending sub-event change requests (date/time/venue moves awaiting a decision).
    db.execute(sql`
      SELECT cr.id, cr.summary, cr.reason, cr.requested_at AS "requestedAt",
             e.id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
             u.full_name AS "requestedByName"
      FROM change_requests cr
      JOIN events e ON e.id = cr.event_id
      JOIN users u ON u.id = cr.requested_by
      WHERE cr.status = 'pending'
      ORDER BY cr.requested_at DESC
      LIMIT 20
    `) as unknown as Promise<PendingChangeRequest[]>,

    // Balances inside the 30-day window (BR-P2). event_date derives from sub_events so a
    // missing first_date cache can't hide a genuinely due balance. Filtered to a positive
    // outstanding in JS (a numeric expression can't be reused in a WHERE without repeating it).
    db.execute(sql`
      WITH ev AS (
        SELECT e.id, e.code, e.guest_name AS "guestName", e.event_type AS "eventType",
               e.proposal_total_paise AS "proposalTotalPaise",
               COALESCE(e.first_date, (SELECT min(event_date) FROM sub_events s WHERE s.event_id = e.id)) AS event_date
        FROM events e
        WHERE e.status IN ('confirmed','in_progress')
      )
      SELECT ev.id AS "eventId", ev.code, ev."guestName", ev."eventType",
             ev.event_date::text AS "eventDate",
             (ev.event_date - ${asOf}::date) AS "daysToEvent",
             (ev.event_date - 30)::text AS "balanceDueOn",
             ev."proposalTotalPaise",
             ev."proposalTotalPaise"
               - COALESCE((SELECT sum(discount_paise) FROM room_allocations WHERE event_id = ev.id), 0)
               - COALESCE((SELECT sum(d.amount_paise) FROM discounts d
                           LEFT JOIN exceptions x ON x.id = d.exception_id
                           WHERE d.event_id = ev.id
                             AND (d.exception_id IS NULL OR x.status IN ('approved','approved_modified'))), 0)
               - COALESCE((SELECT sum(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END)
                           FROM payments WHERE event_id = ev.id), 0)
               AS "outstandingPaise"
      FROM ev
      WHERE ev.event_date IS NOT NULL
        AND ev.event_date >= ${asOf}::date
        AND ev.event_date <= ${asOf}::date + 30
      ORDER BY ev.event_date ASC
    `) as unknown as Promise<PaymentDue[]>,

    listExceptions({ status: 'pending' }),
  ])

  return {
    asOf,
    today: today.map(coerceAgenda),
    upcoming: upcoming.map(coerceAgenda),
    openEnquiries: openEnquiries.map((e) => ({
      ...e,
      idleDays: Number(e.idleDays),
      stale: Boolean(e.stale),
    })),
    approvals: {
      exceptions,
      changeRequests,
      total: exceptions.length + changeRequests.length,
    },
    paymentsDue: paymentsDue
      .map((p) => ({
        ...p,
        daysToEvent: Number(p.daysToEvent),
        outstandingPaise: Number(p.outstandingPaise),
        proposalTotalPaise: Number(p.proposalTotalPaise),
      }))
      .filter((p) => p.outstandingPaise > 0),
  }
}

function coerceAgenda(a: AgendaFunction): AgendaFunction {
  return { ...a, pax: Number(a.pax) }
}
