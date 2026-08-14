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
  awaitingSignoff: SignoffRow[]
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
export async function getBanquetDashboard(
  asOf: string = todayLocal(),
  scopeManagerId?: string | null,
): Promise<BanquetDashboard> {
  const scope = scopeManagerId ?? null
  const [today, upcoming, changeRequests, menuGaps, awaitingSignoff] = await Promise.all([
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
    // The properties predicate matches lib/daysheet.ts: a function belongs to a manager
    // through its venue OR, when the function took a bundle, through the bundle's members.
    db.execute(
      awaitingSignoffQuery(
        'banquet_manager',
        sql`(${scope}::uuid IS NULL OR EXISTS (
               SELECT 1 FROM sub_events se
                WHERE se.event_id = e.id
                  AND (EXISTS (SELECT 1 FROM venues sv JOIN properties sp ON sp.id = sv.property_id
                                WHERE sv.id = se.venue_id AND sp.banquet_manager_id = ${scope}::uuid)
                    OR EXISTS (SELECT 1 FROM venue_bundle_members vbm
                                 JOIN venues sv ON sv.id = vbm.venue_id
                                 JOIN properties sp ON sp.id = sv.property_id
                                WHERE vbm.bundle_id = se.bundle_id AND sp.banquet_manager_id = ${scope}::uuid))))`,
      ),
    ) as unknown as Promise<SignoffRow[]>,
  ])
  return {
    asOf,
    today: today.map(coerceAgendaMenu),
    upcoming: upcoming.map(coerceAgendaMenu),
    changeRequests,
    menuGaps,
    awaitingSignoff,
  }
}

// ── Lodge Manager ────────────────────────────────────────────────────────────

/**
 * A booking checking in or out today.
 *
 * Read from `room_requirements`, which IS the booking since rooms went bulk (client, 21 Jul
 * 2026; CLAUDE.md rule 9). It used to read `room_allocations` — a table nothing has written
 * since, so every tile on this board read zero for weeks while the lodge was full.
 *
 * There is no room number to show, and that is not a gap: a booking reserves a lodge, a
 * category and a count, and reception picks the actual rooms on the day.
 */
export type RoomMovement = {
  reqId: string
  eventId: string
  code: string
  guestName: string
  unitName: string
  roomType: string
  count: number
  otherDate: string // arrivals: check-out; departures: check-in
}

export type Occupancy = { unitId: string; name: string; total: number; occupied: number; available: number }

/** An event waiting on this role's lock sign-off — the checklist line only they can clear. */
export type SignoffRow = {
  eventId: string
  code: string
  guestName: string
  lastDate: string | null
  status: string
}

export type LodgeDashboard = {
  asOf: string
  arrivals: RoomMovement[]
  departures: RoomMovement[]
  occupancy: Occupancy[]
  awaitingSignoff: SignoffRow[]
  pendingRoomApprovals: ExceptionRow[]
}

const movementSelect = sql`
  rr.id AS "reqId", rr.event_id AS "eventId", e.code, e.guest_name AS "guestName",
  u.name AS "unitName", rr.room_type AS "roomType", rr.count`
const movementFrom = sql`
  FROM room_requirements rr
  JOIN lodging_units u ON u.id = rr.unit_id
  JOIN events e ON e.id = rr.event_id AND e.status IN ('confirmed','in_progress','completed','locked','billed','closed')`

/**
 * Events sitting in a state where a sign-off can be recorded, that this designation has not
 * signed. `lock_signoffs` is per event and per designation, and `lockChecklist` treats the
 * banquet line — and the lodge line on any booking with rooms — as blocking, so an event with
 * one outstanding can never be locked, invoiced or billed.
 *
 * Scoped to what the reader is responsible for, so the Palace manager is not asked to sign for
 * Regency. An event spanning several properties appears for each manager involved and the
 * first signature satisfies it, which matches the service: the sign-off belongs to the ROLE,
 * not to one person (`lib/lock.ts` checks `actor.roleName === designation`).
 */
function awaitingSignoffQuery(
  designation: 'banquet_manager' | 'lodge_manager',
  scope: ReturnType<typeof sql>,
) {
  return sql`
    SELECT e.id AS "eventId", e.code, e.guest_name AS "guestName", e.status::text AS status,
           (SELECT max(se.event_date)::text FROM sub_events se WHERE se.event_id = e.id) AS "lastDate"
    FROM events e
    WHERE e.status IN ('in_progress','completed')
      AND NOT EXISTS (
        SELECT 1 FROM lock_signoffs ls
         WHERE ls.event_id = e.id AND ls.designation = ${designation}::signoff_role)
      AND ${scope}
    ORDER BY 5 DESC NULLS LAST, e.code
    LIMIT 20
  `
}

/**
 * The Lodge Manager board: today's arrivals/departures, live occupancy per lodge, the events
 * waiting on their rooms sign-off, and 35+ approvals in flight.
 *
 * Scoped to the manager's own lodge (mig 0013). A null scope means every lodge, which is what
 * the Auditor gets; a Lodge Manager with no lodge set sees an empty board rather than an
 * error, because the home page is the wrong place to throw a configuration mistake.
 *
 * "Rooms to allocate" is gone with the table behind it. Rooms are booked in bulk and there is
 * no allocation step left to be behind on (rule 9) — the tile counted a shortfall against
 * `room_allocations`, so it read the entire promised count as outstanding, for ever.
 */
export async function getLodgeDashboard(
  asOf: string = todayLocal(),
  scopeUnitId?: string | null,
): Promise<LodgeDashboard> {
  const unitScope = scopeUnitId ?? null
  const [arrivals, departures, occupancy, awaitingSignoff, exceptions] = await Promise.all([
    db.execute(sql`
      SELECT ${movementSelect}, rr.check_out::text AS "otherDate"
      ${movementFrom}
      WHERE rr.check_in = ${asOf}::date
        AND (${unitScope}::uuid IS NULL OR rr.unit_id = ${unitScope}::uuid)
      ORDER BY u.name, rr.room_type
    `) as unknown as Promise<RoomMovement[]>,
    db.execute(sql`
      SELECT ${movementSelect}, rr.check_in::text AS "otherDate"
      ${movementFrom}
      WHERE rr.check_out = ${asOf}::date
        AND (${unitScope}::uuid IS NULL OR rr.unit_id = ${unitScope}::uuid)
      ORDER BY u.name, rr.room_type
    `) as unknown as Promise<RoomMovement[]>,
    // Occupied is the SUM OF COUNTS held across today, not a count of assigned rooms — the
    // same arithmetic the lodging calendar uses, so the two boards cannot disagree.
    db.execute(sql`
      SELECT u.id AS "unitId", u.name,
             (SELECT count(*)::int FROM rooms r WHERE r.unit_id = u.id AND r.is_active) AS total,
             COALESCE((
               SELECT sum(rr.count)::int
               FROM room_requirements rr
               JOIN events e ON e.id = rr.event_id
              WHERE rr.unit_id = u.id
                AND e.status IN ('confirmed','in_progress','completed','locked','billed','closed')
                AND ${asOf}::date >= rr.check_in AND ${asOf}::date < rr.check_out
             ), 0) AS occupied
      FROM lodging_units u
      WHERE (${unitScope}::uuid IS NULL OR u.id = ${unitScope}::uuid)
      ORDER BY u.name
    `) as unknown as Promise<{ unitId: string; name: string; total: number; occupied: number }[]>,
    db.execute(
      awaitingSignoffQuery(
        'lodge_manager',
        // Only bookings that actually took rooms: the checklist waives the lodge line when
        // there are none (`!hasRooms || lodge` in lib/lock.ts).
        sql`EXISTS (SELECT 1 FROM room_requirements rr WHERE rr.event_id = e.id
                     AND (${unitScope}::uuid IS NULL OR rr.unit_id = ${unitScope}::uuid))`,
      ),
    ) as unknown as Promise<SignoffRow[]>,
    listExceptions({ status: 'pending' }),
  ])
  return {
    asOf,
    arrivals: arrivals.map((r) => ({ ...r, count: Number(r.count) })),
    departures: departures.map((r) => ({ ...r, count: Number(r.count) })),
    occupancy: occupancy.map((o) => {
      const total = Number(o.total)
      const occupied = Number(o.occupied)
      // Clamped: the inventory cap makes over-booking impossible, but a lodge whose rooms were
      // deactivated after a booking was taken would otherwise show negative rooms free.
      return { unitId: o.unitId, name: o.name, total, occupied, available: Math.max(0, total - occupied) }
    }),
    awaitingSignoff,
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

// ── Utensils ─────────────────────────────────────────────────────────────────

export type UtensilEventRow = {
  id: string
  code: string
  guestName: string
  status: string
  firstDate: string | null
  entryCount: number
  plates: number
  totalPaise: number
  closed: boolean
}

export type UtensilDashboard = { asOf: string; events: UtensilEventRow[] }

/**
 * The Utensil Manager's board (client, 15 Aug 2026): every event he may log plates against —
 * In Progress / Completed, the same window Maintenance works in — with the plate count, what
 * it comes to, and whether he has closed the log. Nothing on an open log is charged yet.
 */
export async function getUtensilDashboard(asOf: string = todayLocal()): Promise<UtensilDashboard> {
  const events = (await db.execute(sql`
    SELECT e.id, e.code, e.guest_name AS "guestName", e.status::text AS status,
           (SELECT min(se.event_date)::text FROM sub_events se WHERE se.event_id = e.id) AS "firstDate",
           (SELECT count(*)::int FROM extra_plate_entries p WHERE p.event_id = e.id) AS "entryCount",
           COALESCE((SELECT sum(p.plates) FROM extra_plate_entries p WHERE p.event_id = e.id), 0) AS plates,
           COALESCE((SELECT sum(p.amount_paise) FROM extra_plate_entries p WHERE p.event_id = e.id), 0) AS "totalPaise",
           EXISTS (SELECT 1 FROM utensil_extras x WHERE x.event_id = e.id AND x.closed_at IS NOT NULL) AS closed
    FROM events e
    WHERE e.status IN ('in_progress','completed')
    ORDER BY (e.status = 'in_progress') DESC, "firstDate" NULLS LAST, e.code
  `)) as unknown as UtensilEventRow[]
  return {
    asOf,
    events: events.map((e) => ({
      ...e,
      entryCount: Number(e.entryCount),
      plates: Number(e.plates),
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
  | ({ kind: 'utensils' } & UtensilDashboard)

/**
 * The board for a role — every role has its own. The fallback is the Booking board, but it is
 * only reached by a role that doesn't exist yet: all eight are matched explicitly, deliberately,
 * so a new role can never silently inherit a board full of data it cannot act on.
 */
export async function getDashboardForRole(
  roleName: string,
  asOf: string = todayLocal(),
  // Who is reading, for the two boards that are scoped to a unit. Optional so a caller that
  // only wants the shape — the dispatch tests — need not build a user.
  reader?: { id: string; lodgingUnitId: string | null },
): Promise<RoleDashboard> {
  switch (roleName) {
    case 'banquet_manager':
      return { kind: 'banquet', ...(await getBanquetDashboard(asOf, reader?.id ?? null)) }
    case 'lodge_manager':
      return { kind: 'lodge', ...(await getLodgeDashboard(asOf, reader?.lodgingUnitId ?? null)) }
    case 'maintenance':
      return { kind: 'maintenance', ...(await getMaintenanceDashboard(asOf)) }
    case 'chef':
      return { kind: 'chef', ...(await getChefDashboard(asOf)) }
    case 'utensil_manager':
      return { kind: 'utensils', ...(await getUtensilDashboard(asOf)) }
    case 'higher_authority':
      return { kind: 'authority', ...(await getAuthorityDashboard(asOf)) }
    case 'auditor':
      return { kind: 'auditor', ...(await getAuditorDashboard(asOf)) }
    case 'booking_manager':
    default:
      return { kind: 'booking', ...(await getBookingDashboard(asOf)) }
  }
}
