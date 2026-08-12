import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'

/**
 * Day sheet (M8, FR-2.4): every sub-event on a date, consolidated as the kitchen & ops order
 * — venue, timing, pax, menu tier + selected dishes, add-ons and notes. Confirmed-and-beyond
 * only (enquiries never reach operations). Printable/exportable.
 */

/**
 * The operations view of a function — everything the kitchen and the floor need, and no
 * money at all (client, 21 Jul 2026: the Banquet Manager sees "all details except money").
 *
 * Money is left out at the QUERY, not hidden in the UI: this payload is served to roles
 * with no billing grant, so a per-plate rate travelling to the browser and being styled
 * away would be a leak with a stylesheet in front of it.
 *
 * Dishes carry their preference notes ("dal spicy") and the segment they belong to, plus the
 * chef delicacies — an off-menu dish is part of what the kitchen cooks, so it belongs on the
 * same sheet. A request the Chef has not costed yet rides along flagged `pending` rather than
 * being withheld: the floor plans around a dish from the moment the guest asks for it, and
 * needs just as much to know it is not agreed. Declined asks are dropped — nobody cooks those.
 */
export type OpsDish = { name: string; note: string | null; isExtra: boolean }
/** An off-menu ask on a function. `pending` means the Chef has not priced it — not agreed. */
export type ChefDish = { description: string; pending: boolean }
export type OpsFunction = {
  subEventId: string
  date: string
  eventCode: string
  guestName: string
  eventType: string
  name: string
  startTime: string
  endTime: string
  pax: number
  venueName: string | null
  tierName: string | null
  menuComplete: boolean
  segments: { name: string; dishes: OpsDish[] }[]
  chefDishes: ChefDish[]
  addons: { description: string; qty: number }[]
}
export type OpsDay = { date: string; isToday: boolean; functions: OpsFunction[] }

/**
 * The off-menu asks on a set of functions, priced or still with the Chef. Shared by the
 * fifteen-day board and the day sheet so the kitchen reads one list either way — the two
 * screens are the same order printed at different lengths.
 */
async function chefDishesBySub(inList: ReturnType<typeof sql>): Promise<Map<string, ChefDish[]>> {
  const rows = (await db.execute(sql`
    SELECT sub_event_id AS "subEventId", description, status = 'pending' AS pending
    FROM chef_requests WHERE sub_event_id IN (${inList}) AND status <> 'declined'
    ORDER BY requested_at
  `)) as unknown as { subEventId: string; description: string; pending: boolean }[]
  const out = new Map<string, ChefDish[]>()
  for (const r of rows) {
    out.set(r.subEventId, [...(out.get(r.subEventId) ?? []), { description: r.description, pending: r.pending }])
  }
  return out
}

/**
 * Every function across a window of days, in operations shape. Drives the Banquet
 * Manager's 15-day board and the Chef's today view — one query, because they are the same
 * question asked over different spans.
 */
export async function getOperationsHorizon(
  from: string,
  days: number,
  today = new Date().toISOString().slice(0, 10),
  // A Banquet Manager sees only the venues they own (client, 22 Jul 2026). Their user id,
  // matched against properties.banquet_manager_id — one manager may own several properties
  // (Regency covers Dipali Grand). null (everyone else) shows every function.
  scopeBanquetManagerId: string | null = null,
): Promise<{ from: string; to: string; days: OpsDay[] }> {
  const rows = (await db.execute(sql`
    SELECT se.id AS "subEventId", se.event_date::text AS date, se.name,
           se.start_time::text AS "startTime", se.end_time::text AS "endTime",
           se.pax,
           e.code AS "eventCode", e.guest_name AS "guestName", e.event_type AS "eventType",
           COALESCE(v.name, b.name) AS "venueName",
           m.tier_name AS "tierName", COALESCE(m.is_complete, false) AS "menuComplete"
    FROM sub_events se
    JOIN events e ON e.id = se.event_id
    LEFT JOIN venues v ON v.id = se.venue_id
    LEFT JOIN venue_bundles b ON b.id = se.bundle_id
    LEFT JOIN sub_event_menus m ON m.sub_event_id = se.id
    WHERE se.event_date >= ${from}::date
      AND se.event_date < (${from}::date + ${days}::int)
      AND e.status IN ('confirmed','in_progress','completed','locked','billed','closed')
      -- The function is the manager's if its own venue's property is theirs, OR (for a
      -- bundle booking) any member venue's property is theirs. Bundles can span properties,
      -- so a shared bundle shows for every manager who owns a piece of it.
      AND (
        ${scopeBanquetManagerId}::uuid IS NULL
        OR (se.venue_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM venues sv JOIN properties sp ON sp.id = sv.property_id
               WHERE sv.id = se.venue_id AND sp.banquet_manager_id = ${scopeBanquetManagerId}::uuid))
        OR (se.bundle_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM venue_bundle_members vbm
                JOIN venues sv ON sv.id = vbm.venue_id
                JOIN properties sp ON sp.id = sv.property_id
               WHERE vbm.bundle_id = se.bundle_id AND sp.banquet_manager_id = ${scopeBanquetManagerId}::uuid))
      )
    ORDER BY se.event_date, se.start_time, "venueName"
  `)) as unknown as (Omit<OpsFunction, 'segments' | 'chefDishes' | 'addons'>)[]

  const dayList: OpsDay[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(`${from}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + i)
    const date = d.toISOString().slice(0, 10)
    dayList.push({ date, isToday: date === today, functions: [] })
  }
  const byDate = new Map(dayList.map((d) => [d.date, d]))
  const to = dayList[dayList.length - 1]?.date ?? from

  if (rows.length === 0) return { from, to, days: dayList }

  const ids = rows.map((r) => r.subEventId)
  const inList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)

  const [dishes, chefBySub, addons] = await Promise.all([
    db.execute(sql`
      SELECT m.sub_event_id AS "subEventId", s.category_name AS "categoryName",
             s.item_name AS "itemName", s.note, s.is_extra AS "isExtra"
      FROM sub_event_menu_selections s JOIN sub_event_menus m ON m.id = s.menu_id
      WHERE m.sub_event_id IN (${inList})
      ORDER BY s.category_name, s.is_extra, s.item_name
    `) as unknown as Promise<{ subEventId: string; categoryName: string; itemName: string; note: string | null; isExtra: boolean }[]>,
    chefDishesBySub(inList),
    db.execute(sql`
      SELECT sub_event_id AS "subEventId", description, qty
      FROM sub_event_addons WHERE sub_event_id IN (${inList})
    `) as unknown as Promise<{ subEventId: string; description: string; qty: number }[]>,
  ])

  const segBySub = new Map<string, Map<string, OpsDish[]>>()
  for (const d of dishes) {
    const cats = segBySub.get(d.subEventId) ?? new Map<string, OpsDish[]>()
    const list = cats.get(d.categoryName) ?? []
    list.push({ name: d.itemName, note: d.note, isExtra: d.isExtra })
    cats.set(d.categoryName, list)
    segBySub.set(d.subEventId, cats)
  }
  const addonBySub = new Map<string, { description: string; qty: number }[]>()
  for (const a of addons) {
    addonBySub.set(a.subEventId, [...(addonBySub.get(a.subEventId) ?? []), { description: a.description, qty: a.qty }])
  }

  for (const r of rows) {
    byDate.get(r.date)?.functions.push({
      ...r,
      pax: Number(r.pax),
      segments: [...(segBySub.get(r.subEventId) ?? new Map())].map(([name, ds]) => ({ name, dishes: ds })),
      chefDishes: chefBySub.get(r.subEventId) ?? [],
      addons: addonBySub.get(r.subEventId) ?? [],
    })
  }
  return { from, to, days: dayList }
}

export type DaySheetFunction = {
  subEventId: string
  eventCode: string
  guestName: string
  eventType: string
  name: string
  startTime: string
  endTime: string
  pax: number
  venueName: string | null
  menu: { tierName: string; perPlatePaise: number; complete: boolean; categories: { name: string; items: string[] }[] } | null
  /** The same off-menu asks the board carries: this sheet is what the kitchen cooks from. */
  chefDishes: ChefDish[]
  addons: { description: string; qty: number; ratePaise: number }[]
}

export async function getDaySheet(date: string): Promise<{ date: string; functions: DaySheetFunction[] }> {
  const subs = (await db.execute(sql`
    SELECT se.id, se.name, se.start_time::text AS "startTime", se.end_time::text AS "endTime",
           se.pax,
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
    id: string; name: string; startTime: string; endTime: string; pax: number
    eventCode: string; guestName: string; eventType: string; venueName: string | null
  }[]

  if (subs.length === 0) return { date, functions: [] }
  const ids = subs.map((s) => s.id)
  const inList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)

  const [menus, selections, addons, chefBySub] = await Promise.all([
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
    chefDishesBySub(inList),
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
      venueName: s.venueName,
      menu: m
        ? {
            tierName: m.tierName,
            perPlatePaise: Number(m.perPlatePaise),
            complete: m.complete,
            categories: cats ? [...cats.entries()].map(([name, items]) => ({ name, items })) : [],
          }
        : null,
      chefDishes: chefBySub.get(s.id) ?? [],
      addons: addonsBySub.get(s.id) ?? [],
    }
  })

  return { date, functions }
}
