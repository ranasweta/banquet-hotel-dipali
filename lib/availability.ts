import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { crossesMidnight, nextDay, occupancyParts } from '@/lib/occupancy'

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
}

/**
 * Confirmed-and-beyond venue bookings overlapping [from, to] (FR-2.5: the board carries
 * locked-in deals only — enquiries never appear). Cross-midnight bookings surface on both
 * days they touch, letting the UI show a "carryover" tail on the following morning.
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
  return rows
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
