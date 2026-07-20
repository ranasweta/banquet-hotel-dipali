import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { listExceptions } from '@/lib/approvals'
import { listChangeRequests } from '@/lib/change-requests'
import { pendingReminders, listStaleEnquiries } from '@/lib/reminders'
import { formatPaise } from '@/lib/money'

/**
 * In-app notification feed (M10, FR-9.1). A derived, role-aware list of what needs the
 * signed-in user's attention right now, each pointing at the screen where they can act on it.
 *
 * Two rules shape it:
 *  - **Only your own queue.** An approval belongs to whoever settles it, so the decider sets
 *    below mirror the queue scoping in the routes — a Banquet Manager is never told about a
 *    menu increase sitting with the GM. Everyone else hears back only about their own request.
 *  - **Touched means gone.** The list is still computed from live data, so an item vanishes by
 *    itself once resolved; `notification_reads` additionally drops anything the user has already
 *    clicked, so something they've dealt with stops following them around.
 */

const EXCEPTION_DECIDERS = new Set(['higher_authority', 'auditor'])
const CHANGE_DECIDERS = new Set(['banquet_manager', 'auditor'])
const DELICACY_PRICERS = new Set(['chef', 'auditor'])
const MAINTENANCE_ROLES = new Set(['maintenance', 'auditor'])

export type Notification = { id: string; kind: string; message: string; href: string; at: string }

export async function notificationsFor(user: { id: string; roleName: string }): Promise<Notification[]> {
  const today = new Date().toISOString().slice(0, 10)
  const items: Notification[] = []

  if (EXCEPTION_DECIDERS.has(user.roleName)) {
    for (const x of await listExceptions({ status: 'pending' })) {
      items.push({ id: `exc:${x.id}`, kind: 'approval', message: `Approval — ${x.eventCode}: ${x.summary}`, href: '/approvals', at: x.raisedAt })
    }
  } else {
    // The raiser hears back about their own request, and about nothing else.
    for (const x of await listExceptions({ mineId: user.id })) {
      if (x.status === 'pending') continue
      items.push({
        id: `exc-done:${x.id}`,
        kind: 'approval',
        message: `Your request was ${x.status.replace('_', ' ')} — ${x.eventCode}: ${x.summary}`,
        href: '/approvals',
        at: x.decidedAt ?? x.raisedAt,
      })
    }
  }

  if (CHANGE_DECIDERS.has(user.roleName)) {
    for (const c of await listChangeRequests({ status: 'pending' })) {
      items.push({ id: `cr:${c.id}`, kind: 'change_request', message: `Change request — ${c.eventCode}: ${c.summary}`, href: '/change-requests', at: c.requestedAt })
    }
  }

  // Chef: delicacies waiting on a price. Everyone else hears back once theirs is settled.
  if (DELICACY_PRICERS.has(user.roleName)) {
    const rows = (await db.execute(sql`
      SELECT r.id, r.description, r.requested_at AS "at", e.code AS "eventCode"
      FROM chef_requests r
      JOIN sub_events se ON se.id = r.sub_event_id
      JOIN events e ON e.id = se.event_id
      WHERE r.status = 'pending'
      ORDER BY r.requested_at
    `)) as unknown as { id: string; description: string; at: string; eventCode: string }[]
    for (const r of rows) {
      items.push({ id: `chef:${r.id}`, kind: 'chef', message: `Price a delicacy — ${r.eventCode}: ${r.description}`, href: '/chef', at: r.at })
    }
  } else {
    const rows = (await db.execute(sql`
      SELECT r.id, r.description, r.status, r.charge_paise AS "chargePaise",
             COALESCE(r.priced_at, r.requested_at) AS "at", e.code AS "eventCode"
      FROM chef_requests r
      JOIN sub_events se ON se.id = r.sub_event_id
      JOIN events e ON e.id = se.event_id
      WHERE r.requested_by = ${user.id} AND r.status <> 'pending'
      ORDER BY "at" DESC
    `)) as unknown as { id: string; description: string; status: string; chargePaise: number | null; at: string; eventCode: string }[]
    for (const r of rows) {
      const outcome = r.status === 'priced' ? `priced ${formatPaise(Number(r.chargePaise ?? 0))}/plate` : 'declined'
      items.push({ id: `chef-done:${r.id}`, kind: 'chef', message: `Chef ${outcome} — ${r.eventCode}: ${r.description}`, href: '/chef', at: r.at })
    }
  }

  // Maintenance: a completed event left open blocks the lock checklist (FR-5.2).
  if (MAINTENANCE_ROLES.has(user.roleName)) {
    const rows = (await db.execute(sql`
      SELECT e.id, e.code, e.updated_at AS "at"
      FROM events e
      WHERE e.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM lock_signoffs s WHERE s.event_id = e.id AND s.designation = 'maintenance')
      ORDER BY e.updated_at DESC
    `)) as unknown as { id: string; code: string; at: string }[]
    for (const r of rows) {
      items.push({ id: `maint:${r.id}`, kind: 'maintenance', message: `Close maintenance — ${r.code} is completed`, href: '/maintenance', at: r.at })
    }
  }

  for (const r of await pendingReminders(user.roleName, today)) {
    items.push({ id: `rem:${r.id}`, kind: 'payment', message: `Payment due — ${r.eventCode}: balance ${formatPaise(r.balancePaise)}`, href: `/bookings/${r.eventId}`, at: r.remindOn })
  }
  if (user.roleName === 'booking_manager' || user.roleName === 'auditor') {
    for (const s of await listStaleEnquiries(today)) {
      items.push({ id: `stale:${s.id}`, kind: 'stale', message: `Stale enquiry — ${s.code} (${s.ageDays}d untouched)`, href: `/bookings/${s.id}`, at: s.updatedAt })
    }
  }

  // Drop anything this user has already clicked through.
  const read = (await db.execute(sql`
    SELECT notification_id AS id FROM notification_reads WHERE user_id = ${user.id}
  `)) as unknown as { id: string }[]
  const dismissed = new Set(read.map((r) => r.id))

  return items
    .filter((n) => !dismissed.has(n.id))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** Marks notifications dealt with, so they stop appearing. Idempotent. */
export async function markNotificationsRead(userId: string, ids: string[]): Promise<number> {
  const clean = [...new Set(ids.map((i) => i.trim()).filter(Boolean))].slice(0, 200)
  if (clean.length === 0) return 0
  await db.execute(sql`
    INSERT INTO notification_reads (user_id, notification_id)
    VALUES ${sql.join(clean.map((id) => sql`(${userId}, ${id})`), sql`, `)}
    ON CONFLICT (user_id, notification_id) DO NOTHING
  `)
  return clean.length
}
