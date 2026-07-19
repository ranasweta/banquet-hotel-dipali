/**
 * Master data transcribed from PRD §2.1 / §3 and the hotel's 2026 venue proposal
 * (BANQUET MENU WITH VENUE PROPOSAL UPDATE 2026, pp. 1-3).
 *
 * Where the proposal and the PRD disagree, THE PROPOSAL WINS — it is the hotel's own
 * price list. Every invented value is marked PLACEHOLDER and listed in
 * docs/SEED_ASSUMPTIONS.md.
 */
import { rupeesToPaise } from '../lib/money'

export const PROPERTIES = ['Palace', 'Regency', 'Dipali Grand', 'Residency'] as const
export type PropertyName = (typeof PROPERTIES)[number]

export type VenueSeed = {
  name: string
  property: PropertyName
  kind: 'hall' | 'lawn'
  capacityMin: number
  capacityMax: number
  /** Set when the capacity is invented rather than sourced. */
  capacityPlaceholder?: string
  note?: string
}

export const VENUES: VenueSeed[] = [
  { name: 'Kohinoor', property: 'Regency', kind: 'hall', capacityMin: 150, capacityMax: 250 },
  { name: 'Imperial', property: 'Regency', kind: 'hall', capacityMin: 250, capacityMax: 400 },
  { name: 'Crystal', property: 'Palace', kind: 'hall', capacityMin: 300, capacityMax: 450 },
  { name: 'Signature', property: 'Dipali Grand', kind: 'hall', capacityMin: 300, capacityMax: 600 },
  { name: 'Upper Hall', property: 'Residency', kind: 'hall', capacityMin: 1, capacityMax: 50 },
  { name: 'Utsav Hall', property: 'Regency', kind: 'hall', capacityMin: 1, capacityMax: 50 },
  {
    name: 'Diamond Hall',
    property: 'Palace',
    kind: 'hall',
    capacityMin: 1,
    capacityMax: 75,
    note: 'PRD §3.1: usually assigned within a package. No automation — PRD open question 6.',
  },
  {
    name: 'Golden Hall',
    property: 'Palace',
    kind: 'hall',
    capacityMin: 1,
    capacityMax: 75,
    capacityPlaceholder:
      'Golden Hall appears only on the proposal ("DIAMOND & GOLDEN HALL 25,000/-") and in no PRD table. Capacity copied from Diamond Hall as a guess.',
  },
  {
    name: 'Saffron Hall & Lawn',
    property: 'Regency',
    kind: 'hall',
    capacityMin: 100,
    capacityMax: 300,
    capacityPlaceholder: 'PRD §3.1 prints "—" for capacity. Invented outright.',
  },
  {
    name: 'Tulip Lawn + Mandap Hall',
    property: 'Regency',
    kind: 'lawn',
    capacityMin: 500,
    capacityMax: 900,
    note: 'One venue, not a bundle — PRD §3.2 names only three combined offerings as bundles.',
  },
  {
    name: 'Gulmohar Lawn',
    property: 'Palace',
    kind: 'lawn',
    capacityMin: 300,
    capacityMax: 600,
    capacityPlaceholder:
      'PRD §3.2 gives only the combined Gulmohar + Middle capacity (500-1,000). Split invented; the two must exist separately because they form a bundle.',
  },
  {
    name: 'Middle Lawn',
    property: 'Palace',
    kind: 'lawn',
    capacityMin: 200,
    capacityMax: 400,
    capacityPlaceholder: 'See Gulmohar Lawn — invented half of the combined 500-1,000.',
  },
  { name: 'Lotus Lawn', property: 'Dipali Grand', kind: 'lawn', capacityMin: 500, capacityMax: 1200 },
]

/** Booking a bundle blocks every member venue, and vice versa (FR-2.3). */
export const BUNDLES: { name: string; members: string[] }[] = [
  { name: 'Imperial + Kohinoor', members: ['Imperial', 'Kohinoor'] },
  { name: 'Lotus + Signature', members: ['Lotus Lawn', 'Signature'] },
  { name: 'Gulmohar + Middle', members: ['Gulmohar Lawn', 'Middle Lawn'] },
  { name: 'Diamond & Golden Hall', members: ['Diamond Hall', 'Golden Hall'] },
]

export const EVENT_TYPES = [
  { code: 'wedding', displayName: 'Wedding', contactNumbers: 3, isWedding: true },
  { code: 'engagement', displayName: 'Engagement', contactNumbers: 1, isWedding: false },
  { code: 'mahila_sangeet', displayName: 'Mahila Sangeet', contactNumbers: 1, isWedding: false },
  { code: 'birthday', displayName: 'Birthday', contactNumbers: 1, isWedding: false },
  { code: 'corporate', displayName: 'Corporate', contactNumbers: 1, isWedding: false },
  { code: 'other', displayName: 'Other', contactNumbers: 1, isWedding: false },
] as const

export const RATE_EFFECTIVE_FROM = '2026-01-01'

/**
 * Rates exactly as the 2026 proposal prints them, per event type.
 *
 * A venue+event-type with no row here has NO rate. That is deliberate and must stay an
 * explicit gate: the wizard blocks confirm and demands an Authority-approved manual
 * rate. Never fall back to zero. Missing on purpose: Upper Hall and Utsav Hall
 * ("package-based"), and any wedding rate for a standalone Imperial or Kohinoor — the
 * proposal prices those two for sangeet/engagement only, and weddings via the bundle.
 */
export type RateSeed = { venue?: string; bundle?: string; ratePaise: number }

/**
 * One price per venue, charged whenever that venue is chosen — identical for every event type
 * (client, 19 Jul 2026: the proposal's third column is the venue's *speciality*, not a second
 * price). The seed writes each rate against every event type, so nothing gates on event type.
 * Verified against the data before the change: no venue ever carried two different rates.
 */
export const RATE_CARDS: RateSeed[] = [
  // --- Dipali Palace (proposal p. 1) ---
  { bundle: 'Gulmohar + Middle', ratePaise: rupeesToPaise(225_000) },
  { venue: 'Crystal', ratePaise: rupeesToPaise(151_000) },
  { bundle: 'Diamond & Golden Hall', ratePaise: rupeesToPaise(25_000) },

  // --- Dipali Regency (proposal p. 2) ---
  { venue: 'Tulip Lawn + Mandap Hall', ratePaise: rupeesToPaise(175_000) },
  { venue: 'Imperial', ratePaise: rupeesToPaise(75_000) },
  { venue: 'Kohinoor', ratePaise: rupeesToPaise(55_000) },
  { bundle: 'Imperial + Kohinoor', ratePaise: rupeesToPaise(151_000) },
  { venue: 'Saffron Hall & Lawn', ratePaise: rupeesToPaise(55_000) },

  // --- Dipali Grand + Regency A-block (proposal p. 3) ---
  { venue: 'Lotus Lawn', ratePaise: rupeesToPaise(175_000) },
  { venue: 'Signature', ratePaise: rupeesToPaise(200_000) },
  { bundle: 'Lotus + Signature', ratePaise: rupeesToPaise(500_000) },
]

export const LODGING_UNITS = ['Palace', 'Regency', 'Grand / Regency A-block'] as const

export type RoomSeed = {
  block: string | null
  roomNo: string
  roomType: string
  beds: number
  rackRatePaise: number
}

/**
 * Palace: 33 Deluxe + 3 Suite = 36 rooms, plus dormitory blocks A and B of 18 beds each
 * (PRD §3.3). Counts and rates are real; ROOM NUMBERS ARE INVENTED — the PRD gives none.
 */
export const PALACE_ROOMS: RoomSeed[] = [
  ...Array.from({ length: 33 }, (_, i) => ({
    block: null,
    roomNo: `P${101 + i}`,
    roomType: 'deluxe',
    beds: 2,
    rackRatePaise: rupeesToPaise(5_000),
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    block: null,
    roomNo: `P${201 + i}`,
    roomType: 'suite',
    beds: 2,
    rackRatePaise: rupeesToPaise(8_000),
  })),
  // Each dormitory block is one bookable unit of 18 beds at Rs. 35,000 (see
  // SEED_ASSUMPTIONS.md — per block or per bed is an open question).
  { block: 'A', roomNo: 'DORM-A', roomType: 'dormitory', beds: 18, rackRatePaise: rupeesToPaise(35_000) },
  { block: 'B', roomNo: 'DORM-B', roomType: 'dormitory', beds: 18, rackRatePaise: rupeesToPaise(35_000) },
]

/**
 * Grand / Regency A-block has rack rates in PRD §3.3 (Executive Deluxe Rs. 7,000,
 * Presidential Suite Rs. 11,000) but NO room count and NO structure — the table prints
 * "—". The unit is seeded with zero rooms rather than inventing an inventory out of
 * nothing. Rooms cannot be allocated here until the client supplies the real list.
 */
export const GRAND_ROOMS: RoomSeed[] = []

export const MODULES = [
  'bookings',
  'calendar',
  'menus',
  'menu_master',
  'rooms',
  'maintenance',
  'approvals',
  'billing',
  'roles_users',
  'audit',
] as const
export type ModuleCode = (typeof MODULES)[number]

export const ROLES = [
  'booking_manager',
  'banquet_manager',
  'lodge_manager',
  'maintenance',
  'higher_authority',
  'auditor',
  // Added 19 Jul 2026 (client): prices "chef delicacy" special requests — a guest asking for
  // something off-menu (sushi, say). The Chef sets the per-plate charge; nobody else can.
  'chef',
] as const
export type RoleName = (typeof ROLES)[number]

/**
 * PRD §2.1's matrix, mapped onto perm_action ('view' | 'create_edit' | 'delete').
 *
 * The PRD uses verbs the enum has no room for — Approve, Raise, Sign-off, Lock + Bill,
 * Full, Edit. They collapse as follows (recorded in SEED_ASSUMPTIONS.md):
 *   View                                  -> view
 *   Create/Edit, Edit, Approve, Raise,
 *   Sign-off                              -> view + create_edit
 *   Full, Lock + Bill                     -> view + create_edit + delete
 *   —                                     -> no rows
 * The distinction between, say, Raise and Approve on the approvals module is a
 * behavioural rule for M6, not a permission bit; the matrix cannot express it.
 */
type Grant = 'view' | 'edit' | 'full' | 'none'

const MATRIX: Record<ModuleCode, Record<RoleName, Grant>> = {
  bookings:    { booking_manager: 'edit', banquet_manager: 'view', lodge_manager: 'view', maintenance: 'none', higher_authority: 'view', auditor: 'full', chef: 'none' },
  calendar:    { booking_manager: 'view', banquet_manager: 'edit', lodge_manager: 'view', maintenance: 'none', higher_authority: 'view', auditor: 'full', chef: 'view' },
  // The Chef reads menus to price a delicacy request, but never edits a guest's menu.
  menus:       { booking_manager: 'edit', banquet_manager: 'view', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'view' },
  menu_master: { booking_manager: 'none', banquet_manager: 'view', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'view' },
  rooms:       { booking_manager: 'view', banquet_manager: 'view', lodge_manager: 'edit', maintenance: 'none', higher_authority: 'view', auditor: 'full', chef: 'none' },
  maintenance: { booking_manager: 'none', banquet_manager: 'view', lodge_manager: 'none', maintenance: 'edit', higher_authority: 'view', auditor: 'full', chef: 'none' },
  approvals:   { booking_manager: 'edit', banquet_manager: 'edit', lodge_manager: 'edit', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'none' },
  billing:     { booking_manager: 'none', banquet_manager: 'edit', lodge_manager: 'edit', maintenance: 'edit', higher_authority: 'edit', auditor: 'full', chef: 'none' },
  roles_users: { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'view', auditor: 'full', chef: 'none' },
  audit:       { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'view', auditor: 'full', chef: 'none' },
}

const GRANT_ACTIONS: Record<Grant, string[]> = {
  none: [],
  view: ['view'],
  edit: ['view', 'create_edit'],
  full: ['view', 'create_edit', 'delete'],
}

export function permissionRows(): { role: RoleName; module: ModuleCode; action: string }[] {
  const rows: { role: RoleName; module: ModuleCode; action: string }[] = []
  for (const moduleCode of MODULES) {
    for (const role of ROLES) {
      for (const action of GRANT_ACTIONS[MATRIX[moduleCode][role]]) {
        rows.push({ role, module: moduleCode, action })
      }
    }
  }
  return rows
}

/**
 * PRD §2 provisions 14 users. The 15th is the Auditor/Admin: the role owns roles+users
 * admin, the event lock and billing (PRD §2.1), so the system is unusable without one,
 * yet no Auditor appears in the provisioning list. Flagged in SEED_ASSUMPTIONS.md.
 */
export type UserSeed = { fullName: string; mobile: string; email?: string; role: RoleName }

export const USERS: UserSeed[] = [
  { fullName: 'Auditor / Admin', mobile: '9000000001', email: 'schemekart@gmail.com', role: 'auditor' },
  { fullName: 'Higher Authority 1', mobile: '9000000002', role: 'higher_authority' },
  { fullName: 'Higher Authority 2', mobile: '9000000003', role: 'higher_authority' },
  { fullName: 'Lodge Manager — Palace', mobile: '9000000004', role: 'lodge_manager' },
  { fullName: 'Lodge Manager — Regency', mobile: '9000000005', role: 'lodge_manager' },
  { fullName: 'Lodge Manager — Grand', mobile: '9000000006', role: 'lodge_manager' },
  { fullName: 'Booking Manager 1', mobile: '9000000007', role: 'booking_manager' },
  { fullName: 'Booking Manager 2', mobile: '9000000008', role: 'booking_manager' },
  { fullName: 'Booking Manager 3', mobile: '9000000009', role: 'booking_manager' },
  { fullName: 'Booking Manager 4', mobile: '9000000010', role: 'booking_manager' },
  { fullName: 'Booking Manager 5', mobile: '9000000011', role: 'booking_manager' },
  { fullName: 'Banquet Manager 1', mobile: '9000000012', role: 'banquet_manager' },
  { fullName: 'Banquet Manager 2', mobile: '9000000013', role: 'banquet_manager' },
  { fullName: 'Banquet Manager 3', mobile: '9000000014', role: 'banquet_manager' },
  { fullName: 'Maintenance Lead', mobile: '9000000015', role: 'maintenance' },
  { fullName: 'Head Chef', mobile: '9000000016', role: 'chef' },
]

export const SETTINGS: { key: string; value: string }[] = [
  { key: 'advance_pct', value: '25' }, // BR-P1
  { key: 'discount_cap_pct', value: '10' }, // BR-D2
  { key: 'room_discount_cap_paise', value: String(rupeesToPaise(500)) }, // BR-D1
  { key: 'suite_discount_cap_paise', value: String(rupeesToPaise(1_000)) }, // BR-D1
  { key: 'stale_enquiry_days', value: '7' }, // FR-1.8
  { key: 'calendar_window_days', value: '15' }, // FR-2.1
  { key: 'large_allocation_rooms', value: '35' }, // BR-L2
  {
    key: 'terms_and_conditions',
    // FR-7.6: static text supplied by the client, maintained by Admin in masters.
    value: 'PLACEHOLDER — the hotel has not supplied its Terms & Conditions text yet. Admin must set this before any invoice is finalised (FR-7.6).',
  },
]
