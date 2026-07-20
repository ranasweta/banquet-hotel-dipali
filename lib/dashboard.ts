import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { listExceptions, type ExceptionRow } from '@/lib/approvals'

/**
 * Role home dashboards. Every signed-in user lands on `/`, which dispatches to the board for
 * their role (see getDashboardForRole). Each board answers "what needs me today" from that
 * role's angle: the Booking Manager works the pipeline, the Banquet Manager runs the floor and
 * kitchen, the Lodge Manager runs rooms, Maintenance works live events. Higher Authority and
 * the Auditor keep the Booking board for now.
 *
 * Two data choices apply throughout:
 *  - Agendas read `sub_events.event_date` directly, never `events.first_date` — first_date is a
 *    derived cache that some rows (seeded/imported) never had backfilled.
 *  - Money maths mirror lib/reminders.ts. sum() over int8 returns numeric (a string over the
 *    wire), so every aggregate is coerced with Number() on the way out.
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

/** Pending sub-event change requests (date/time/venue moves) with event + requester context. */
function pendingChangeRequests(): Promise<PendingChangeRequest[]> {
  return db.execute(sql`
    SELECT cr.id, cr.summary, cr.reason, cr.requested_at AS "requestedAt",
           e.id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
           u.full_name AS "requestedByName"
    FROM change_requests cr
    JOIN events e ON e.id = cr.event_id
    JOIN users u ON u.id = cr.requested_by
    WHERE cr.status = 'pending'
    ORDER BY cr.requested_at DESC
    LIMIT 20
  `) as unknown as Promise<PendingChangeRequest[]>
}

function coerceAgenda<T extends AgendaFunction>(a: T): T {
  return { ...a, pax: Number(a.pax) }
}

// ── Booking Manager ──────────────────────────────────────────────────────────

/** Assembles the Booking Manager board for `asOf` (defaults to today). Sections run in parallel. */
export async function getBookingDashboard(asOf: string = todayLocal()): Promise<BookingDashboard> {
  const [today, upcoming, openEnquiries, changeRequests, paymentsDue, exceptions] = await Promise.all([
    db.execute(sql`
      SELECT ${agendaColumns} ${agendaFrom}
      WHERE se.event_date = ${asOf}::date AND e.status IN ${OPERATIONAL}
      ORDER BY se.start_time, "venueName"
    `) as unknown as Promise<AgendaFunction[]>,

    db.execute(sql`
      SELECT ${agendaColumns} ${agendaFrom}
      WHERE se.event_date > ${asOf}::date AND se.event_date <= ${asOf}::date + 7
        AND e.status IN ${OPERATIONAL}
      ORDER BY se.event_date, se.start_time, "venueName"
    `) as unknown as Promise<AgendaFunction[]>,

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

    pendingChangeRequests(),

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
    openEnquiries: openEnquiries.map((e) => ({ ...e, idleDays: Number(e.idleDays), stale: Boolean(e.stale) })),
    approvals: { exceptions, changeRequests, total: exceptions.length + changeRequests.length },
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

// ── Banquet Manager ──────────────────────────────────────────────────────────

export type AgendaFunctionWithMenu = AgendaFunction & { tierName: string | null; menuComplete: boolean | null }

export type MenuGap = {
  subEventId: string
  eventId: string
  eventCode: string
  guestName: string
  name: string
  eventDate: string
  tierName: string | null
}

export type BanquetDashboard = {
  asOf: string
  today: AgendaFunctionWithMenu[]
  upcoming: AgendaFunctionWithMenu[]
  changeRequests: PendingChangeRequest[]
  menuGaps: MenuGap[]
}

const agendaWithMenu = (dateCond: ReturnType<typeof sql>) => sql`
  SELECT ${agendaColumns}, m.tier_name AS "tierName", m.is_complete AS "menuComplete"
  ${agendaFrom}
  LEFT JOIN sub_event_menus m ON m.sub_event_id = se.id
  WHERE ${dateCond} AND e.status IN ${OPERATIONAL}
  ORDER BY se.event_date, se.start_time, "venueName"`

function coerceAgendaMenu(a: AgendaFunctionWithMenu): AgendaFunctionWithMenu {
  return { ...a, pax: Number(a.pax), menuComplete: a.menuComplete == null ? null : Boolean(a.menuComplete) }
}

/** The Banquet Manager board: the floor/kitchen view — day agendas with menu state, change
 *  requests they decide (FR-1.9), and functions whose menu still isn't locked. */
export async function getBanquetDashboard(asOf: string = todayLocal()): Promise<BanquetDashboard> {
  const [today, upcoming, changeRequests, menuGaps] = await Promise.all([
    db.execute(agendaWithMenu(sql`se.event_date = ${asOf}::date`)) as unknown as Promise<AgendaFunctionWithMenu[]>,
    db.execute(
      agendaWithMenu(sql`se.event_date > ${asOf}::date AND se.event_date <= ${asOf}::date + 7`),
    ) as unknown as Promise<AgendaFunctionWithMenu[]>,
    pendingChangeRequests(),
    // Upcoming functions whose menu is missing or still marked incomplete — the kitchen risk.
    db.execute(sql`
      SELECT se.id AS "subEventId", se.event_id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
             se.name, se.event_date::text AS "eventDate", m.tier_name AS "tierName"
      FROM sub_events se
      JOIN events e ON e.id = se.event_id
      LEFT JOIN sub_event_menus m ON m.sub_event_id = se.id
      WHERE se.event_date >= ${asOf}::date AND e.status IN ('confirmed','in_progress')
        AND (m.id IS NULL OR m.is_complete = false)
      ORDER BY se.event_date, se.start_time
      LIMIT 20
    `) as unknown as Promise<MenuGap[]>,
  ])
  return { asOf, today: today.map(coerceAgendaMenu), upcoming: upcoming.map(coerceAgendaMenu), changeRequests, menuGaps }
}

// ── Lodge Manager ────────────────────────────────────────────────────────────

export type RoomMovement = {
  allocId: string
  eventId: string
  code: string
  guestName: string
  roomNo: string
  unitName: string
  otherDate: string // arrivals: check-out; departures: check-in
}

export type Occupancy = { unitId: string; name: string; total: number; occupied: number; available: number }

export type AllocationGap = {
  eventId: string
  code: string
  guestName: string
  firstDate: string | null
  promised: number
  allocated: number
  shortfall: number
}

export type LodgeDashboard = {
  asOf: string
  arrivals: RoomMovement[]
  departures: RoomMovement[]
  occupancy: Occupancy[]
  awaitingAllocation: AllocationGap[]
  pendingRoomApprovals: ExceptionRow[]
}

const movementSelect = sql`
  a.id AS "allocId", a.event_id AS "eventId", e.code, e.guest_name AS "guestName",
  r.room_no AS "roomNo", u.name AS "unitName"`
const movementFrom = sql`
  FROM room_allocations a
  JOIN rooms r ON r.id = a.room_id
  JOIN lodging_units u ON u.id = r.unit_id
  JOIN events e ON e.id = a.event_id AND e.status <> 'cancelled'`

/** The Lodge Manager board: today's arrivals/departures, live occupancy per property, events
 *  whose promised rooms aren't fully allocated yet (FR-4.5), and 35+ approvals in flight. */
export async function getLodgeDashboard(asOf: string = todayLocal()): Promise<LodgeDashboard> {
  const [arrivals, departures, occupancy, awaitingAllocation, exceptions] = await Promise.all([
    db.execute(sql`
      SELECT ${movementSelect}, upper(a.stay)::text AS "otherDate"
      ${movementFrom}
      WHERE lower(a.stay) = ${asOf}::date
      ORDER BY u.name, r.room_no
    `) as unknown as Promise<RoomMovement[]>,
    db.execute(sql`
      SELECT ${movementSelect}, lower(a.stay)::text AS "otherDate"
      ${movementFrom}
      WHERE upper(a.stay) = ${asOf}::date
      ORDER BY u.name, r.room_no
    `) as unknown as Promise<RoomMovement[]>,
    db.execute(sql`
      SELECT u.id AS "unitId", u.name,
             count(r.id)::int AS total,
             count(a.id)::int AS occupied
      FROM lodging_units u
      LEFT JOIN rooms r ON r.unit_id = u.id AND r.is_active
      LEFT JOIN room_allocations a ON a.room_id = r.id AND a.stay @> ${asOf}::date
      GROUP BY u.id, u.name
      ORDER BY u.name
    `) as unknown as Promise<{ unitId: string; name: string; total: number; occupied: number }[]>,
    db.execute(sql`
      WITH req AS (SELECT event_id, sum(count)::int AS promised FROM room_requirements GROUP BY event_id),
           alloc AS (SELECT event_id, count(*)::int AS allocated FROM room_allocations GROUP BY event_id)
      SELECT e.id AS "eventId", e.code, e.guest_name AS "guestName", e.first_date::text AS "firstDate",
             COALESCE(req.promised, 0) AS promised, COALESCE(alloc.allocated, 0) AS allocated
      FROM events e
      LEFT JOIN req ON req.event_id = e.id
      LEFT JOIN alloc ON alloc.event_id = e.id
      WHERE e.status IN ('confirmed','in_progress','completed')
        AND COALESCE(req.promised, 0) > COALESCE(alloc.allocated, 0)
      ORDER BY e.first_date NULLS LAST, e.code
    `) as unknown as Promise<Omit<AllocationGap, 'shortfall'>[]>,
    listExceptions({ status: 'pending' }),
  ])
  return {
    asOf,
    arrivals,
    departures,
    occupancy: occupancy.map((o) => {
      const total = Number(o.total)
      const occupied = Number(o.occupied)
      return { unitId: o.unitId, name: o.name, total, occupied, available: total - occupied }
    }),
    awaitingAllocation: awaitingAllocation.map((g) => {
      const promised = Number(g.promised)
      const allocated = Number(g.allocated)
      return { ...g, promised, allocated, shortfall: promised - allocated }
    }),
    pendingRoomApprovals: exceptions.filter((x) => x.kind === 'room_allocation_35plus'),
  }
}

// ── Maintenance ──────────────────────────────────────────────────────────────

export type MaintenanceEventRow = {
  id: string
  code: string
  guestName: string
  status: string
  firstDate: string | null
  entryCount: number
  totalPaise: number
  closed: boolean
}

export type MaintenanceDashboard = { asOf: string; events: MaintenanceEventRow[] }

/** The Maintenance board: every event it may log against — In Progress / Completed (FR-5.1) —
 *  with its running total and whether the section is closed (a lock-checklist gate, FR-5.2). */
export async function getMaintenanceDashboard(asOf: string = todayLocal()): Promise<MaintenanceDashboard> {
  const events = (await db.execute(sql`
    SELECT e.id, e.code, e.guest_name AS "guestName", e.status::text AS status, e.first_date::text AS "firstDate",
           (SELECT count(*)::int FROM maintenance_entries m WHERE m.event_id = e.id) AS "entryCount",
           COALESCE((SELECT sum(amount_paise) FROM maintenance_entries m WHERE m.event_id = e.id), 0) AS "totalPaise",
           EXISTS (SELECT 1 FROM lock_signoffs s WHERE s.event_id = e.id AND s.designation = 'maintenance') AS closed
    FROM events e
    WHERE e.status IN ('in_progress','completed')
    ORDER BY (e.status = 'in_progress') DESC, e.first_date NULLS LAST, e.code
  `)) as unknown as MaintenanceEventRow[]
  return {
    asOf,
    events: events.map((e) => ({
      ...e,
      entryCount: Number(e.entryCount),
      totalPaise: Number(e.totalPaise),
      closed: Boolean(e.closed),
    })),
  }
}

// ── Role dispatch ────────────────────────────────────────────────────────────

// ── Chef ─────────────────────────────────────────────────────────────────────

export type ChefRequestRow = {
  id: string
  description: string
  status: string
  chargePaise: number | null
  eventCode: string
  guestName: string
  subEventName: string
  eventDate: string
  pax: number
  requestedByName: string
}

export type ChefDashboard = {
  asOf: string
  toPrice: ChefRequestRow[]
  today: AgendaFunctionWithMenu[]
  upcoming: AgendaFunctionWithMenu[]
  menuGaps: MenuGap[]
}

/** The Chef's board: delicacy requests waiting on a price, and what the kitchen cooks next. */
export async function getChefDashboard(asOf: string = todayLocal()): Promise<ChefDashboard> {
  const [toPrice, today, upcoming, menuGaps] = await Promise.all([
    db.execute(sql`
      SELECT r.id, r.description, r.status, r.charge_paise AS "chargePaise",
             e.code AS "eventCode", e.guest_name AS "guestName",
             se.name AS "subEventName", se.event_date::text AS "eventDate", se.pax,
             u.full_name AS "requestedByName"
      FROM chef_requests r
      JOIN sub_events se ON se.id = r.sub_event_id
      JOIN events e ON e.id = se.event_id
      JOIN users u ON u.id = r.requested_by
      WHERE r.status = 'pending'
      ORDER BY r.requested_at
    `) as unknown as Promise<ChefRequestRow[]>,
    db.execute(agendaWithMenu(sql`se.event_date = ${asOf}::date`)) as unknown as Promise<AgendaFunctionWithMenu[]>,
    db.execute(
      agendaWithMenu(sql`se.event_date > ${asOf}::date AND se.event_date <= ${asOf}::date + 7`),
    ) as unknown as Promise<AgendaFunctionWithMenu[]>,
    db.execute(sql`
      SELECT se.id AS "subEventId", se.event_id AS "eventId", e.code AS "eventCode", e.guest_name AS "guestName",
             se.name, se.event_date::text AS "eventDate", m.tier_name AS "tierName"
      FROM sub_events se
      JOIN events e ON e.id = se.event_id
      LEFT JOIN sub_event_menus m ON m.sub_event_id = se.id
      WHERE se.event_date >= ${asOf}::date AND e.status IN ('confirmed','in_progress')
        AND (m.id IS NULL OR m.is_complete = false)
      ORDER BY se.event_date, se.start_time
      LIMIT 20
    `) as unknown as Promise<MenuGap[]>,
  ])
  return {
    asOf,
    toPrice: toPrice.map((r) => ({ ...r, pax: Number(r.pax), chargePaise: r.chargePaise == null ? null : Number(r.chargePaise) })),
    today: today.map(coerceAgendaMenu),
    upcoming: upcoming.map(coerceAgendaMenu),
    menuGaps,
  }
}

// ── Higher Authority ─────────────────────────────────────────────────────────

export type HighValueEvent = {
  id: string
  code: string
  guestName: string
  eventType: string
  firstDate: string | null
  proposalTotalPaise: number
}

export type AuthorityDashboard = {
  asOf: string
  exceptions: ExceptionRow[]
  byKind: { kind: string; n: number }[]
  paymentsDue: PaymentDue[]
  highValue: HighValueEvent[]
  upcoming: AgendaFunction[]
}

/** The Authority's board: what needs a decision, what money is at risk, what's biggest. */
export async function getAuthorityDashboard(asOf: string = todayLocal()): Promise<AuthorityDashboard> {
  const [exceptions, booking, highValue] = await Promise.all([
    listExceptions({ status: 'pending' }),
    getBookingDashboard(asOf),
    db.execute(sql`
      SELECT id, code, guest_name AS "guestName", event_type AS "eventType",
             first_date::text AS "firstDate", proposal_total_paise AS "proposalTotalPaise"
      FROM events
      WHERE status IN ('confirmed','in_progress')
      ORDER BY proposal_total_paise DESC
      LIMIT 5
    `) as unknown as Promise<HighValueEvent[]>,
  ])

  const byKind = [...exceptions.reduce((m, x) => m.set(x.kind, (m.get(x.kind) ?? 0) + 1), new Map<string, number>())]
    .map(([kind, n]) => ({ kind, n }))
    .sort((a, b) => b.n - a.n)

  return {
    asOf,
    exceptions,
    byKind,
    paymentsDue: booking.paymentsDue,
    highValue: highValue.map((e) => ({ ...e, proposalTotalPaise: Number(e.proposalTotalPaise) })),
    upcoming: booking.upcoming,
  }
}

// ── Auditor / Admin ──────────────────────────────────────────────────────────

export type AuditEntry = {
  seq: number
  entity: string
  action: string
  field: string | null
  oldValue: string | null
  newValue: string | null
  userName: string
  roleName: string
  at: string
  eventCode: string | null
}

export type AuditorDashboard = {
  asOf: string
  statusCounts: { status: string; n: number }[]
  pendingApprovals: number
  userCount: number
  roleCount: number
  recent: AuditEntry[]
}

/** The Auditor's board: the system at a glance, and the newest entries in the trail. */
export async function getAuditorDashboard(asOf: string = todayLocal()): Promise<AuditorDashboard> {
  const [statusCounts, approvals, people, recent] = await Promise.all([
    db.execute(sql`
      SELECT status::text AS status, count(*)::int AS n FROM events GROUP BY status ORDER BY status
    `) as unknown as Promise<{ status: string; n: number }[]>,
    db.execute(sql`
      SELECT (SELECT count(*) FROM exceptions WHERE status = 'pending')
           + (SELECT count(*) FROM change_requests WHERE status = 'pending') AS n
    `) as unknown as Promise<{ n: number }[]>,
    db.execute(sql`
      SELECT (SELECT count(*) FROM users WHERE is_active)::int AS users,
             (SELECT count(*) FROM roles)::int AS roles
    `) as unknown as Promise<{ users: number; roles: number }[]>,
    // The trail is append-only (CLAUDE.md rule 5); newest first is the useful view.
    db.execute(sql`
      SELECT a.seq, a.entity, a.action, a.field, a.old_value AS "oldValue", a.new_value AS "newValue",
             u.full_name AS "userName", a.role_name AS "roleName", a.at, e.code AS "eventCode"
      FROM audit_log a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN events e ON e.id = a.event_id
      ORDER BY a.seq DESC
      LIMIT 15
    `) as unknown as Promise<AuditEntry[]>,
  ])
  return {
    asOf,
    statusCounts: statusCounts.map((s) => ({ ...s, n: Number(s.n) })),
    pendingApprovals: Number(approvals[0]?.n ?? 0),
    userCount: Number(people[0]?.users ?? 0),
    roleCount: Number(people[0]?.roles ?? 0),
    recent: recent.map((r) => ({ ...r, seq: Number(r.seq) })),
  }
}

// ── Role dispatch ────────────────────────────────────────────────────────────

export type RoleDashboard =
  | ({ kind: 'booking' } & BookingDashboard)
  | ({ kind: 'banquet' } & BanquetDashboard)
  | ({ kind: 'lodge' } & LodgeDashboard)
  | ({ kind: 'maintenance' } & MaintenanceDashboard)
  | ({ kind: 'chef' } & ChefDashboard)
  | ({ kind: 'authority' } & AuthorityDashboard)
  | ({ kind: 'auditor' } & AuditorDashboard)

/**
 * The board for a role — every role has its own. The fallback is the Booking board, but it is
 * only reached by a role that doesn't exist yet: all seven are matched explicitly, deliberately,
 * so a new role can never silently inherit a board full of data it cannot act on.
 */
export async function getDashboardForRole(roleName: string, asOf: string = todayLocal()): Promise<RoleDashboard> {
  switch (roleName) {
    case 'banquet_manager':
      return { kind: 'banquet', ...(await getBanquetDashboard(asOf)) }
    case 'lodge_manager':
      return { kind: 'lodge', ...(await getLodgeDashboard(asOf)) }
    case 'maintenance':
      return { kind: 'maintenance', ...(await getMaintenanceDashboard(asOf)) }
    case 'chef':
      return { kind: 'chef', ...(await getChefDashboard(asOf)) }
    case 'higher_authority':
      return { kind: 'authority', ...(await getAuthorityDashboard(asOf)) }
    case 'auditor':
      return { kind: 'auditor', ...(await getAuditorDashboard(asOf)) }
    case 'booking_manager':
    default:
      return { kind: 'booking', ...(await getBookingDashboard(asOf)) }
  }
}
