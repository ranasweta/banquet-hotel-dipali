/**
 * Seeds all master data (CLAUDE.md § Seed data). Idempotent: re-running produces
 * identical counts.
 *
 * Every insert is batched into a single multi-row statement. The seed writes ~700 rows;
 * one round trip each is instant against a local database but takes minutes against a
 * remote one (measured: 3m37s to Neon in us-east-1). Batched, it is ~20 round trips.
 * Keep it that way — do not reintroduce per-row awaits in a loop.
 *
 * The seed writes NO audit_log rows. It is bootstrap, not a user write — there is no
 * acting user, and audit_log.user_id is NOT NULL. Every write made through the app is
 * audited per CLAUDE.md rule 5; this runs before the app exists.
 *
 * Usage: pnpm seed                  (uses DATABASE_URL)
 *        pnpm seed --reset          (wipe masters first; refuses if events exist)
 *        pnpm seed --reset --force  (wipe even if events exist — destroys them)
 *        pnpm seed --test           (uses TEST_DATABASE_URL)
 */
import { resolve } from 'node:path'
import bcrypt from 'bcryptjs'
import { createClient, type Sql, type Tx } from './client'
import { loadMenus, loadRegencyRooms } from './seed-data'
import {
  BUNDLES,
  EVENT_TYPES,
  GRAND_ROOMS,
  LODGING_UNITS,
  MODULES,
  PALACE_ROOMS,
  PROPERTIES,
  RATE_CARDS,
  RATE_EFFECTIVE_FROM,
  ROLES,
  SETTINGS,
  USERS,
  VENUES,
  permissionRows,
} from './masters'

const MASTER_TABLES = [
  'role_permissions', 'users', 'roles', 'modules',
  'venue_rate_cards', 'venue_bundle_members', 'venue_bundles', 'venues', 'properties',
  'menu_items', 'menu_categories', 'menu_tier_prices', 'menu_tiers',
  'rooms', 'lodging_units', 'event_types', 'settings',
]

export type SeedCounts = Record<string, number>

async function reset(sql: Tx, force: boolean, log: (m: string) => void) {
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM events`
  if (count > 0 && !force) {
    throw new Error(
      `Refusing --reset: ${count} event(s) exist and truncating masters would cascade them away. ` +
        `Re-run with --force if you really mean to destroy them.`,
    )
  }
  if (count > 0) log(`  ! --force: destroying ${count} existing event(s)`)
  await sql.unsafe(`TRUNCATE TABLE ${MASTER_TABLES.join(', ')} RESTART IDENTITY CASCADE`)
  log(`  - masters truncated`)
}

export async function seed(
  sql: Sql,
  opts: { reset?: boolean; force?: boolean; password?: string } = {},
  log: (m: string) => void = console.log,
): Promise<SeedCounts> {
  // Validate both data files before touching the DB, so a bad edit fails at the file.
  const menus = loadMenus()
  const regency = loadRegencyRooms()

  const password = opts.password ?? process.env.SEED_PASSWORD ?? 'ChangeMe#12345'
  if (!process.env.SEED_PASSWORD && !opts.password) {
    log('  ! SEED_PASSWORD not set — seeding users with the default dev password')
  }
  const passwordHash = await bcrypt.hash(password, 10)

  const counts: SeedCounts = {}

  await sql.begin(async (tx) => {
    if (opts.reset) await reset(tx, opts.force ?? false, log)

    // --- Properties -------------------------------------------------------
    // Note on the `as` casts below: postgres.js cannot resolve an explicit row type
    // argument (sql<T[]>`…`) and an embedded sql(rows, ...cols) multi-row fragment in
    // the same call — the overload falls through and TS2345s on the Helper. So these
    // queries take no type argument and the result is narrowed afterwards instead.
    const properties = (await tx`
      INSERT INTO properties ${tx(PROPERTIES.map((name) => ({ name })), 'name')}
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name`) as { id: string; name: string }[]
    const propertyId = new Map<string, string>(properties.map((p) => [p.name, p.id]))
    counts.properties = properties.length

    // --- Venues -----------------------------------------------------------
    const venues = (await tx`
      INSERT INTO venues ${tx(
        VENUES.map((v) => ({
          property_id: propertyId.get(v.property)!,
          name: v.name,
          kind: v.kind,
          capacity_min: v.capacityMin,
          capacity_max: v.capacityMax,
        })),
        'property_id', 'name', 'kind', 'capacity_min', 'capacity_max',
      )}
      ON CONFLICT (property_id, name) DO UPDATE SET
        kind = EXCLUDED.kind,
        capacity_min = EXCLUDED.capacity_min,
        capacity_max = EXCLUDED.capacity_max
      RETURNING id, name`) as { id: string; name: string }[]
    const venueId = new Map<string, string>(venues.map((v) => [v.name, v.id]))
    counts.venues = venues.length

    // --- Bundles ----------------------------------------------------------
    const bundles = (await tx`
      INSERT INTO venue_bundles ${tx(BUNDLES.map((b) => ({ name: b.name })), 'name')}
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name`) as { id: string; name: string }[]
    const bundleId = new Map<string, string>(bundles.map((b) => [b.name, b.id]))
    counts.venue_bundles = bundles.length

    const memberRows = BUNDLES.flatMap((b) =>
      b.members.map((m) => ({ bundle_id: bundleId.get(b.name)!, venue_id: venueId.get(m)! })),
    )
    await tx`
      INSERT INTO venue_bundle_members ${tx(memberRows, 'bundle_id', 'venue_id')}
      ON CONFLICT DO NOTHING`
    counts.venue_bundle_members = memberRows.length

    // --- Event types ------------------------------------------------------
    await tx`
      INSERT INTO event_types ${tx(
        EVENT_TYPES.map((t) => ({
          code: t.code,
          display_name: t.displayName,
          contact_numbers: t.contactNumbers,
          is_wedding: t.isWedding,
        })),
        'code', 'display_name', 'contact_numbers', 'is_wedding',
      )}
      ON CONFLICT (code) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        contact_numbers = EXCLUDED.contact_numbers,
        is_wedding = EXCLUDED.is_wedding`
    counts.event_types = EVENT_TYPES.length

    // --- Rate cards (per event type, exactly as the 2026 proposal prints) ---
    // venue_rate_cards has no natural key to ON CONFLICT against, so re-seeding would
    // silently duplicate every rate card and make pricing ambiguous. The seed owns this
    // table's contents for the effective date it manages: clear that slice, then insert.
    // (A UNIQUE NULLS NOT DISTINCT constraint would be better — see SEED_ASSUMPTIONS.md.)
    const rateRows = RATE_CARDS.flatMap((r) =>
      r.eventTypes.map((eventType) => ({
        venue_id: r.venue ? venueId.get(r.venue)! : null,
        bundle_id: r.bundle ? bundleId.get(r.bundle)! : null,
        event_type: eventType,
        rate_paise: r.ratePaise,
        effective_from: RATE_EFFECTIVE_FROM,
      })),
    )
    await tx`DELETE FROM venue_rate_cards WHERE effective_from = ${RATE_EFFECTIVE_FROM}`
    await tx`
      INSERT INTO venue_rate_cards ${tx(
        rateRows, 'venue_id', 'bundle_id', 'event_type', 'rate_paise', 'effective_from',
      )}`
    counts.venue_rate_cards = rateRows.length

    // --- Menu masters (from db/menus.seed.json) ---------------------------
    const tiers = (await tx`
      INSERT INTO menu_tiers ${tx(menus.tiers.map((t) => ({ name: t.name })), 'name')}
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name`) as { id: string; name: string }[]
    const tierId = new Map<string, string>(tiers.map((t) => [t.name, t.id]))
    counts.menu_tiers = tiers.length

    await tx`
      INSERT INTO menu_tier_prices ${tx(
        menus.tiers.map((t) => ({
          tier_id: tierId.get(t.name)!,
          effective_from: menus.effectiveFrom,
          base_rate_paise: t.baseRatePaise,
          wedding_surcharge_paise: menus.weddingSurchargePaise,
        })),
        'tier_id', 'effective_from', 'base_rate_paise', 'wedding_surcharge_paise',
      )}
      ON CONFLICT (tier_id, effective_from) DO UPDATE SET
        base_rate_paise = EXCLUDED.base_rate_paise,
        wedding_surcharge_paise = EXCLUDED.wedding_surcharge_paise`
    counts.menu_tier_prices = menus.tiers.length

    const categoryRows = menus.tiers.flatMap((t) =>
      t.categories.map((c, i) => ({
        tier_id: tierId.get(t.name)!,
        name: c.name,
        pick_count: c.pick,
        free_increase_eligible: c.freeIncreaseEligible,
        sort_order: i,
      })),
    )
    const categories = (await tx`
      INSERT INTO menu_categories ${tx(
        categoryRows, 'tier_id', 'name', 'pick_count', 'free_increase_eligible', 'sort_order',
      )}
      ON CONFLICT (tier_id, name) DO UPDATE SET
        pick_count = EXCLUDED.pick_count,
        free_increase_eligible = EXCLUDED.free_increase_eligible,
        sort_order = EXCLUDED.sort_order
      RETURNING id, tier_id, name`) as { id: string; tier_id: string; name: string }[]
    const categoryId = new Map<string, string>(
      categories.map((c) => [`${c.tier_id}|${c.name}`, c.id]),
    )
    counts.menu_categories = categories.length

    const itemRows = menus.tiers.flatMap((t) =>
      t.categories.flatMap((c) =>
        c.items.map((name) => ({
          category_id: categoryId.get(`${tierId.get(t.name)!}|${c.name}`)!,
          name,
        })),
      ),
    )
    await tx`
      INSERT INTO menu_items ${tx(itemRows, 'category_id', 'name')}
      ON CONFLICT (category_id, name) DO NOTHING`
    counts.menu_items = itemRows.length

    // --- Lodging ----------------------------------------------------------
    const units = (await tx`
      INSERT INTO lodging_units ${tx(LODGING_UNITS.map((name) => ({ name })), 'name')}
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name`) as { id: string; name: string }[]
    const unitId = new Map<string, string>(units.map((u) => [u.name, u.id]))
    counts.lodging_units = units.length

    const roomRows = [
      ...PALACE_ROOMS.map((r) => ({ ...r, unit: 'Palace' })),
      ...regency.rooms.map((r) => ({ ...r, block: r.block ?? null, unit: 'Regency' })),
      ...GRAND_ROOMS.map((r) => ({ ...r, unit: 'Grand / Regency A-block' })),
    ].map((r) => ({
      unit_id: unitId.get(r.unit)!,
      block: r.block,
      room_no: r.roomNo,
      room_type: r.roomType,
      beds: r.beds,
      rack_rate_paise: r.rackRatePaise,
    }))
    if (roomRows.length) {
      await tx`
        INSERT INTO rooms ${tx(
          roomRows, 'unit_id', 'block', 'room_no', 'room_type', 'beds', 'rack_rate_paise',
        )}
        ON CONFLICT (unit_id, room_no) DO UPDATE SET
          block = EXCLUDED.block,
          room_type = EXCLUDED.room_type,
          beds = EXCLUDED.beds,
          rack_rate_paise = EXCLUDED.rack_rate_paise`
    }
    counts.rooms = roomRows.length

    // --- Modules, roles, permission matrix --------------------------------
    await tx`
      INSERT INTO modules ${tx(MODULES.map((code) => ({ code })), 'code')}
      ON CONFLICT (code) DO NOTHING`
    counts.modules = MODULES.length

    const roles = (await tx`
      INSERT INTO roles ${tx(ROLES.map((name) => ({ name, is_system: true })), 'name', 'is_system')}
      ON CONFLICT (name) DO UPDATE SET is_system = true
      RETURNING id, name`) as { id: string; name: string }[]
    const roleId = new Map<string, string>(roles.map((r) => [r.name, r.id]))
    counts.roles = roles.length

    const perms = permissionRows()
    await tx`
      INSERT INTO role_permissions ${tx(
        perms.map((p) => ({
          role_id: roleId.get(p.role)!,
          module_code: p.module,
          action: p.action,
        })),
        'role_id', 'module_code', 'action',
      )}
      ON CONFLICT DO NOTHING`
    counts.role_permissions = perms.length

    // --- Users ------------------------------------------------------------
    await tx`
      INSERT INTO users ${tx(
        USERS.map((u) => ({
          full_name: u.fullName,
          mobile: u.mobile,
          email: u.email ?? null,
          password_hash: passwordHash,
          role_id: roleId.get(u.role)!,
        })),
        'full_name', 'mobile', 'email', 'password_hash', 'role_id',
      )}
      ON CONFLICT (mobile) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        role_id = EXCLUDED.role_id`
    counts.users = USERS.length

    // --- Settings ---------------------------------------------------------
    await tx`
      INSERT INTO settings ${tx(SETTINGS, 'key', 'value')}
      ON CONFLICT (key) DO NOTHING`
    counts.settings = SETTINGS.length
  })

  return counts
}

async function main() {
  const argv = process.argv.slice(2)
  const useTest = argv.includes('--test')
  const sql = createClient(useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL')
  console.log(`Seeding (${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'})…`)
  try {
    const counts = await seed(sql, { reset: argv.includes('--reset'), force: argv.includes('--force') })
    for (const [table, n] of Object.entries(counts)) {
      console.log(`  ${String(n).padStart(4)}  ${table}`)
    }
    console.log('Seed complete.')
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
