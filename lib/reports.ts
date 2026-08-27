import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'

/**
 * Management reports (M10, PRD §7). Read-only aggregations over the operational data. All six
 * are gated on the audit module (management view). Money stays in paise; the UI formats.
 */

const CONFIRMED_PLUS = sql`('confirmed','in_progress','completed','locked','billed','closed')`

/** 1. Occupancy — venue utilisation by month, hall vs lawn. */
export async function occupancyReport() {
  const byMonth = (await db.execute(sql`
    SELECT to_char(se.event_date, 'YYYY-MM') AS month,
           count(*) FILTER (WHERE v.kind = 'hall')::int AS hall,
           count(*) FILTER (WHERE v.kind = 'lawn')::int AS lawn
    FROM sub_events se JOIN events e ON e.id = se.event_id
    LEFT JOIN venues v ON v.id = se.venue_id
    WHERE e.status IN ${CONFIRMED_PLUS}
    GROUP BY 1 ORDER BY 1
  `)) as unknown as { month: string; hall: number; lawn: number }[]
  const byVenue = (await db.execute(sql`
    SELECT v.name AS "venueName", v.kind, p.name AS "propertyName", count(se.id)::int AS bookings
    FROM venues v JOIN properties p ON p.id = v.property_id
    LEFT JOIN sub_events se ON se.venue_id = v.id
      AND se.event_id IN (SELECT id FROM events WHERE status IN ${CONFIRMED_PLUS})
    GROUP BY v.name, v.kind, p.name ORDER BY bookings DESC, v.name
  `)) as unknown as { venueName: string; kind: string; propertyName: string; bookings: number }[]
  return { byMonth, byVenue }
}

/** 2. Revenue — billed revenue by event type + property, with a tax summary for GST. */
export async function revenueReport() {
  const byEventType = (await db.execute(sql`
    SELECT e.event_type AS "eventType", count(*)::int AS events,
           COALESCE(sum(i.net_paise), 0)::bigint AS "netPaise"
    FROM events e JOIN invoices i ON i.event_id = e.id
    WHERE i.finalised_at IS NOT NULL AND i.superseded_at IS NULL
    GROUP BY e.event_type ORDER BY "netPaise" DESC
  `)) as unknown as { eventType: string; events: number; netPaise: number }[]
  const byProperty = (await db.execute(sql`
    SELECT p.name AS "propertyName", COALESCE(sum(se.venue_rate_paise), 0)::bigint AS "venueRevenuePaise"
    FROM sub_events se JOIN venues v ON v.id = se.venue_id JOIN properties p ON p.id = v.property_id
    WHERE se.event_id IN (SELECT event_id FROM invoices WHERE finalised_at IS NOT NULL AND superseded_at IS NULL)
    GROUP BY p.name ORDER BY "venueRevenuePaise" DESC
  `)) as unknown as { propertyName: string; venueRevenuePaise: number }[]
  // GROSS AND DISCOUNT BOTH COUNT THE LINES (20 Aug 2026). Since a discount became a PRICE
  // rather than a deduction, most of one lives inside `invoice_lines.amount_paise` and never
  // reaches `invoices.discount_paise` — which is the lump discounts alone now. Summing that
  // column by itself made this report say "Discounts ₹0" on a month in which the hotel had
  // given lakhs away, and understated gross by exactly the same amount.
  //
  // The lines remember what they would have cost: `gross_amount_paise` (migration 0036), NULL
  // when nothing was given. So the discount is recoverable from the invoice itself rather than
  // from the live `discounts` table — which matters, because an issued document must not
  // re-report itself differently after somebody re-prices a booking. `netPaise` was always
  // right and is untouched; only the two figures either side of it were hiding the money.
  const [tax] = (await db.execute(sql`
    WITH line_disc AS (
      SELECT l.invoice_id, sum(COALESCE(l.gross_amount_paise, l.amount_paise) - l.amount_paise)::bigint AS given
      FROM invoice_lines l GROUP BY l.invoice_id
    )
    SELECT COALESCE(sum(i.gross_paise + COALESCE(d.given, 0)),0)::bigint AS "grossPaise",
           COALESCE(sum(i.discount_paise + COALESCE(d.given, 0)),0)::bigint AS "discountPaise",
           COALESCE(sum(i.tax_paise),0)::bigint AS "taxPaise",
           -- The 18% the documents print and nobody pays (migration 0026). Carried so this
           -- report can be reconciled against a bill without the two seeming to disagree.
           COALESCE(sum(i.shown_tax_paise),0)::bigint AS "shownTaxPaise",
           COALESCE(sum(i.net_paise),0)::bigint AS "netPaise"
    FROM invoices i
    LEFT JOIN line_disc d ON d.invoice_id = i.id
    WHERE i.finalised_at IS NOT NULL AND i.superseded_at IS NULL
  `)) as unknown as { grossPaise: number; discountPaise: number; taxPaise: number; shownTaxPaise: number; netPaise: number }[]
  return { byEventType, byProperty, taxSummary: tax }
}

/** 3. Pipeline — enquiries by status + conversion rate. */
export async function pipelineReport() {
  const byStatus = (await db.execute(sql`
    SELECT status::text AS status, count(*)::int AS n FROM events GROUP BY status ORDER BY n DESC
  `)) as unknown as { status: string; n: number }[]
  const total = byStatus.reduce((s, r) => s + r.n, 0)
  const confirmedPlus = byStatus.filter((r) => r.status !== 'enquiry' && r.status !== 'cancelled').reduce((s, r) => s + r.n, 0)
  const cancelled = byStatus.find((r) => r.status === 'cancelled')?.n ?? 0
  return { byStatus, total, confirmedPlus, cancelled, conversionRatePct: total > 0 ? Math.round((confirmedPlus / total) * 1000) / 10 : 0 }
}

/** 4. Exceptions — GM approvals by category and outcome. */
export async function exceptionsReport() {
  const rows = (await db.execute(sql`
    SELECT kind::text AS kind, status::text AS status, count(*)::int AS n
    FROM exceptions GROUP BY kind, status ORDER BY kind, status
  `)) as unknown as { kind: string; status: string; n: number }[]
  const [{ pending }] = (await db.execute(sql`SELECT count(*)::int AS pending FROM exceptions WHERE status = 'pending'`)) as unknown as { pending: number }[]
  return { rows, pending }
}

/** 5. Maintenance cost — per event and aggregate. */
export async function maintenanceReport() {
  const byEvent = (await db.execute(sql`
    SELECT e.id AS "eventId", e.code, e.guest_name AS "guestName",
           count(m.id)::int AS entries, COALESCE(sum(m.amount_paise),0)::bigint AS "totalPaise"
    FROM maintenance_entries m JOIN events e ON e.id = m.event_id
    GROUP BY e.id, e.code, e.guest_name ORDER BY "totalPaise" DESC
  `)) as unknown as { eventId: string; code: string; guestName: string; entries: number; totalPaise: number }[]
  const totalPaise = byEvent.reduce((s, r) => s + Number(r.totalPaise), 0)
  return { byEvent, totalPaise }
}

/** 6. Outstanding — billed vs collected, ageing of balances. */
export async function outstandingReport() {
  const rows = (await db.execute(sql`
    SELECT e.id AS "eventId", e.code, e.guest_name AS "guestName",
           i.net_paise AS "netPaise", i.advances_paise AS "paidPaise", i.balance_paise AS "balancePaise",
           i.invoice_no AS "invoiceNo",
           GREATEST(0, (CURRENT_DATE - i.finalised_at::date))::int AS "ageDays"
    FROM invoices i JOIN events e ON e.id = i.event_id
    WHERE i.finalised_at IS NOT NULL AND i.superseded_at IS NULL AND i.balance_paise > 0
    ORDER BY "ageDays" DESC, "balancePaise" DESC
  `)) as unknown as { eventId: string; code: string; guestName: string; netPaise: number; paidPaise: number; balancePaise: number; invoiceNo: string; ageDays: number }[]
  const totalOutstanding = rows.reduce((s, r) => s + Number(r.balancePaise), 0)
  const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }
  for (const r of rows) {
    const b = Number(r.balancePaise)
    if (r.ageDays <= 30) buckets.d0_30 += b
    else if (r.ageDays <= 60) buckets.d31_60 += b
    else if (r.ageDays <= 90) buckets.d61_90 += b
    else buckets.d90_plus += b
  }
  return { rows, totalOutstanding, buckets }
}

/**
 * 7. Overview — the one screen a manager reads first: how the pipeline converts, who is
 * writing the proposals, and which venues the enquiries actually ask for.
 *
 * It aggregates PROPOSALS, not invoices, and that is the point. The five reports above are
 * built on `invoices`, so until a booking is billed they have nothing to say — on a hotel
 * whose bookings are still months out, five of the six tabs read empty. Everything here comes
 * from `events`, `sub_events` and `payments`, which exist from the first enquiry.
 *
 * Money is therefore PROPOSAL value — `proposal_total_paise`, i.e. venue + food + add-ons
 * before tax and before discounts — and every figure that leaves this function is labelled as
 * such in the UI. It is deliberately not called a total: a bill's Total and Amount payable are
 * a pair (CLAUDE.md rule 11) and neither is what a pipeline is worth.
 */
export async function overviewReport() {
  // Conversion counts the same way `pipelineReport` does — confirmed-or-beyond over every
  // proposal ever raised — so the two tabs can never print different percentages.
  const [funnel] = (await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'enquiry')::int AS enquiry,
           count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
           count(*) FILTER (WHERE status = 'in_progress')::int AS running,
           count(*) FILTER (WHERE status IN ('completed','locked','billed','closed'))::int AS delivered,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
           COALESCE(sum(proposal_total_paise) FILTER (WHERE status = 'enquiry'),0)::bigint AS "openValuePaise",
           COALESCE(sum(proposal_total_paise) FILTER (WHERE status IN ${CONFIRMED_PLUS}),0)::bigint AS "wonValuePaise"
    FROM events
  `)) as unknown as {
    total: number; enquiry: number; confirmed: number; running: number; delivered: number
    cancelled: number; openValuePaise: number; wonValuePaise: number
  }[]

  const [collected] = (await db.execute(sql`
    SELECT COALESCE(sum(amount_paise),0)::bigint AS "paidPaise", count(*)::int AS receipts FROM payments
  `)) as unknown as { paidPaise: number; receipts: number }[]

  // Demand, not utilisation: every function on a live proposal, enquiries included, because
  // what this answers is "which room do people ask for". The Occupancy tab counts confirmed
  // bookings only, and says so. Bundles are counted as themselves — 11 of the 41 functions on
  // the books are bundle lets, and joining on venue_id alone drops every one of them.
  //
  // Grouped by ID, not by name. `venues` is unique on (property_id, name) only, so the day
  // Palace and Regency both have a "Crystal" the two are different rooms — grouping by the
  // text would silently add them into one bar. The property rides along for the same reason:
  // two bars reading "Crystal" need telling apart. A renamed venue simply reports under its
  // new name, since nothing here caches it.
  const venues = (await db.execute(sql`
    SELECT v.name, v.kind, p.name AS property, count(*)::int AS functions
    FROM sub_events se JOIN events e ON e.id = se.event_id AND e.status <> 'cancelled'
    JOIN venues v ON v.id = se.venue_id
    JOIN properties p ON p.id = v.property_id
    GROUP BY v.id, v.name, v.kind, p.name
    UNION ALL
    SELECT b.name, 'bundle' AS kind, NULL AS property, count(*)::int AS functions
    FROM sub_events se JOIN events e ON e.id = se.event_id AND e.status <> 'cancelled'
    JOIN venue_bundles b ON b.id = se.bundle_id
    GROUP BY b.id, b.name
    ORDER BY functions DESC, name
  `)) as unknown as { name: string; kind: string; property: string | null; functions: number }[]

  // Whose proposals convert. `events.created_by` has been on the table since 0001, so this
  // reaches back over every booking the hotel has ever taken.
  //
  // Grouped by u.id and joined live, so staff changes need no maintenance here: a manager
  // hired tomorrow appears with their first proposal, a renamed one reports under the new
  // name from the next page load, and two people who happen to share a name stay two rows.
  // It lists whoever has RAISED a proposal, not everyone who could — a directory of people
  // with nothing to rank is not a leaderboard, and the panel says so.
  const managers = (await db.execute(sql`
    SELECT u.full_name AS name, u.is_active AS "isActive",
           count(*)::int AS proposals,
           count(*) FILTER (WHERE e.status IN ${CONFIRMED_PLUS})::int AS won,
           count(*) FILTER (WHERE e.status = 'cancelled')::int AS cancelled,
           COALESCE(sum(e.proposal_total_paise) FILTER (WHERE e.status IN ${CONFIRMED_PLUS}),0)::bigint AS "wonValuePaise",
           COALESCE(sum(e.proposal_total_paise),0)::bigint AS "raisedValuePaise"
    FROM events e JOIN users u ON u.id = e.created_by
    GROUP BY u.id, u.full_name, u.is_active
    ORDER BY won DESC, proposals DESC, u.full_name
  `)) as unknown as {
    name: string; isActive: boolean; proposals: number; won: number; cancelled: number
    wonValuePaise: number; raisedValuePaise: number
  }[]

  // By the event type's CODE, which is its primary key — two types are allowed to be given
  // the same display name, and they would otherwise merge into one bar.
  const byType = (await db.execute(sql`
    SELECT COALESCE(t.display_name, e.event_type) AS label, count(*)::int AS n
    FROM events e LEFT JOIN event_types t ON t.code = e.event_type
    WHERE e.status <> 'cancelled'
    GROUP BY e.event_type, t.display_name ORDER BY n DESC, 1
  `)) as unknown as { label: string; n: number }[]

  const f = funnel!
  const stages = [
    { key: 'enquiry', label: 'Enquiry', n: f.enquiry },
    { key: 'confirmed', label: 'Confirmed', n: f.confirmed },
    { key: 'running', label: 'In progress', n: f.running },
    { key: 'delivered', label: 'Completed', n: f.delivered },
    { key: 'cancelled', label: 'Cancelled', n: f.cancelled },
  ].filter((s) => s.n > 0)

  const won = f.confirmed + f.running + f.delivered
  return {
    stages,
    total: f.total,
    won,
    conversionRatePct: f.total > 0 ? Math.round((won / f.total) * 1000) / 10 : 0,
    openValuePaise: Number(f.openValuePaise),
    wonValuePaise: Number(f.wonValuePaise),
    collectedPaise: Number(collected!.paidPaise),
    receipts: collected!.receipts,
    venues,
    managers,
    byType,
  }
}

export const REPORTS: Record<string, () => Promise<unknown>> = {
  overview: overviewReport,
  occupancy: occupancyReport,
  revenue: revenueReport,
  pipeline: pipelineReport,
  exceptions: exceptionsReport,
  maintenance: maintenanceReport,
  outstanding: outstandingReport,
}
