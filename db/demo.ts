/**
 * Dev-only demo data so the calendar board (M2) has something to show before the booking
 * wizard (M3) exists. Inserts a few CONFIRMED events with sub-events and venue_bookings,
 * dated in the rolling window around the base date. Re-runnable: it clears its own
 * 'DEMO-%' events first. NEVER run against production — it writes fabricated bookings.
 *
 * Usage: pnpm demo              (DATABASE_URL)
 *        pnpm demo 2026-07-18   (base date; defaults to today)
 *        pnpm demo --test       (TEST_DATABASE_URL)
 */
import { resolve } from 'node:path'
import { createClient, type Sql } from './client'
import { occupancyParts, nextDay } from '../lib/occupancy'

type DemoSub = {
  name: string
  dayOffset: number // days from base date
  start: string
  end: string
  venue?: string
  bundle?: string
}
type DemoEvent = {
  code: string
  guest: string
  eventType: string
  status: 'confirmed' | 'in_progress'
  subs: DemoSub[]
}

const DEMO: DemoEvent[] = [
  {
    code: 'DEMO-1001',
    guest: 'Sharma Wedding',
    eventType: 'wedding',
    status: 'confirmed',
    subs: [
      // Same venue, same day, two non-overlapping functions — the new model in action.
      { name: 'Haldi', dayOffset: 3, start: '10:00', end: '13:00', venue: 'Crystal' },
      { name: 'Sangeet', dayOffset: 3, start: '19:00', end: '23:00', venue: 'Crystal' },
      { name: 'Wedding', dayOffset: 4, start: '11:00', end: '15:00', venue: 'Crystal' },
      // Runs past midnight → shows as a carryover tail on the next morning.
      { name: 'Reception', dayOffset: 4, start: '20:00', end: '01:00', venue: 'Crystal' },
    ],
  },
  {
    code: 'DEMO-1002',
    guest: 'Verma Engagement',
    eventType: 'engagement',
    status: 'confirmed',
    subs: [{ name: 'Engagement', dayOffset: 2, start: '18:00', end: '22:00', venue: 'Kohinoor' }],
  },
  {
    code: 'DEMO-1003',
    guest: 'Acme Corp Offsite',
    eventType: 'corporate',
    status: 'in_progress',
    subs: [{ name: 'Conference', dayOffset: 0, start: '09:00', end: '17:00', venue: 'Signature' }],
  },
  {
    code: 'DEMO-1004',
    guest: 'Iyer Grand Wedding',
    eventType: 'wedding',
    status: 'confirmed',
    subs: [
      // A bundle booking — blocks BOTH Imperial and Kohinoor for the window.
      { name: 'Wedding', dayOffset: 6, start: '18:00', end: '23:30', bundle: 'Imperial + Kohinoor' },
    ],
  },
  {
    code: 'DEMO-1005',
    guest: 'Khan Sangeet',
    eventType: 'mahila_sangeet',
    status: 'confirmed',
    subs: [{ name: 'Mahila Sangeet', dayOffset: 5, start: '19:00', end: '23:00', venue: 'Gulmohar Lawn' }],
  },
]

function addDays(base: string, n: number): string {
  let d = base
  for (let i = 0; i < n; i++) d = nextDay(d)
  return d
}

export async function loadDemo(sql: Sql, baseDate: string, log: (m: string) => void = console.log) {
  const [auditor] = await sql<{ id: string }[]>`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'auditor' LIMIT 1`
  if (!auditor) throw new Error('No auditor user — run the seed first.')

  await sql`DELETE FROM venue_bookings WHERE event_id IN (SELECT id FROM events WHERE code LIKE 'DEMO-%')`
  await sql`DELETE FROM events WHERE code LIKE 'DEMO-%'`

  let eventCount = 0
  let bookingCount = 0

  for (const ev of DEMO) {
    const [event] = await sql<{ id: string }[]>`
      INSERT INTO events (code, guest_name, event_type, status, created_by, confirmed_at)
      VALUES (${ev.code}, ${ev.guest}, ${ev.eventType}, ${ev.status}, ${auditor.id}, now())
      RETURNING id`
    eventCount++

    for (const sub of ev.subs) {
      const date = addDays(baseDate, sub.dayOffset)

      const [venueRow] = sub.venue
        ? await sql<{ id: string }[]>`SELECT id FROM venues WHERE name = ${sub.venue}`
        : [undefined]
      const [bundleRow] = sub.bundle
        ? await sql<{ id: string }[]>`SELECT id FROM venue_bundles WHERE name = ${sub.bundle}`
        : [undefined]

      const [subEvent] = await sql<{ id: string }[]>`
        INSERT INTO sub_events (event_id, name, event_date, start_time, end_time, venue_id, bundle_id, pax)
        VALUES (${event!.id}, ${sub.name}, ${date}, ${sub.start}, ${sub.end},
                ${venueRow?.id ?? null}, ${bundleRow?.id ?? null}, 200)
        RETURNING id`

      // Resolve the concrete venues this sub-event occupies (bundle members, or one venue).
      const venueIds = sub.bundle
        ? (
            await sql<{ venue_id: string }[]>`
              SELECT venue_id FROM venue_bundle_members WHERE bundle_id = ${bundleRow!.id}`
          ).map((r) => r.venue_id)
        : [venueRow!.id]

      // Compose the range as date::date + time::time (never a combined-string param) so
      // postgres.js does not shift it by the connection timezone. See lib/occupancy.
      const { lowerDate, lowerTime, upperDate, upperTime } = occupancyParts(date, sub.start, sub.end)
      for (const venueId of venueIds) {
        await sql`
          INSERT INTO venue_bookings (venue_id, sub_event_id, event_id, occupancy)
          VALUES (${venueId}, ${subEvent!.id}, ${event!.id},
                  tsrange((${lowerDate}::date + ${lowerTime}::time),
                          (${upperDate}::date + ${upperTime}::time), '[)'))`
        bookingCount++
      }
    }
  }

  log(`  demo: ${eventCount} events, ${bookingCount} venue bookings (base ${baseDate})`)
  return { eventCount, bookingCount }
}

async function main() {
  const argv = process.argv.slice(2)
  const useTest = argv.includes('--test')
  const dateArg = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
  const baseDate = dateArg ?? new Date().toISOString().slice(0, 10)
  const sql = createClient(useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL')
  console.log(`Loading demo (${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'}, base ${baseDate})…`)
  try {
    await loadDemo(sql, baseDate)
    console.log('Demo loaded.')
  } finally {
    await sql.end()
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
