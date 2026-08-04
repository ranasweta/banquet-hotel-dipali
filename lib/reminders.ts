import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { WEDDING_MILESTONE_PCT, paymentSchedule } from '@/lib/payment-schedule'

/**
 * Payment reminders & stale-enquiry job (M7, BR-P2, FR-1.8, FR-9.1).
 *
 * Wedding milestone (BR-P2, amended by the client's lead on 4 Aug 2026): 30 days before the
 * first function, the total received must reach **50% of the payable amount** — not the whole
 * remaining 75%, which is what the hotel used to ask for and stopped collecting. Anything above
 * 50% is welcome and never refused; the rest settles at billing. The Booking Manager is reminded
 * daily from D-30 through D-21; from D-20 the Higher Authority is reminded too, through D-1.
 * Rows are pre-generated into payment_reminders (idempotent on the unique key) so a daily send
 * can pick up whatever is due; a wedding already at 50% generates none.
 *
 * WHAT IS OWED comes from `lib/payment-schedule.ts` and nowhere else. This module used to
 * measure `proposal_total_paise` alone — venue and food — so a wedding with thirty rooms was
 * chased for a fraction of what it owed, and one that had paid off the venue stopped being
 * chased at all. The same query also summed `discounts.amount_paise` raw, ignoring the live
 * percentage rows, which pulled the figure a second way.
 *
 * Dates come from `min(sub_events.event_date)`, never `events.first_date` — that column is a
 * cache written at confirm and can be NULL or stale after a function moves.
 */

const BM_FROM = 30
const BM_TO = 21
const HA_FROM = 20
const HA_TO = 1

/** What this wedding is still short of its 50% milestone, or 0 if it has met it. */
async function weddingShortfallPaise(eventId: string, asOf: string): Promise<number> {
  const schedule = await paymentSchedule(eventId, asOf)
  return schedule.milestones.find((m) => m.key === 'wedding_balance')?.shortfallPaise ?? 0
}

/**
 * Generates the wedding milestone-reminder schedule for every upcoming, under-paid confirmed
 * wedding as of `asOf`. Idempotent. Returns how many reminder rows were newly created.
 */
export async function generateWeddingReminders(asOf: string): Promise<{ weddings: number; reminders: number }> {
  const candidates = (await db.execute(sql`
    SELECT e.id, min(se.event_date)::text AS "firstDate"
    FROM events e
    JOIN event_types et ON et.code = e.event_type
    JOIN sub_events se ON se.event_id = e.id
    WHERE et.is_wedding
      AND e.status IN ('confirmed','in_progress')
    GROUP BY e.id
    HAVING min(se.event_date) > ${asOf}::date
  `)) as unknown as { id: string; firstDate: string }[]

  const due: string[] = []
  for (const c of candidates) {
    if ((await weddingShortfallPaise(c.id, asOf)) > 0) due.push(c.id)
  }
  if (due.length === 0) return { weddings: 0, reminders: 0 }

  // One statement: for each qualifying wedding, a BM row per day D-30..D-21 and an HA row
  // per day D-20..D-1. Series over integer day-offsets (subtracted from the first function's
  // date) — the date/interval generate_series signature doesn't exist. ON CONFLICT keeps it
  // idempotent.
  const inserted = (await db.execute(sql`
    INSERT INTO payment_reminders (event_id, remind_on, audience)
    SELECT f.id, (f.first_date - o)::date, band.audience
    FROM (
      SELECT se.event_id AS id, min(se.event_date) AS first_date
      FROM sub_events se
      WHERE se.event_id IN (${sql.join(due.map((id) => sql`${id}::uuid`), sql`, `)})
      GROUP BY se.event_id
    ) AS f
    CROSS JOIN LATERAL (VALUES
      ('booking_manager'::text, ${BM_TO}::int, ${BM_FROM}::int),
      ('higher_authority'::text, ${HA_TO}::int, ${HA_FROM}::int)
    ) AS band(audience, near, far)
    CROSS JOIN generate_series(band.near, band.far) AS o
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
  /** What is still short of the 50% milestone — not the whole outstanding balance. */
  shortfallPaise: number
  /** The milestone itself, so the widget can say "50% of ₹X" without a second call. */
  milestonePaise: number
  milestonePct: number
}

/** Reminders due (remind_on ≤ asOf, not yet sent) for a role's audience. */
export async function pendingReminders(roleName: string, asOf: string): Promise<PendingReminder[]> {
  if (roleName !== 'booking_manager' && roleName !== 'higher_authority') return []
  const rows = (await db.execute(sql`
    SELECT r.id, r.event_id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
           (SELECT min(se.event_date)::text FROM sub_events se WHERE se.event_id = e.id) AS "firstDate",
           r.remind_on::text AS "remindOn"
    FROM payment_reminders r JOIN events e ON e.id = r.event_id
    WHERE r.audience = ${roleName} AND r.remind_on <= ${asOf}::date AND r.sent_at IS NULL
    ORDER BY r.remind_on
  `)) as unknown as Omit<PendingReminder, 'shortfallPaise' | 'milestonePaise' | 'milestonePct'>[]

  // Priced one by one against the live schedule rather than in the query above: the milestone
  // is a percentage of a bill that moves, and a reminder for a wedding that has since paid up
  // must not surface at all. The list is only what is due today, so it stays short.
  const out: PendingReminder[] = []
  for (const r of rows) {
    const schedule = await paymentSchedule(r.eventId, asOf)
    const m = schedule.milestones.find((x) => x.key === 'wedding_balance')
    if (!m || m.shortfallPaise <= 0) continue
    out.push({
      ...r,
      shortfallPaise: m.shortfallPaise,
      milestonePaise: m.requiredPaise,
      milestonePct: WEDDING_MILESTONE_PCT,
    })
  }
  return out
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
