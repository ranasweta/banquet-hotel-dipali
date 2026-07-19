import { asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'

/** GET /booking-options — event types, venues, bundles and room types for the wizard. */
export const GET = route(async () => {
  await requirePermission('bookings', 'view')

  const [eventTypes, venues, bundleRows, roomTypeRows] = await Promise.all([
    db
      .select({
        code: schema.eventTypes.code,
        displayName: schema.eventTypes.displayName,
        contactNumbers: schema.eventTypes.contactNumbers,
        isWedding: schema.eventTypes.isWedding,
      })
      .from(schema.eventTypes)
      .orderBy(asc(schema.eventTypes.displayName)),
    db
      .select({
        id: schema.venues.id,
        name: schema.venues.name,
        kind: schema.venues.kind,
        propertyName: schema.properties.name,
        capacityMin: schema.venues.capacityMin,
        capacityMax: schema.venues.capacityMax,
      })
      .from(schema.venues)
      .innerJoin(schema.properties, eq(schema.properties.id, schema.venues.propertyId))
      .where(eq(schema.venues.isActive, true))
      .orderBy(asc(schema.properties.name), asc(schema.venues.name)),
    db.execute(sql`
      SELECT b.id, b.name,
             string_agg(v.name, ' + ' ORDER BY v.name) AS members
      FROM venue_bundles b
      JOIN venue_bundle_members m ON m.bundle_id = b.id
      JOIN venues v ON v.id = m.venue_id
      GROUP BY b.id, b.name
      ORDER BY b.name
    `),
    // Room type + the rack rate we price a requirement at. A requirement is only a promise
    // (type, count, dates) — the billable rate lands when the Lodge Manager allocates real
    // rooms — so the wizard prices it at the type's lowest rack rate as an estimate.
    db.execute(sql`
      SELECT room_type AS "roomType", min(rack_rate_paise)::bigint AS "rackRatePaise"
      FROM rooms WHERE is_active
      GROUP BY room_type
      ORDER BY room_type
    `),
  ])

  const bundles = (bundleRows as unknown as { id: string; name: string; members: string }[]).map((b) => ({
    id: b.id,
    name: b.name,
    members: b.members,
  }))

  const roomRates = (roomTypeRows as unknown as { roomType: string; rackRatePaise: number }[]).map((r) => ({
    roomType: r.roomType,
    rackRatePaise: Number(r.rackRatePaise),
  }))

  return ok({
    eventTypes,
    venues,
    bundles,
    roomTypes: roomRates.map((r) => r.roomType),
    roomRates,
  })
})
