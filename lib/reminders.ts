import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { effectiveDiscountPaise } from '@/lib/discounts'

/**
 * Payment reminders & stale-enquiry job (M7, BR-P2, FR-1.8, FR-9.1).
 *
 * Wedding balance schedule (BR-P2, interpretation per SEED_ASSUMPTIONS open question 1):
 * the remaining balance is due 30 days before the first event date. The Booking Manager is
 * reminded daily from D-30 through D-21; from D-20 the Higher Authority is reminded too,
 * through D-1. Rows are pre-generated into payment_reminders (idempotent on the unique key)
 * so a daily send can pick up whatever is due; a paid-off wedding generates none.
 */

const BM_FROM = 30
const BM_TO = 21
const HA_FROM = 20
const HA_TO = 1

/** Net outstanding balance for an event: proposal − effective discounts − (payments − refunds). */
async function outstandingPaise(eventId: string, proposalTotalPaise: number): Promise<number> {
  const [{ paid }] = (await db.execute(sql`
    SELECT COALESCE(sum(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END), 0) AS paid
    FROM payments WHERE event_id = ${eventId}
  `)) as unknown as { paid: number }[]
  const discount = await effectiveDiscountPaise(eventId)
  return proposalTotalPaise - discount - Number(paid)
}

/**
 * Generates the wedding balance-reminder schedule for every upcoming, unpaid confirmed
 * wedding as of `asOf`. Idempotent. Returns how many reminder rows were newly created.
 */
export async function generateWeddingReminders(asOf: string): Promise<{ weddings: number; reminders: number }> {
  const candidates = (await db.execute(sql`
    SELECT e.id, e.first_date::text AS "firstDate", e.proposal_total_paise AS "proposalTotalPaise"
    FROM events e JOIN event_types et ON et.code = e.event_type
    WHERE et.is_wedding
      AND e.status IN ('confirmed','in_progress')
      AND e.first_date IS NOT NULL
      AND e.first_date > ${asOf}::date
  `)) as unknown as { id: string; firstDate: string; proposalTotalPaise: number }[]

  const due: string[] = []
  for (const c of candidates) {
    if ((await outstandingPaise(c.id, Number(c.proposalTotalPaise))) > 0) due.push(c.id)
  }
  if (due.length === 0) return { weddings: 0, reminders: 0 }

  // One statement: for each qualifying wedding, a BM row per day D-30..D-21 and an HA row
  // per day D-20..D-1. Series over integer day-offsets (subtracted from first_date) — the
  // date/interval generate_series signature doesn't exist. ON CONFLICT keeps it idempotent.
  const inserted = (await db.execute(sql`
    INSERT INTO payment_reminders (event_id, remind_on, audience)
    SELECT e.id, (e.first_date - o)::date, band.audience
    FROM events e
    CROSS JOIN LATERAL (VALUES
      ('booking_manager'::text, ${BM_TO}::int, ${BM_FROM}::int),
      ('higher_authority'::text, ${HA_TO}::int, ${HA_FROM}::int)
    ) AS band(audience, near, far)
    CROSS JOIN generate_series(band.near, band.far) AS o
    WHERE e.id IN (${sql.join(due.map((id) => sql`${id}::uuid`), sql`, `)})
    ON CONFLICT (event_id, remind_on, audience) DO NOTHING
    RETURNING event_id
  `)) as unknown as { event_id: string }[]

  return { weddings: due.length, reminders: inserted.length }
}

export type PendingReminder = {
  id: string
  eventId: string
  eventCode: string
  guestName: string
  firstDate: string
  remindOn: string
  balancePaise: number
}

/** Reminders due (remind_on ≤ asOf, not yet sent) for a role's audience. */
export async function pendingReminders(roleName: string, asOf: string): Promise<PendingReminder[]> {
  if (roleName !== 'booking_manager' && roleName !== 'higher_authority') return []
  const rows = (await db.execute(sql`
    SELECT r.id, r.event_id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
           e.first_date::text AS "firstDate", r.remind_on::text AS "remindOn",
           e.proposal_total_paise
             - COALESCE((SELECT sum(discount_paise) FROM room_allocations WHERE event_id = e.id), 0)
             - COALESCE((SELECT sum(d.amount_paise) FROM discounts d LEFT JOIN exceptions x ON x.id = d.exception_id
                         WHERE d.event_id = e.id AND (d.exception_id IS NULL OR x.status IN ('approved','approved_modified'))), 0)
             - COALESCE((SELECT sum(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END) FROM payments WHERE event_id = e.id), 0)
             AS "balancePaise"
    FROM payment_reminders r JOIN events e ON e.id = r.event_id
    WHERE r.audience = ${roleName} AND r.remind_on <= ${asOf}::date AND r.sent_at IS NULL
    ORDER BY r.remind_on
  `)) as unknown as PendingReminder[]
  // Only surface reminders whose balance is still outstanding.
  return rows.filter((r) => Number(r.balancePaise) > 0)
}

export type StaleEnquiry = { id: string; code: string; guestName: string; updatedAt: string; ageDays: number }

/** Enquiries untouched for the configured number of days (default 7) — FR-1.8. */
export async function listStaleEnquiries(asOf: string): Promise<StaleEnquiry[]> {
  const [{ days }] = (await db.execute(sql`SELECT value::int AS days FROM settings WHERE key = 'stale_enquiry_days'`)) as unknown as { days: number }[]
  const staleDays = days ?? 7
  return (await db.execute(sql`
    SELECT id, code, guest_name AS "guestName", updated_at AS "updatedAt",
           EXTRACT(DAY FROM (${asOf}::timestamptz - updated_at))::int AS "ageDays"
    FROM events
    WHERE status = 'enquiry' AND updated_at < ${asOf}::timestamptz - (${staleDays} || ' days')::interval
    ORDER BY updated_at
  `)) as unknown as StaleEnquiry[]
}
