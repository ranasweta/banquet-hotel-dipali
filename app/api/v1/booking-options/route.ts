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
    db
      .selectDistinct({ roomType: schema.rooms.roomType })
      .from(schema.rooms)
      .orderBy(asc(schema.rooms.roomType)),
  ])

  const bundles = (bundleRows as unknown as { id: string; name: string; members: string }[]).map((b) => ({
    id: b.id,
    name: b.name,
    members: b.members,
  }))

  return ok({
    eventTypes,
    venues,
    bundles,
    roomTypes: roomTypeRows.map((r) => r.roomType),
  })
})
