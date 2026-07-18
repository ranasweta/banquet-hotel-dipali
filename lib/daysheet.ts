import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'

/**
 * Day sheet (M8, FR-2.4): every sub-event on a date, consolidated as the kitchen & ops order
 * — venue, timing, pax, menu tier + selected dishes, add-ons and notes. Confirmed-and-beyond
 * only (enquiries never reach operations). Printable/exportable.
 */

export type DaySheetFunction = {
  subEventId: string
  eventCode: string
  guestName: string
  eventType: string
  name: string
  startTime: string
  endTime: string
  pax: number
  paxOverrideNote: string | null
  venueName: string | null
  menu: { tierName: string; perPlatePaise: number; complete: boolean; categories: { name: string; items: string[] }[] } | null
  addons: { description: string; qty: number; ratePaise: number }[]
}

export async function getDaySheet(date: string): Promise<{ date: string; functions: DaySheetFunction[] }> {
  const subs = (await db.execute(sql`
    SELECT se.id, se.name, se.start_time::text AS "startTime", se.end_time::text AS "endTime",
           se.pax, se.pax_override_note AS "paxOverrideNote",
           e.code AS "eventCode", e.guest_name AS "guestName", e.event_type AS "eventType",
           COALESCE(v.name, b.name) AS "venueName"
    FROM sub_events se
    JOIN events e ON e.id = se.event_id
    LEFT JOIN venues v ON v.id = se.venue_id
    LEFT JOIN venue_bundles b ON b.id = se.bundle_id
    WHERE se.event_date = ${date}::date
      AND e.status IN ('confirmed','in_progress','completed','locked','billed','closed')
    ORDER BY se.start_time, "venueName"
  `)) as unknown as {
    id: string; name: string; startTime: string; endTime: string; pax: number; paxOverrideNote: string | null
    eventCode: string; guestName: string; eventType: string; venueName: string | null
  }[]

  if (subs.length === 0) return { date, functions: [] }
  const ids = subs.map((s) => s.id)
  const inList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)

  const [menus, selections, addons] = await Promise.all([
    db.execute(sql`
      SELECT m.sub_event_id AS "subEventId", m.tier_name AS "tierName",
             (m.base_rate_paise + m.surcharge_paise) AS "perPlatePaise", m.is_complete AS complete
      FROM sub_event_menus m WHERE m.sub_event_id IN (${inList})
    `) as unknown as Promise<{ subEventId: string; tierName: string; perPlatePaise: number; complete: boolean }[]>,
    db.execute(sql`
      SELECT m.sub_event_id AS "subEventId", s.category_name AS "categoryName", s.item_name AS "itemName"
      FROM sub_event_menu_selections s JOIN sub_event_menus m ON m.id = s.menu_id
      WHERE m.sub_event_id IN (${inList})
      ORDER BY s.category_name, s.item_name
    `) as unknown as Promise<{ subEventId: string; categoryName: string; itemName: string }[]>,
    db.execute(sql`
      SELECT sub_event_id AS "subEventId", description, qty, rate_paise AS "ratePaise"
      FROM sub_event_addons WHERE sub_event_id IN (${inList})
    `) as unknown as Promise<{ subEventId: string; description: string; qty: number; ratePaise: number }[]>,
  ])

  const menuBySub = new Map(menus.map((m) => [m.subEventId, m]))
  const selBySub = new Map<string, Map<string, string[]>>()
  for (const s of selections) {
    const cats = selBySub.get(s.subEventId) ?? new Map<string, string[]>()
    const items = cats.get(s.categoryName) ?? []
    items.push(s.itemName)
    cats.set(s.categoryName, items)
    selBySub.set(s.subEventId, cats)
  }
  const addonsBySub = new Map<string, { description: string; qty: number; ratePaise: number }[]>()
  for (const a of addons) {
    const list = addonsBySub.get(a.subEventId) ?? []
    list.push({ description: a.description, qty: a.qty, ratePaise: Number(a.ratePaise) })
    addonsBySub.set(a.subEventId, list)
  }

  const functions: DaySheetFunction[] = subs.map((s) => {
    const m = menuBySub.get(s.id)
    const cats = selBySub.get(s.id)
    return {
      subEventId: s.id,
      eventCode: s.eventCode,
      guestName: s.guestName,
      eventType: s.eventType,
      name: s.name,
      startTime: s.startTime,
      endTime: s.endTime,
      pax: s.pax,
      paxOverrideNote: s.paxOverrideNote,
      venueName: s.venueName,
      menu: m
        ? {
            tierName: m.tierName,
            perPlatePaise: Number(m.perPlatePaise),
            complete: m.complete,
            categories: cats ? [...cats.entries()].map(([name, items]) => ({ name, items })) : [],
          }
        : null,
      addons: addonsBySub.get(s.id) ?? [],
    }
  })

  return { date, functions }
}
