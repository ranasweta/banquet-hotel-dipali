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
  const [tax] = (await db.execute(sql`
    SELECT COALESCE(sum(gross_paise),0)::bigint AS "grossPaise", COALESCE(sum(discount_paise),0)::bigint AS "discountPaise",
           COALESCE(sum(tax_paise),0)::bigint AS "taxPaise", COALESCE(sum(net_paise),0)::bigint AS "netPaise"
    FROM invoices WHERE finalised_at IS NOT NULL AND superseded_at IS NULL
  `)) as unknown as { grossPaise: number; discountPaise: number; taxPaise: number; netPaise: number }[]
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

export const REPORTS: Record<string, () => Promise<unknown>> = {
  occupancy: occupancyReport,
  revenue: revenueReport,
  pipeline: pipelineReport,
  exceptions: exceptionsReport,
  maintenance: maintenanceReport,
  outstanding: outstandingReport,
}
