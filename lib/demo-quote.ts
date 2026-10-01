import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'
import { percentOfPaise } from '@/lib/money'
import { ADVANCE_PCT } from '@/lib/payment-schedule'
import { priceProposal } from '@/lib/pricing'
import { roomGstBp, STANDARD_GST_BP, taxOf } from '@/lib/tax'

/**
 * The demo proposal (client's lead, 1 Oct 2026): a walk through the New-proposal steps for a
 * guest at the counter who is only asking, ending on a one-page summary. Too many enquiries
 * were being created as real proposals and cancelled later.
 *
 * Nothing is written — no event, no sub-event, no hold, no audit row — so nothing here can
 * clash, lock or need cancelling. Availability is deliberately not checked. Prices still come
 * from the real rate cards, tier prices and rack rates through the same rules a proposal uses
 * (one hall-hire per venue-day, the wedding surcharge, the room GST bands), so the figure
 * the guest sees is the figure a real proposal would show.
 */

export type DemoFunctionInput = {
  name: string
  eventDate: string
  startTime: string
  endTime: string
  venueId: string | null
  bundleId: string | null
  pax: number
  tierId: string
}
export type DemoRoomInput = { unitId: string; roomType: string; count: number; nights: number }

export type DemoQuote = {
  functions: {
    name: string
    eventDate: string
    startTime: string
    endTime: string
    venueName: string
    tierName: string
    pax: number
    venuePaise: number | null
    perPlatePaise: number
    foodPaise: number
  }[]
  rooms: { unitName: string; roomType: string; count: number; nights: number; ratePaise: number; amountPaise: number }[]
  functionsPaise: number
  roomsPaise: number
  roomTaxPaise: number
  shownGstPaise: number
  payablePaise: number
  displayTotalPaise: number
  advancePaise: number
  /** Functions with no rate card for the venue on that event type — priced without the hall. */
  missingVenueRates: string[]
}

export async function demoQuote(input: {
  eventType: string
  functions: DemoFunctionInput[]
  rooms: DemoRoomInput[]
}): Promise<DemoQuote> {
  const [et] = (await db.execute(sql`
    SELECT is_wedding AS "isWedding" FROM event_types WHERE code = ${input.eventType}
  `)) as unknown as { isWedding: boolean }[]
  const isWedding = Boolean(et?.isWedding)

  // Synthetic ids so priceProposal can say which function carries the day's hire. Sorted by
  // (date, start) because the earliest function of a venue-day is the carrier.
  const subs = input.functions
    .map((f, i) => ({ ...f, id: String(i) }))
    .sort((a, b) => (a.eventDate + a.startTime).localeCompare(b.eventDate + b.startTime))
  const venuePricing = await priceProposal(input.eventType, subs)

  const names = (await db.execute(sql`
    SELECT id::text, name FROM venues UNION ALL SELECT id::text, name FROM venue_bundles
  `)) as unknown as { id: string; name: string }[]
  const nameOf = new Map(names.map((n) => [n.id, n.name]))

  const tierIds = [...new Set(subs.map((s) => s.tierId))]
  const tiers = tierIds.length
    ? ((await db.execute(sql`
        SELECT t.id::text, t.name,
               COALESCE(p.base_rate_paise, 0)::bigint AS "basePaise",
               COALESCE(p.wedding_surcharge_paise, 0)::bigint AS "surchargePaise"
        FROM menu_tiers t
        LEFT JOIN LATERAL (
          SELECT base_rate_paise, wedding_surcharge_paise FROM menu_tier_prices
          WHERE tier_id = t.id AND effective_from <= CURRENT_DATE
          ORDER BY effective_from DESC LIMIT 1
        ) p ON true
        WHERE t.id IN (${sql.join(tierIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `)) as unknown as { id: string; name: string; basePaise: number; surchargePaise: number }[])
    : []
  const tierById = new Map(
    tiers.map((t) => [
      t.id,
      { name: t.name, perPlatePaise: Number(t.basePaise) + (isWedding ? Number(t.surchargePaise) : 0) },
    ]),
  )

  let shownGstPaise = 0
  const functions = subs.map((s) => {
    const tier = tierById.get(s.tierId) ?? { name: 'Menu', perPlatePaise: 0 }
    const venuePaise = venuePricing.rates.get(s.id) ?? null
    const foodPaise = tier.perPlatePaise * s.pax
    // The 18% on venue and food is printed and collected from nobody (rule 11), per line.
    shownGstPaise += taxOf((venuePaise ?? 0) + foodPaise, STANDARD_GST_BP)
    return {
      name: s.name,
      eventDate: s.eventDate,
      startTime: s.startTime,
      endTime: s.endTime,
      venueName: nameOf.get(s.bundleId ?? s.venueId ?? '') ?? 'Venue',
      tierName: tier.name,
      pax: s.pax,
      venuePaise,
      perPlatePaise: tier.perPlatePaise,
      foodPaise,
    }
  })
  const functionsPaise = functions.reduce((sum, f) => sum + (f.venuePaise ?? 0) + f.foodPaise, 0)

  // Rooms at the lodge's rack rate for the category, the same estimate an enquiry is priced at.
  const rateRows = input.rooms.length
    ? ((await db.execute(sql`
        SELECT r.unit_id::text AS "unitId", u.name AS "unitName", r.room_type AS "roomType",
               min(r.rack_rate_paise)::bigint AS rate
        FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
        WHERE r.is_active
        GROUP BY r.unit_id, u.name, r.room_type
      `)) as unknown as { unitId: string; unitName: string; roomType: string; rate: number }[])
    : []
  let roomTaxPaise = 0
  const rooms = input.rooms.map((r) => {
    const row = rateRows.find((x) => x.unitId === r.unitId && x.roomType === r.roomType)
    const ratePaise = Number(row?.rate ?? 0)
    const amountPaise = ratePaise * r.count * r.nights
    roomTaxPaise += taxOf(amountPaise, roomGstBp(ratePaise, r.roomType))
    return { unitName: row?.unitName ?? 'Lodge', roomType: r.roomType, count: r.count, nights: r.nights, ratePaise, amountPaise }
  })
  const roomsPaise = rooms.reduce((sum, r) => sum + r.amountPaise, 0)

  const payablePaise = functionsPaise + roomsPaise + roomTaxPaise
  return {
    functions,
    rooms,
    functionsPaise,
    roomsPaise,
    roomTaxPaise,
    shownGstPaise,
    payablePaise,
    displayTotalPaise: payablePaise + shownGstPaise,
    advancePaise: percentOfPaise(payablePaise, ADVANCE_PCT),
    missingVenueRates: venuePricing.missing.map((m) => m.name),
  }
}
