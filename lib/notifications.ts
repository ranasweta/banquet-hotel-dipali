import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { listExceptions, DECIDER_ROLES as EXCEPTION_DECIDERS } from '@/lib/approvals'
import { listBundles } from '@/lib/approval-bundles'
import { listChangeRequests, DECIDER_ROLES as CHANGE_DECIDERS } from '@/lib/change-requests'
import { PRICER_ROLES as DELICACY_PRICERS } from '@/lib/chef'
import { pendingReminders, listStaleEnquiries } from '@/lib/reminders'
import { listRoomShortfalls } from '@/lib/rooms'
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
 *
 * EVERY SOURCE IS FETCHED AT ONCE (4 Aug 2026). The feed reads eleven independent things and
 * used to `await` each in turn. Nothing here depends on anything else here — the ordering was
 * incidental — but on a remote database each await is a full network round trip, and this
 * endpoint is polled by the notification bell on EVERY page. Measured against Neon us-east-1
 * from India it took 5–22 seconds per call and held two of the pool's five connections for the
 * duration, which is what made the rest of the app feel broken rather than merely slow.
 * A source that does not apply to this role resolves to an empty list rather than being
 * skipped, so the shape stays flat and the role rules stay in one readable place.
 */

// The decider sets are imported, not re-declared: they were three separate literals here
// and the feed silently disagreed with the routes the moment one of them moved — which is
// exactly what happened when change requests passed from the Banquet Manager to the GM.
const MAINTENANCE_ROLES = new Set(['maintenance', 'auditor'])

export type Notification = { id: string; kind: string; message: string; href: string; at: string }

export async function notificationsFor(
  user: { id: string; roleName: string; lodgingUnitId?: string | null },
): Promise<Notification[]> {
  const today = new Date().toISOString().slice(0, 10)
  const items: Notification[] = []

  const decidesExceptions = EXCEPTION_DECIDERS.has(user.roleName)
  const decidesChanges = CHANGE_DECIDERS.has(user.roleName)
  const pricesDelicacies = DELICACY_PRICERS.has(user.roleName)
  const doesMaintenance = MAINTENANCE_ROLES.has(user.roleName)
  const seesStale = user.roleName === 'booking_manager' || user.roleName === 'auditor'
  const shortfallScope =
    user.roleName === 'auditor'
      ? {}
      : user.roleName === 'lodge_manager'
        ? { unitId: user.lodgingUnitId ?? undefined }
        : { ownerId: user.id }
  // A Lodge Manager with no lodge assigned would otherwise read as "every lodge".
  const seesShortfalls = !(user.roleName === 'lodge_manager' && !user.lodgingUnitId)
  const none = <T,>(): Promise<T[]> => Promise.resolve([])

  const [
    bundles,
    myExceptions,
    revisions,
    myChangeRequests,
    delicaciesToPrice,
    myDelicacies,
    openMaintenance,
    shortfalls,
    reminders,
    stale,
    read,
  ] = await Promise.all([
    decidesExceptions ? listBundles() : none<Awaited<ReturnType<typeof listBundles>>[number]>(),
    decidesExceptions ? none<Awaited<ReturnType<typeof listExceptions>>[number]>() : listExceptions({ mineId: user.id }),
    db.execute(sql`
      SELECT a.seq, a.new_value AS "summary", a.field, a.at, a.event_id AS "eventId",
             e.code AS "eventCode", u.full_name AS "byName"
        FROM audit_log a
        JOIN events e ON e.id = a.event_id
        JOIN users u ON u.id = a.user_id
       WHERE a.field IN ('authority_edit', 'authority_override')
         AND e.created_by = ${user.id}
         AND a.user_id <> ${user.id}
       ORDER BY a.at DESC
       LIMIT 50
    `) as unknown as Promise<{ seq: string; summary: string | null; field: string; at: string; eventId: string; eventCode: string; byName: string }[]>,
    decidesChanges ? none<Awaited<ReturnType<typeof listChangeRequests>>[number]>() : listChangeRequests({ mineId: user.id }),
    pricesDelicacies
      ? (db.execute(sql`
          SELECT r.id, r.description, r.requested_at AS "at", e.code AS "eventCode"
          FROM chef_requests r
          JOIN sub_events se ON se.id = r.sub_event_id
          JOIN events e ON e.id = se.event_id
          WHERE r.status = 'pending'
          ORDER BY r.requested_at
        `) as unknown as Promise<{ id: string; description: string; at: string; eventCode: string }[]>)
      : none<{ id: string; description: string; at: string; eventCode: string }>(),
    pricesDelicacies
      ? none<{ id: string; description: string; status: string; chargePaise: number | null; at: string; eventCode: string }>()
      : (db.execute(sql`
          SELECT r.id, r.description, r.status, r.charge_paise AS "chargePaise",
                 COALESCE(r.priced_at, r.requested_at) AS "at", e.code AS "eventCode"
          FROM chef_requests r
          JOIN sub_events se ON se.id = r.sub_event_id
          JOIN events e ON e.id = se.event_id
          WHERE r.requested_by = ${user.id} AND r.status <> 'pending'
          ORDER BY "at" DESC
        `) as unknown as Promise<{ id: string; description: string; status: string; chargePaise: number | null; at: string; eventCode: string }[]>),
    doesMaintenance
      ? (db.execute(sql`
          SELECT e.id, e.code, e.updated_at AS "at"
          FROM events e
          WHERE e.status = 'completed'
            AND NOT EXISTS (SELECT 1 FROM lock_signoffs s WHERE s.event_id = e.id AND s.designation = 'maintenance')
          ORDER BY e.updated_at DESC
        `) as unknown as Promise<{ id: string; code: string; at: string }[]>)
      : none<{ id: string; code: string; at: string }>(),
    seesShortfalls ? listRoomShortfalls(shortfallScope) : none<Awaited<ReturnType<typeof listRoomShortfalls>>[number]>(),
    pendingReminders(user.roleName, today),
    seesStale ? listStaleEnquiries(today) : none<Awaited<ReturnType<typeof listStaleEnquiries>>[number]>(),
    db.execute(sql`
      SELECT notification_id AS id FROM notification_reads WHERE user_id = ${user.id}
    `) as unknown as Promise<{ id: string }[]>,
  ])

  if (decidesExceptions) {
    // ONE notice per proposal, not per request (client's lead, 1 Aug 2026). A wedding raising a
    // menu increase, a 35+ room ask and an over-cap discount is one thing for the GM to sit
    // down with, and telling him about it three times is the drip-feed he objected to. Change
    // requests are inside the bundle now, so they are deliberately not listed separately below.
    for (const b of bundles) {
      const sections = b.bySection.map((s) => `${s.n} ${s.section}`).join(', ')
      items.push({
        id: `bundle:${b.eventId}:${b.pendingCount}`,
        kind: 'approval',
        message: `Approval — ${b.eventCode} ${b.guestName}: ${b.pendingCount} item(s) awaiting you (${sections})`,
        href: `/approvals/${b.eventId}`,
        at: b.oldestRaisedAt,
      })
    }
  } else {
    // The raiser hears back about their own request, and about nothing else.
    for (const x of myExceptions) {
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

  // The Authority has revised a booking this user owns (client's lead, 1 Aug 2026). He edits
  // proposals directly from the approvals screen rather than sending instructions back, so the
  // only way the Booking Manager learns his guest's menu changed is this notice. Derived from
  // the ONE summary row each save writes (lib/gm-authority.ts) — the field-level rows beside it
  // would turn a single save into six notifications.
  for (const r of revisions) {
    items.push({
      id: `gm-edit:${r.seq}`,
      kind: 'revision',
      message:
        `${r.byName} revised ${r.eventCode}` +
        (r.field === 'authority_override' ? ' (locked booking)' : '') +
        (r.summary ? `: ${r.summary}` : ''),
      href: `/bookings/${r.eventId}`,
      at: r.at,
    })
  }

  if (!decidesChanges) {
    // The raiser hears the outcome, the same way they do for an exception or a delicacy.
    // Without this branch a Booking Manager whose venue move was refused was never told.
    for (const c of myChangeRequests) {
      if (c.status === 'pending') continue
      items.push({
        id: `cr-done:${c.id}`,
        kind: 'change_request',
        message: `Your change request was ${c.status} — ${c.eventCode}: ${c.summary}`,
        href: '/change-requests',
        at: c.decidedAt ?? c.requestedAt,
      })
    }
  }

  // Chef: delicacies waiting on a price. Everyone else hears back once theirs is settled.
  if (pricesDelicacies) {
    for (const r of delicaciesToPrice) {
      items.push({ id: `chef:${r.id}`, kind: 'chef', message: `Price a delicacy — ${r.eventCode}: ${r.description}`, href: '/chef', at: r.at })
    }
  } else {
    for (const r of myDelicacies) {
      const outcome = r.status === 'priced' ? `priced ${formatPaise(Number(r.chargePaise ?? 0))}/plate` : 'declined'
      items.push({ id: `chef-done:${r.id}`, kind: 'chef', message: `Chef ${outcome} — ${r.eventCode}: ${r.description}`, href: '/chef', at: r.at })
    }
  }

  // Maintenance: a completed event left open blocks the lock checklist (FR-5.2).
  if (doesMaintenance) {
    for (const r of openMaintenance) {
      items.push({ id: `maint:${r.id}`, kind: 'maintenance', message: `Close maintenance — ${r.code} is completed`, href: '/maintenance', at: r.at })
    }
  }

  // Rooms that have gone to someone who committed first (client, 21 Jul 2026). Enquiries
  // hold nothing, so the loser is told rather than blocked in advance: "change the booking
  // room dates or category or anything". The same entry catches a room retired under a
  // booking that was sound when it was made.
  //
  // Scoped the way every other queue is — the proposal's owner hears about their own, a
  // Lodge Manager about their own lodge, and the Auditor about all of it. A shortfall is
  // derived live, so fixing the booking makes the notice disappear on its own.
  if (seesShortfalls) {
    for (const sf of shortfalls) {
      const stay = `${sf.checkIn} to ${sf.checkOut}`
      items.push({
        // Keyed on the requirement row: a proposal can hold two lines of the same category
        // and check-in that differ only in check-out, so the shape of the line is not unique.
        id: `rooms-short:${sf.requirementId}`,
        kind: 'rooms',
        message:
          `Rooms no longer free — ${sf.eventCode}: ${sf.shortfall} of ${sf.promised} ` +
          `${sf.unitName} ${sf.roomType.replace(/_/g, ' ')} (${stay}). ` +
          `Change the dates, category or lodge.`,
        href: `/bookings/${sf.eventId}`,
        at: today,
      })
    }
  }

  for (const r of reminders) {
    // What to collect to reach the milestone, not the whole outstanding balance — the wedding
    // asks for 50% by D-30 and settles the rest at billing (client, 4 Aug 2026).
    items.push({ id: `rem:${r.id}`, kind: 'payment', message: `Payment due — ${r.eventCode}: collect ${formatPaise(r.shortfallPaise)} to reach ${r.milestonePct}%`, href: `/bookings/${r.eventId}`, at: r.remindOn })
  }
  if (seesStale) {
    for (const s of stale) {
      items.push({ id: `stale:${s.id}`, kind: 'stale', message: `Stale enquiry — ${s.code} (${s.ageDays}d untouched)`, href: `/bookings/${s.id}`, at: s.updatedAt })
    }
  }

  // Drop anything this user has already clicked through.
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
