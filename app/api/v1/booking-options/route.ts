import { asc, sql } from 'drizzle-orm'
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
    // Every active venue, each flagged `priceable`. The list stays complete because callers
    // also use it to resolve a venue's NAME and capacity for functions already booked — but
    // anything that lets a user PICK a venue must offer only the priceable ones. Diamond,
    // Golden, Gulmohar and Middle are priced by the proposal solely as their bundle, so
    // picking one alone dead-ends at the missing-rate gate (BR-R1).
    db.execute(sql`
      SELECT v.id, v.name, v.kind, p.name AS "propertyName",
             v.capacity_min AS "capacityMin", v.capacity_max AS "capacityMax",
             EXISTS (SELECT 1 FROM venue_rate_cards r WHERE r.venue_id = v.id) AS priceable
      FROM venues v
      JOIN properties p ON p.id = v.property_id
      WHERE v.is_active
      ORDER BY p.name, v.name
    `),
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
      -- Per lodge: Regency deluxe is Rs. 4,500 where Palace deluxe is Rs. 5,000, so a
      -- single min() across lodges would under-quote the guest (rates differ per lodge).
      SELECT unit_id AS "unitId", room_type AS "roomType", min(rack_rate_paise)::bigint AS "rackRatePaise"
      FROM rooms WHERE is_active
      GROUP BY unit_id, room_type
      ORDER BY room_type
    `),
  ])

  const bundles = (bundleRows as unknown as { id: string; name: string; members: string }[]).map((b) => ({
    id: b.id,
    name: b.name,
    members: b.members,
  }))

  const roomRates = (roomTypeRows as unknown as { unitId: string; roomType: string; rackRatePaise: number }[]).map((r) => ({
    unitId: r.unitId,
    roomType: r.roomType,
    rackRatePaise: Number(r.rackRatePaise),
  }))

  // Rooms are booked as lodge + category on the proposal (21 Jul 2026), so the wizard needs
  // the lodges too. Only units that actually have rooms — an empty lodge cannot be booked.
  const lodgingUnits = (await db.execute(sql`
    SELECT u.id, u.name
    FROM lodging_units u
    WHERE EXISTS (SELECT 1 FROM rooms r WHERE r.unit_id = u.id AND r.is_active)
    ORDER BY u.name
  `)) as unknown as { id: string; name: string }[]

  return ok({
    eventTypes,
    venues,
    bundles,
    roomTypes: [...new Set(roomRates.map((r) => r.roomType))],
    roomRates,
    lodgingUnits,
  })
})
