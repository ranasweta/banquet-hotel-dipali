/**
 * Integration tests against a real PostgreSQL 16. Skipped when TEST_DATABASE_URL is
 * unset so `pnpm test` stays honest on a machine with no database.
 *
 * These assert the guarantees CLAUDE.md leans on are actually enforced by the DB, not
 * merely written down: slot uniqueness, room-overlap exclusion, audit immutability.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type Sql } from '../db/client'
import { migrate } from '../db/migrate'
import { seed } from '../db/seed'
import { assertPaise } from '../lib/money'

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip

if (!hasDb) {
  console.warn('\n  ! TEST_DATABASE_URL unset — skipping integration tests (see .env.example)\n')
}

let sql: Sql

beforeAll(async () => {
  if (!hasDb) return
  sql = createClient('TEST_DATABASE_URL')
  await migrate(sql, () => {})
  await seed(sql, { reset: true, force: true, password: 'test-only' }, () => {})
  // 90s: the batched seed runs in ~15s against a remote Neon database, with headroom
  // for a cold serverless start and a slow link. A per-row seed would blow this (it
  // took 3m37s) — if this timeout starts tripping, look for an un-batched insert.
}, 90_000)

afterAll(async () => {
  if (sql) await sql.end()
})

d('migration 0001', () => {
  it('creates every table db/schema.sql declares', async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    const tables = new Set(rows.map((r) => r.table_name))
    for (const t of [
      'roles', 'modules', 'role_permissions', 'users', 'properties', 'venues',
      'venue_bundles', 'venue_bundle_members', 'event_types', 'venue_rate_cards',
      'menu_tiers', 'menu_tier_prices', 'menu_categories', 'menu_items', 'events',
      'event_contacts', 'guest_documents', 'sub_events', 'venue_bookings',
      'sub_event_menus', 'sub_event_menu_categories', 'sub_event_menu_selections',
      'sub_event_addons', 'exceptions', 'lodging_units', 'rooms', 'room_requirements',
      'room_allocations', 'discounts', 'payments', 'payment_reminders',
      'maintenance_entries', 'lock_signoffs', 'settings', 'invoices', 'invoice_lines',
      'audit_log',
    ]) {
      expect(tables, t).toContain(t)
    }
  })

  it('is a no-op when re-run', async () => {
    expect(await migrate(sql, () => {})).toEqual([])
  })

  it('allows a NULL pick_count for all-included categories (amended)', async () => {
    const [col] = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'menu_categories' AND column_name = 'pick_count'`
    expect(col!.is_nullable).toBe('YES')
  })
})

d('money crosses the driver as an integer number of paise (CLAUDE.md rule 1)', () => {
  it('reads BIGINT paise back as a number, not a BigInt or a string', () => {
    // postgres.js hands int8 back as a string by default, and postgres.BigInt hands
    // back a BigInt. Either would fail assertPaise() and break invoice arithmetic —
    // silently, and only at M9. db/client.ts pins int8 to number; this holds it there.
    const rate = menuBaseRate!
    expect(typeof rate).toBe('number')
    expect(() => assertPaise(rate)).not.toThrow()
    expect(rate).toBe(65_000) // Silver, Rs. 650
  })

  it('round-trips a paise value through the database unchanged', async () => {
    const [row] = await sql<{ v: number }[]>`SELECT ${50_000_000}::bigint AS v`
    expect(row!.v).toBe(50_000_000) // Rs. 5,00,000 — Lotus + Signature
    expect(typeof row!.v).toBe('number')
  })
})

let menuBaseRate: number | undefined
beforeAll(async () => {
  if (!hasDb) return
  const [row] = await sql<{ base_rate_paise: number }[]>`
    SELECT p.base_rate_paise FROM menu_tier_prices p
    JOIN menu_tiers t ON t.id = p.tier_id WHERE t.name = 'Silver'`
  menuBaseRate = row?.base_rate_paise
})

d('the database enforces the clash guarantee', () => {
  it('carries a GiST time-overlap exclusion on venue_bookings (BR-C1)', async () => {
    // The exclusion on (venue_id WITH =, occupancy WITH &&) is what makes an overlapping
    // booking on the same venue physically impossible under concurrent confirms (NFR-2).
    // The behavioural cases live in tests/availability.integration.test.ts.
    const [ex] = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'venue_bookings'::regclass AND contype = 'x'`
    expect(ex, 'venue_bookings must carry an EXCLUDE constraint').toBeDefined()
  })

  it('rejects overlapping allocations of the same room (FR-4.3)', async () => {
    const [ex] = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'room_allocations'::regclass AND contype = 'x'`
    expect(ex, 'room_allocations must carry an EXCLUDE constraint').toBeDefined()
  })
})

d('audit_log is append-only (FR-10.3)', () => {
  it('refuses UPDATE and DELETE, including by the app role', async () => {
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`
    await sql`
      INSERT INTO audit_log (entity, action, user_id, role_name, new_value)
      VALUES ('seed_test', 'insert', ${user!.id}, 'auditor', 'x')`

    await expect(
      sql`UPDATE audit_log SET new_value = 'tampered' WHERE entity = 'seed_test'`,
    ).rejects.toThrow(/append-only/)

    await expect(sql`DELETE FROM audit_log WHERE entity = 'seed_test'`).rejects.toThrow(
      /append-only/,
    )
  })
})

d('seed', () => {
  it('loads every master CLAUDE.md lists', async () => {
    const count = async (table: string) => {
      const [row] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`)
      return row!.n
    }
    // 3 properties: the Residency property retired with Upper Hall (19 Jul 2026) — Residency
    // exists as a LODGING unit, not a venue property.
    expect(await count('properties')).toBe(3)
    // 13 venues: Upper Hall and Utsav Hall are still not carried — the 2026 proposal prices
    // neither — but Ashoka Hall and Pool Side Hall joined on 12 Aug 2026 when the client
    // priced them (SEED_ASSUMPTIONS §F26).
    expect(await count('venues')).toBe(13)
    expect(await count('venue_bundles')).toBe(4)
    // Six rows, of which a booking can only ever be made as two — Wedding and Others. The
    // other four are unreachable from the wizard and are kept only because old rows and rate
    // cards reference them (lib/event-types.ts).
    expect(await count('event_types')).toBe(6)
    expect(await count('menu_tiers')).toBe(8)
    // 12 modules: `lodging_calendar` split out of `rooms` (20 Jul 2026), and `venue_master`
    // arrived 12 Aug 2026 so the Auditor can keep venues, bundles and rates himself.
    expect(await count('modules')).toBe(12)
    expect(await count('roles')).toBe(7) // + chef, who alone prices a delicacy request
    expect(await count('lodging_units')).toBe(3)
  })

  it('provisions 16 users — the PRD\'s 14 plus the Auditor and the Chef', async () => {
    const rows = await sql<{ name: string; n: number }[]>`
      SELECT r.name, count(*)::int AS n
      FROM users u JOIN roles r ON r.id = u.role_id
      GROUP BY r.name ORDER BY r.name`
    expect(Object.fromEntries(rows.map((r) => [r.name, r.n]))).toEqual({
      auditor: 1,
      banquet_manager: 3,
      booking_manager: 5,
      chef: 1, // added 19 Jul 2026
      higher_authority: 2,
      lodge_manager: 3,
      maintenance: 1,
    })
  })

  it('loads Palace at 36 + 1 dormitory, Regency at 49 + 1, Residency at 29', async () => {
    const rows = await sql<{ name: string; rooms: number; dorms: number }[]>`
      SELECT lu.name,
             count(*) FILTER (WHERE r.room_type <> 'dormitory')::int AS rooms,
             count(*) FILTER (WHERE r.room_type =  'dormitory')::int AS dorms
      FROM lodging_units lu LEFT JOIN rooms r ON r.unit_id = lu.id
      GROUP BY lu.name ORDER BY lu.name`
    const byUnit = Object.fromEntries(rows.map((r) => [r.name, { rooms: r.rooms, dorms: r.dorms }]))
    // Client-confirmed inventory, 21 Jul 2026. Palace is 36 (the earlier 38 was a miscount);
    // One 18-bed dormitory at Palace, one at Regency.
    expect(byUnit.Palace).toEqual({ rooms: 36, dorms: 1 })
    expect(byUnit.Regency).toEqual({ rooms: 49, dorms: 1 })
    expect(byUnit.Residency).toEqual({ rooms: 29, dorms: 0 }) // 27 deluxe + 2 suite (client, 25 Jul 2026)
    expect(byUnit['Grand / Regency A-block']).toBeUndefined()
  })

  it('applies the PRD §2.1 permission matrix', async () => {
    const actions = async (role: string, module: string) => {
      const rows = await sql<{ action: string }[]>`
        SELECT rp.action FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        WHERE r.name = ${role} AND rp.module_code = ${module}
        ORDER BY rp.action`
      return rows.map((r) => r.action).sort()
    }
    expect(await actions('booking_manager', 'bookings')).toEqual(['create_edit', 'view'])
    expect(await actions('booking_manager', 'calendar')).toEqual(['view'])
    // The matrix prints "—" for a booking manager on roles_users; M1 turns this into a 403.
    expect(await actions('booking_manager', 'roles_users')).toEqual([])
    expect(await actions('auditor', 'roles_users')).toEqual(['create_edit', 'delete', 'view'])
  })

  it('prices venues per event type, with no silent zero for the gaps', async () => {
    const rate = async (venue: string, eventType: string) => {
      const rows = await sql<{ rate_paise: number }[]>`
        SELECT rc.rate_paise FROM venue_rate_cards rc
        JOIN venues v ON v.id = rc.venue_id
        WHERE v.name = ${venue} AND rc.event_type = ${eventType}`
      return rows[0]?.rate_paise ?? null
    }
    // ONE price per venue, charged whatever the event is (client, 19 Jul 2026: the
    // proposal's third column is the venue's speciality, not a second price).
    expect(await rate('Kohinoor', 'mahila_sangeet')).toBe(5_500_000)
    expect(await rate('Imperial', 'engagement')).toBe(7_500_000)
    expect(await rate('Kohinoor', 'wedding')).toBe(5_500_000)
    expect(await rate('Imperial', 'wedding')).toBe(7_500_000)
    // A wedding at Imperial/Kohinoor is priced as the bundle instead.
    const [bundle] = await sql<{ rate_paise: number }[]>`
      SELECT rc.rate_paise FROM venue_rate_cards rc
      JOIN venue_bundles b ON b.id = rc.bundle_id
      WHERE b.name = 'Imperial + Kohinoor' AND rc.event_type = 'wedding'`
    expect(bundle!.rate_paise).toBe(15_100_000)
    // Gulmohar and Middle are still sold only as their bundle and carry no rate of their own.
    // That is the gap BR-R1 guards: a missing rate stays an explicit gate, never a silent zero.
    // Diamond and Golden LEFT this group on 12 Aug 2026, when the client priced them apart.
    for (const et of ['wedding', 'birthday']) {
      expect(await rate('Gulmohar Lawn', et), `Gulmohar Lawn / ${et}`).toBeNull()
      expect(await rate('Middle Lawn', et), `Middle Lawn / ${et}`).toBeNull()
    }
    expect(await rate('Diamond Hall', 'wedding')).toBe(2_500_000)
    expect(await rate('Golden Hall', 'wedding')).toBe(2_500_000)

    // A DELIBERATE zero is the other half of that rule and is not a gap: an "Other" booking
    // pays no standalone hall charge (client, 12 Aug 2026), while its bundle still does.
    expect(await rate('Kohinoor', 'other')).toBe(0)
    expect(await rate('Imperial', 'other')).toBe(0)
    const [bundleOther] = await sql<{ rate_paise: number }[]>`
      SELECT rc.rate_paise FROM venue_rate_cards rc
      JOIN venue_bundles b ON b.id = rc.bundle_id
      WHERE b.name = 'Imperial + Kohinoor' AND rc.event_type = 'other'`
    expect(bundleOther!.rate_paise).toBe(15_100_000)
  })

  it('snapshots the Rs. 50 wedding surcharge onto every tier price (BR-M5)', async () => {
    const rows = await sql<{ name: string; base_rate_paise: number; wedding_surcharge_paise: number }[]>`
      SELECT t.name, p.base_rate_paise, p.wedding_surcharge_paise
      FROM menu_tier_prices p JOIN menu_tiers t ON t.id = p.tier_id`
    expect(rows).toHaveLength(8)
    for (const r of rows) expect(r.wedding_surcharge_paise, r.name).toBe(5_000)
  })

  it('is idempotent — a second run changes no count in ANY master table', async () => {
    // Checking one table is not enough: venue_rate_cards has no natural key to
    // ON CONFLICT against, and an earlier version of the seed silently doubled every
    // rate card on re-run while menu_items stayed put. Compare all of them.
    const snapshot = async () => {
      const rows = await sql<{ table: string; n: number }[]>`
        SELECT 'properties' AS "table", count(*)::int AS n FROM properties
        UNION ALL SELECT 'venues', count(*)::int FROM venues
        UNION ALL SELECT 'venue_bundles', count(*)::int FROM venue_bundles
        UNION ALL SELECT 'venue_bundle_members', count(*)::int FROM venue_bundle_members
        UNION ALL SELECT 'venue_rate_cards', count(*)::int FROM venue_rate_cards
        UNION ALL SELECT 'event_types', count(*)::int FROM event_types
        UNION ALL SELECT 'menu_tiers', count(*)::int FROM menu_tiers
        UNION ALL SELECT 'menu_tier_prices', count(*)::int FROM menu_tier_prices
        UNION ALL SELECT 'menu_categories', count(*)::int FROM menu_categories
        UNION ALL SELECT 'menu_items', count(*)::int FROM menu_items
        UNION ALL SELECT 'lodging_units', count(*)::int FROM lodging_units
        UNION ALL SELECT 'rooms', count(*)::int FROM rooms
        UNION ALL SELECT 'modules', count(*)::int FROM modules
        UNION ALL SELECT 'roles', count(*)::int FROM roles
        UNION ALL SELECT 'role_permissions', count(*)::int FROM role_permissions
        UNION ALL SELECT 'users', count(*)::int FROM users
        UNION ALL SELECT 'settings', count(*)::int FROM settings
        ORDER BY 1`
      return Object.fromEntries(rows.map((r) => [r.table, r.n]))
    }
    const before = await snapshot()
    await seed(sql, { password: 'test-only' }, () => {})
    expect(await snapshot()).toEqual(before)
    // 30s: this test runs a whole second seed, which is ~15s against a remote database —
    // well past vitest's 5s default.
  }, 30_000)

  it('leaves exactly one rate card per venue/bundle + event type + date', async () => {
    // Two rate cards for the same venue and event type on the same effective date make
    // pricing ambiguous — the confirm transaction would have to pick one arbitrarily.
    const dupes = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM venue_rate_cards
      GROUP BY venue_id, bundle_id, event_type, effective_from
      HAVING count(*) > 1`
    expect(dupes).toEqual([])
  })

  it('refuses --reset when events exist, to protect real data', async () => {
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`
    await sql`
      INSERT INTO events (code, guest_name, event_type, created_by)
      VALUES ('E-RESET-GUARD', 'Guard Test', 'wedding', ${user!.id})`
    try {
      await expect(seed(sql, { reset: true, password: 'test-only' }, () => {})).rejects.toThrow(
        /Refusing --reset/,
      )
    } finally {
      await sql`DELETE FROM events WHERE code = 'E-RESET-GUARD'`
    }
  })
})
