import 'server-only'
import { listExceptions } from '@/lib/approvals'
import { listChangeRequests } from '@/lib/change-requests'
import { pendingReminders, listStaleEnquiries } from '@/lib/reminders'
import { formatPaise } from '@/lib/money'

/**
 * In-app notification feed (M10, FR-9.1). A derived, role-aware list of what needs the
 * signed-in user's attention right now — approvals to decide, change requests to decide,
 * payment reminders due, stale enquiries. Computed from live data (no stored read-state);
 * an item disappears when the underlying thing is resolved. Persistent notifications with
 * per-item read state are a future enhancement (see SEED_ASSUMPTIONS D10).
 */

const EXCEPTION_DECIDERS = new Set(['higher_authority', 'auditor'])
const CHANGE_DECIDERS = new Set(['banquet_manager', 'auditor'])

export type Notification = { id: string; kind: string; message: string; href: string; at: string }

export async function notificationsFor(user: { id: string; roleName: string }): Promise<Notification[]> {
  const today = new Date().toISOString().slice(0, 10)
  const items: Notification[] = []

  if (EXCEPTION_DECIDERS.has(user.roleName)) {
    for (const x of await listExceptions({ status: 'pending' })) {
      items.push({ id: `exc:${x.id}`, kind: 'approval', message: `Approval — ${x.eventCode}: ${x.summary}`, href: '/approvals', at: x.raisedAt })
    }
  }
  if (CHANGE_DECIDERS.has(user.roleName)) {
    for (const c of await listChangeRequests({ status: 'pending' })) {
      items.push({ id: `cr:${c.id}`, kind: 'change_request', message: `Change request — ${c.eventCode}: ${c.summary}`, href: '/change-requests', at: c.requestedAt })
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

  // Newest first.
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
