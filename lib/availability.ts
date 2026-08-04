import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { crossesMidnight, nextDay, occupancyParts } from '@/lib/occupancy'
import { advanceShortfallByEvent } from '@/lib/payment-schedule'

/**
 * Venue availability under the time-overlap model (BR-C1, amended). A venue is free for a
 * window unless an existing booking on that venue overlaps it. Bundles expand to their
 * member venues; a window whose end is at or before its start runs past midnight.
 *
 * The database's GiST exclusion on venue_bookings is the real guarantee at write time
 * (M3 confirm); this read-side check drives the wizard's inline feedback (FR-1.4) and is
 * re-run inside the confirm transaction. The occupancy maths lives in lib/occupancy.
 */

export type AvailabilityQuery = {
  date: string // YYYY-MM-DD
  startTime: string // HH:MM or HH:MM:SS
  endTime: string
  venueId?: string
  bundleId?: string
  /** Ignore this event's own bookings when re-checking during an edit. */
  excludeEventId?: string
}

export type Conflict = {
  venueId: string
  venueName: string
  eventId: string
  eventCode: string
  guestName: string
  subEventName: string
  starts: string
  ends: string
}

export type AvailabilityResult = {
  available: boolean
  crossesMidnight: boolean
  venueIds: string[]
  conflicts: Conflict[]
}

/** The concrete venue ids a booking touches: a bundle's members, or the single venue. */
export async function resolveVenueIds(input: {
  venueId?: string
  bundleId?: string
}): Promise<string[]> {
  if (input.bundleId) {
    const members = await db
      .select({ venueId: schema.venueBundleMembers.venueId })
      .from(schema.venueBundleMembers)
      .where(eq(schema.venueBundleMembers.bundleId, input.bundleId))
    return members.map((m) => m.venueId)
  }
  if (input.venueId) return [input.venueId]
  return []
}

export async function checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
  const venueIds = await resolveVenueIds(query)
  const crosses = crossesMidnight(query.startTime, query.endTime)
  if (venueIds.length === 0) {
    return { available: false, crossesMidnight: crosses, venueIds, conflicts: [] }
  }

  const { lowerDate, lowerTime, upperDate, upperTime } = occupancyParts(
    query.date,
    query.startTime,
    query.endTime,
  )
  // Build an IN-list fragment rather than ANY(array): Drizzle's sql template serializes a
  // JS array as one scalar param, which Postgres rejects as a malformed array literal.
  const venueList = sql.join(
    venueIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const exclude = query.excludeEventId ?? null

  const rows = (await db.execute(sql`
    SELECT vb.venue_id       AS "venueId",
           v.name            AS "venueName",
           vb.event_id       AS "eventId",
           e.code            AS "eventCode",
           e.guest_name      AS "guestName",
           se.name           AS "subEventName",
           to_char(lower(vb.occupancy), 'YYYY-MM-DD"T"HH24:MI') AS "starts",
           to_char(upper(vb.occupancy), 'YYYY-MM-DD"T"HH24:MI') AS "ends"
    FROM venue_bookings vb
    JOIN venues v      ON v.id  = vb.venue_id
    JOIN events e      ON e.id  = vb.event_id
    JOIN sub_events se ON se.id = vb.sub_event_id
    WHERE vb.venue_id IN (${venueList})
      AND vb.occupancy && tsrange(
            (${lowerDate}::date + ${lowerTime}::time),
            (${upperDate}::date + ${upperTime}::time), '[)')
      AND (${exclude}::uuid IS NULL OR vb.event_id <> ${exclude}::uuid)
    ORDER BY lower(vb.occupancy)
  `)) as unknown as Conflict[]

  return {
    available: rows.length === 0,
    crossesMidnight: crosses,
    venueIds,
    conflicts: rows,
  }
}

/**
 * How many still-open enquiries also target one of these venues on this date — a hint
 * shown at booking time (FR-1.2). Enquiries hold no venue_bookings (those appear only at
 * confirm), so this counts enquiry-status events with a sub-event on the venue that day.
 */
export async function countOpenEnquiries(venueIds: string[], date: string): Promise<number> {
  if (venueIds.length === 0) return 0
  const venueList = sql.join(
    venueIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const rows = (await db.execute(sql`
    SELECT count(DISTINCT e.id)::int AS n
    FROM sub_events se
    JOIN events e ON e.id = se.event_id
    WHERE e.status = 'enquiry'
      AND se.event_date = ${date}::date
      AND se.venue_id IN (${venueList})
  `)) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

export type CalendarBooking = {
  venueId: string
  venueName: string
  propertyName: string
  venueKind: string
  eventId: string
  eventCode: string
  guestName: string
  eventType: string
  subEventId: string
  subEventName: string
  status: string
  starts: string // ISO 'YYYY-MM-DDTHH:MM'
  ends: string
  /**
   * Still owed on the 25% advance — 0 for a booking paid up. Above zero the board marks the
   * date **Downpayment due**: the dates are genuinely held, but only partly paid for.
   */
  advanceShortfallPaise: number
  /** The guest's primary number, carried ONLY for a short booking — see below. */
  contactPhone: string | null
}

/**
 * Confirmed-and-beyond venue bookings overlapping [from, to] (FR-2.5: the board carries
 * locked-in deals only — enquiries never appear). Cross-midnight bookings surface on both
 * days they touch, letting the UI show a "carryover" tail on the following morning.
 *
 * A booking confirmed on a part payment holds its venue like any other (lib/confirm.ts) but
 * carries a shortfall, and the board is where that has to show: when a second guest wants the
 * same date, the Booking Manager sees the marker, and the guest's number is right there so the
 * call to the GM can happen with the details in hand (client's lead, 4 Aug 2026).
 *
 * The number rides along only for bookings that are actually short. Everyone with
 * `calendar: view` can open this board — the Banquet Manager among them — and there is no
 * reason for a paid-up guest's phone number to travel to a screen that has no use for it.
 */
export async function getCalendarBookings(from: string, to: string): Promise<CalendarBooking[]> {
  // `to` is inclusive of the whole day, so overlap against [from 00:00, to+1 00:00).
  const toExclusive = nextDay(to)
  const rows = (await db.execute(sql`
    SELECT vb.venue_id   AS "venueId",
           v.name        AS "venueName",
           p.name        AS "propertyName",
           v.kind        AS "venueKind",
           e.id          AS "eventId",
           e.code        AS "eventCode",
           e.guest_name  AS "guestName",
           e.event_type  AS "eventType",
           se.id         AS "subEventId",
           se.name       AS "subEventName",
           e.status::text AS "status",
           to_char(lower(vb.occupancy), 'YYYY-MM-DD"T"HH24:MI') AS "starts",
           to_char(upper(vb.occupancy), 'YYYY-MM-DD"T"HH24:MI') AS "ends"
    FROM venue_bookings vb
    JOIN venues v      ON v.id  = vb.venue_id
    JOIN properties p  ON p.id  = v.property_id
    JOIN events e      ON e.id  = vb.event_id
    JOIN sub_events se ON se.id = vb.sub_event_id
    WHERE e.status IN ('confirmed','in_progress','completed','locked','billed','closed')
      AND vb.occupancy && tsrange(${from}::date::timestamp, ${toExclusive}::date::timestamp, '[)')
    ORDER BY p.name, v.name, lower(vb.occupancy)
  `)) as unknown as CalendarBooking[]

  const short = await advanceShortfallByEvent([...new Set(rows.map((r) => r.eventId))])
  const phones = await primaryContacts([...short.keys()])
  return rows.map((r) => ({
    ...r,
    advanceShortfallPaise: short.get(r.eventId) ?? 0,
    contactPhone: phones.get(r.eventId) ?? null,
  }))
}

/** One number per event — the contact labelled primary where there is one. */
async function primaryContacts(eventIds: string[]): Promise<Map<string, string>> {
  if (eventIds.length === 0) return new Map()
  const ids = sql.join(
    eventIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (c.event_id) c.event_id AS "eventId", c.phone
    FROM event_contacts c
    WHERE c.event_id IN (${ids})
    ORDER BY c.event_id, (c.label = 'primary') DESC NULLS LAST, c.phone
  `)) as unknown as { eventId: string; phone: string }[]
  return new Map(rows.map((r) => [r.eventId, r.phone]))
}

export type VenueAvailability = {
  venues: { id: string; name: string; propertyName: string; kind: string; capacityMin: number; capacityMax: number; available: boolean }[]
  bundles: { id: string; name: string; members: string; available: boolean }[]
}

/**
 * Every active venue and bundle flagged free / booked for a given date-time window
 * (BR-C1). Drives the wizard's "pick date & time first, then only the free venues show"
 * flow. A venue is booked if any confirmed booking overlaps the window; a bundle is free
 * only when all its member venues are. Enquiries hold no bookings, so they never hide a
 * venue — first confirmation wins.
 */
export async function listVenueAvailability(
  date: string,
  startTime: string,
  endTime: string,
): Promise<VenueAvailability> {
  const { lowerDate, lowerTime, upperDate, upperTime } = occupancyParts(date, startTime, endTime)
  const busyRows = (await db.execute(sql`
    SELECT DISTINCT vb.venue_id AS "venueId"
    FROM venue_bookings vb
    WHERE vb.occupancy && tsrange(
      (${lowerDate}::date + ${lowerTime}::time),
      (${upperDate}::date + ${upperTime}::time), '[)')
  `)) as unknown as { venueId: string }[]
  const busy = new Set(busyRows.map((r) => r.venueId))

  // Only venues that carry a price of their own are offered on their own. Diamond Hall,
  // Golden Hall, Gulmohar Lawn and Middle Lawn are priced by the proposal solely as their
  // bundle, so they stay bundle members (and keep their calendar occupancy) but never appear
  // as a standalone choice — otherwise a booking manager picks one and dead-ends at confirm
  // on the missing-rate gate (BR-R1). The bundles themselves are listed below and are priced.
  const venues = (await db.execute(sql`
    SELECT v.id, v.name, v.kind, p.name AS "propertyName",
           v.capacity_min AS "capacityMin", v.capacity_max AS "capacityMax"
    FROM venues v
    JOIN properties p ON p.id = v.property_id
    WHERE v.is_active
      AND EXISTS (SELECT 1 FROM venue_rate_cards r WHERE r.venue_id = v.id)
    ORDER BY p.name, v.name
  `)) as unknown as {
    id: string; name: string; kind: string; propertyName: string; capacityMin: number; capacityMax: number
  }[]

  const bundleRows = (await db.execute(sql`
    SELECT b.id, b.name,
           string_agg(v.name, ' + ' ORDER BY v.name) AS members,
           array_agg(m.venue_id::text) AS "memberIds"
    FROM venue_bundles b
    JOIN venue_bundle_members m ON m.bundle_id = b.id
    JOIN venues v ON v.id = m.venue_id
    GROUP BY b.id, b.name ORDER BY b.name
  `)) as unknown as { id: string; name: string; members: string; memberIds: string[] }[]

  return {
    venues: venues.map((v) => ({ ...v, available: !busy.has(v.id) })),
    bundles: bundleRows.map((b) => ({ id: b.id, name: b.name, members: b.members, available: b.memberIds.every((id) => !busy.has(id)) })),
  }
}

/** All active venues grouped for the board's rows, ordered by property then venue. */
export async function listVenuesForBoard(): Promise<
  { id: string; name: string; kind: string; propertyName: string }[]
> {
  const rows = await db
    .select({
      id: schema.venues.id,
      name: schema.venues.name,
      kind: schema.venues.kind,
      propertyName: schema.properties.name,
    })
    .from(schema.venues)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.venues.propertyId))
    .where(eq(schema.venues.isActive, true))
    .orderBy(schema.properties.name, schema.venues.name)
  return rows
}
