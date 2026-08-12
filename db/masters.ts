/**
 * Master data transcribed from PRD §2.1 / §3 and the hotel's 2026 venue proposal
 * (BANQUET MENU WITH VENUE PROPOSAL UPDATE 2026, pp. 1-3).
 *
 * Where the proposal and the PRD disagree, THE PROPOSAL WINS — it is the hotel's own
 * price list. Every invented value is marked PLACEHOLDER and listed in
 * docs/SEED_ASSUMPTIONS.md.
 */
import { rupeesToPaise } from '../lib/money'
import { termsPlainText } from '../lib/terms'

export const PROPERTIES = ['Palace', 'Regency', 'Dipali Grand'] as const
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
  // Upper Hall (Residency) and Utsav Hall (Regency) are gone: the 2026 proposal prices
  // neither, in any table or bundle, and the client's rule is that a venue with no price
  // is not carried at all (19 Jul 2026). Removing Upper Hall also retires the Residency
  // property, which existed only to hold it — see SEED_ASSUMPTIONS §C5, now moot.
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
  // Client, 12 Aug 2026, priced in the same message that opened the venue master. Neither is
  // in the 2026 proposal or any PRD table, so both capacities are invented outright.
  {
    name: 'Ashoka Hall',
    property: 'Palace',
    kind: 'hall',
    capacityMin: 1,
    capacityMax: 75,
    capacityPlaceholder: 'New venue (client, 12 Aug 2026). Capacity copied from Diamond Hall, which shares its price.',
  },
  {
    name: 'Pool Side Hall',
    property: 'Palace',
    kind: 'hall',
    capacityMin: 1,
    capacityMax: 50,
    capacityPlaceholder: 'New venue (client, 12 Aug 2026). Priced at 5,000 — the cheapest on the card — so the capacity is guessed small.',
  },
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
 * Rates exactly as the 2026 proposal prints them — one price per venue, charged whatever
 * the event is (the proposal's third column is the venue's speciality, not a price).
 *
 * Every venue offered on its own is priced here. The four that are not — Diamond Hall,
 * Golden Hall, Gulmohar Lawn, Middle Lawn — are sold ONLY as their bundle (the proposal
 * prints "DIAMOND & GOLDEN HALL 25,000/-", never the halls apart), so they stay as bundle
 * members but are never offered standalone; see listVenueAvailability. Anything the
 * proposal prices nowhere at all is not carried (Upper Hall, Utsav Hall — removed).
 *
 * A venue with no row here still has NO rate, and that must stay an explicit gate rather
 * than a zero: confirm is blocked until an Authority-approved manual rate exists (BR-R1).
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
  // 35,000, not the 55,000 the 2026 proposal prints — client, 12 Aug 2026, superseding the
  // PDF (SEED_ASSUMPTIONS §F26).
  { venue: 'Saffron Hall & Lawn', ratePaise: rupeesToPaise(35_000) },

  // --- Dipali Grand + Regency A-block (proposal p. 3) ---
  { venue: 'Lotus Lawn', ratePaise: rupeesToPaise(175_000) },
  { venue: 'Signature', ratePaise: rupeesToPaise(200_000) },
  { bundle: 'Lotus + Signature', ratePaise: rupeesToPaise(500_000) },

  // --- Priced by the client on 12 Aug 2026, not in the 2026 proposal ---
  // Diamond and Golden are now sold apart as well as together; the bundle keeps its own
  // 25,000, so the pair costs what one hall costs.
  { venue: 'Diamond Hall', ratePaise: rupeesToPaise(25_000) },
  { venue: 'Golden Hall', ratePaise: rupeesToPaise(25_000) },
  { venue: 'Ashoka Hall', ratePaise: rupeesToPaise(25_000) },
  { venue: 'Pool Side Hall', ratePaise: rupeesToPaise(5_000) },
]

/**
 * The event type that pays no hall charge (client, 12 Aug 2026).
 *
 * An "Other" booking is charged for the dining and the extras but not for the room it sits in
 * — UNLESS it takes a bundle, which is still charged in full. So a standalone venue is written
 * at ZERO for this event type and a bundle keeps its rate.
 *
 * Zero, not absent: a MISSING rate card is a gate that blocks confirmation until the Authority
 * approves a manual rate (BR-R1), and that is exactly what must not happen here. The zero says
 * "decided, and free"; the gap says "nobody has priced this yet". They are different facts and
 * the seed must not blur them.
 *
 * This lives as DATA rather than a branch in the pricing code, because the whole point of the
 * venue master is that the Auditor can change it without anybody editing TypeScript.
 */
export const FREE_STANDALONE_EVENT_TYPE = 'other'

// Client, 20 Jul 2026: the lodges are Regency, Palace and Residency — "Dipali Grand" is not
// one of them. Residency returns here as a LODGING unit only; it is still not a property,
// because the 2026 proposal prices no venue there (see the VENUES note above and
// SEED_ASSUMPTIONS §F1). The old 'Grand / Regency A-block' unit is retired into it, taking
// its two PRD §3.3 rack rates along.
export const LODGING_UNITS = ['Palace', 'Regency', 'Residency'] as const

export type RoomSeed = {
  block: string | null
  roomNo: string
  roomType: string
  beds: number
  rackRatePaise: number
}

/**
 * Palace: 33 Deluxe + 3 Suite = 36 rooms, plus ONE dormitory of 18 beds.
 * Counts and categories confirmed by the client 21 Jul 2026; rates are the hotel's 2026
 * proposal (Palace page): Deluxe Rs. 5,000, Suite Rs. 8,000, Dormitory 18 beds Rs. 35,000.
 *
 * The client was asked directly whether Palace's rooms take the proposal's "Executive
 * Deluxe" Rs. 7,000 — they do not: Palace is priced off its own page. The 36 also settles
 * the earlier "38 rooms" figure, which turned out to be a miscount.
 *
 * The dormitory is one bookable unit at Rs. 35,000. Beds are never selectable.
 * ROOM NUMBERS ARE INTERNAL — rooms are booked in bulk by lodge and category.
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
  { block: 'A', roomNo: 'DORM-A', roomType: 'dormitory', beds: 18, rackRatePaise: rupeesToPaise(35_000) },
]

/**
 * Residency: 29 rooms — 27 Deluxe at Rs. 5,000 + 2 Suite at Rs. 8,000. Confirmed by the
 * client 25 Jul 2026, replacing the earlier assumption (20 Deluxe @ Rs. 7,000 + 8
 * Presidential Suite @ Rs. 11,000). Room numbers stay internal — rooms are booked in bulk by
 * lodge and category. See SEED_ASSUMPTIONS §F1.
 */
export const RESIDENCY_ROOMS: RoomSeed[] = [
  ...Array.from({ length: 27 }, (_, i) => ({
    block: null,
    roomNo: `R${101 + i}`,
    roomType: 'deluxe',
    beds: 2,
    rackRatePaise: rupeesToPaise(5_000),
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    block: null,
    roomNo: `R${201 + i}`,
    roomType: 'suite',
    beds: 2,
    rackRatePaise: rupeesToPaise(8_000),
  })),
]

export const MODULES = [
  'bookings',
  'calendar',
  'menus',
  'menu_master',
  // The venue master (client, 12 Aug 2026): venues, bundles and what each costs per event
  // type. Separate from `menu_master` so it can be granted on its own.
  'venue_master',
  // The lodge master (client, 13 Aug 2026): categories, their room counts and nightly
  // rates. Distinct from `rooms` (who is staying where) and `lodging_calendar` (the day
  // sheet), so a Lodge Manager can run the desk without being able to re-price the hotel.
  'lodge_master',
  'rooms',
  // The lodging calendar is its own module so it can be granted independently of `rooms`
  // (client, 20 Jul 2026: it belongs to the Lodge Manager). Sharing `rooms` meant no
  // permission could show the calendar without also showing the room-by-room board.
  'lodging_calendar',
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
  // Client, 20 Jul 2026: the Lodge Manager's sidebar is the lodging calendar and nothing
  // else, so every grant that would add a tab is revoked. `rooms` stays (their job) and
  // `billing` stays (no tab, but it carries their lock sign-off). Departs from PRD §2.1,
  // which gives them bookings/calendar/approvals — recorded in SEED_ASSUMPTIONS §F6.
  // Higher Authority can now create & continue proposals as well (tester, 23 Jul 2026): view → edit.
  bookings:    { booking_manager: 'edit', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'none' },
  // Client, 21-22 Jul 2026: the Banquet Manager approves nothing and, as of 22 Jul, his
  // whole screen is the 15-day board — Dashboard and Next 15 days, nothing else. `calendar`
  // stays at view because the board reads it; every other read grant is revoked below so the
  // pages actually bounce him, not just hide from the sidebar. `billing` stays for his lock
  // sign-off (no tab). Venue/date/time moves are the Authority's, hence calendar edit there.
  calendar:    { booking_manager: 'view', banquet_manager: 'view', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'view' },
  // The Chef reads menus to price a delicacy request, but never edits a guest's menu.
  menus:       { booking_manager: 'edit', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'view' },
  menu_master: { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'view' },
  venue_master: { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'none' },
  lodge_master: { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'none' },
  rooms:       { booking_manager: 'view', banquet_manager: 'none', lodge_manager: 'edit', maintenance: 'none', higher_authority: 'view', auditor: 'full', chef: 'none' },
  // Lodge Managers only by default. The Auditor keeps `full` because that role IS the
  // permission utility — it grants and revokes for everyone, so locking it out of a module
  // would make the module ungovernable. Anyone else can be granted this from /admin/roles.
  lodging_calendar: { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'view', maintenance: 'none', higher_authority: 'none', auditor: 'full', chef: 'none' },
  maintenance: { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'edit', higher_authority: 'view', auditor: 'full', chef: 'none' },
  // Approvals is a deciders-only screen now (tester, 23 Jul 2026): only the Higher Authority
  // and the Auditor get it. The Booking and Lodge Managers still raise exceptions through their
  // own flows and hear the outcome via notifications and the event's audit trail — but they no
  // longer see the approvals queue itself.
  approvals:   { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'edit', auditor: 'full', chef: 'none' },
  // Booking Manager gains billing edit (client, 25 Jul 2026): he gives per-head discounts on
  // the Payment review; over the 10% cap routes to the Higher Authority.
  billing:     { booking_manager: 'edit', banquet_manager: 'edit', lodge_manager: 'edit', maintenance: 'edit', higher_authority: 'edit', auditor: 'full', chef: 'none' },
  // Roles & Permissions (and the Users screen it shares) is the Auditor's alone (tester,
  // 23 Jul 2026); the Higher Authority no longer sees it.
  roles_users: { booking_manager: 'none', banquet_manager: 'none', lodge_manager: 'none', maintenance: 'none', higher_authority: 'none', auditor: 'full', chef: 'none' },
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
// `loginId` is what the person types to sign in (migration 0027); `mobile` is contact
// information only, and no longer identifies anyone.
export type UserSeed = { fullName: string; loginId: string; mobile: string; email?: string; role: RoleName }

export const USERS: UserSeed[] = [
  { fullName: 'Auditor / Admin', loginId: 'IAUD5533', mobile: '9000000001', email: 'schemekart@gmail.com', role: 'auditor' },
  { fullName: 'Higher Authority 1', loginId: 'HIGHAUTH01', mobile: '9000000002', role: 'higher_authority' },
  { fullName: 'Higher Authority 2', loginId: 'HIGHAUTH02', mobile: '9000000003', role: 'higher_authority' },
  { fullName: 'Lodge Manager — Palace', loginId: 'BANQ.PALACE', mobile: '9000000004', role: 'lodge_manager' },
  { fullName: 'Lodge Manager — Regency', loginId: 'BANQ.REGENCY', mobile: '9000000005', role: 'lodge_manager' },
  { fullName: 'Lodge Manager — Residency', loginId: 'BANQ.RESIDENCY', mobile: '9000000006', role: 'lodge_manager' },
  { fullName: 'Booking Manager 1', loginId: 'Banq.booking01', mobile: '9000000007', role: 'booking_manager' },
  { fullName: 'Booking Manager 2', loginId: 'Banq.booking02', mobile: '9000000008', role: 'booking_manager' },
  { fullName: 'Booking Manager 3', loginId: 'Banq.booking03', mobile: '9000000009', role: 'booking_manager' },
  { fullName: 'Booking Manager 4', loginId: 'Banq.booking04', mobile: '9000000010', role: 'booking_manager' },
  { fullName: 'Booking Manager 5', loginId: 'Banq.booking05', mobile: '9000000011', role: 'booking_manager' },
  // Named by lodge (client, 22 Jul 2026), the same way the Lodge Managers are. Three
  // managers, three lodges. The name is a label — the role is not yet scoped to a lodge;
  // functions live at venues across four properties (Dipali Grand has no matching lodge).
  { fullName: 'Banquet Manager — Palace', loginId: 'Banq.Ground01', mobile: '9000000012', role: 'banquet_manager' },
  { fullName: 'Banquet Manager — Regency', loginId: 'Banq.Ground02', mobile: '9000000013', role: 'banquet_manager' },
  { fullName: 'Banquet Manager — Residency', loginId: 'Banq.Ground03', mobile: '9000000014', role: 'banquet_manager' },
  { fullName: 'Maintenance Lead', loginId: 'Banq.MaintM', mobile: '9000000015', role: 'maintenance' },
  { fullName: 'Head Chef', loginId: 'Banq.Chef', mobile: '9000000016', role: 'chef' },
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
    // FR-7.6: the client's Terms & Conditions (client PDF, 25 Jul 2026), transcribed in
    // lib/terms.ts and printed as the styled annexure after every proposal. This flat
    // snapshot is the record of the terms in force when a bill is drafted.
    value: termsPlainText(),
  },
]
