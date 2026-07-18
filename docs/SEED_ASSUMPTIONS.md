# Seed assumptions & open client questions

Every value in the seed that is **not** sourced from the PRD or the hotel's 2026 venue
proposal, plus every place the source documents contradict each other or themselves.

**Written during M0 (17 July 2026).** Nothing here is a design decision that should
outlive the client's answer — each item names the file to edit when the real data arrives.

Sources, in order of authority:

1. **The hotel's own documents** — `BANQUET MENU WITH VENUE PROPOSAL UPDATE 2026.pdf`
   (venue proposal pp. 1-3, wedding-rate menu pp. 4-16) and `MAIN COURSE 650 - 1250.pdf`
   (base-rate menu). These are the hotel's price lists and they win.
2. **`docs/PRD.md`** — where it summarises the above, it can be wrong (and in §3.1 it was).
3. **Placeholders** — invented here so the system has usable data. All listed below.

---

## A. Invented data (placeholders)

### A1. Regency's 49-room type breakdown — `db/rooms.regency.seed.json`
**Real:** 49 guest rooms; blocks A, B, C; rack rates Deluxe Rs. 4,500 / Semi-suite
Rs. 6,000 / Suite Rs. 7,000 / Dormitory (30 beds) Rs. 50,000.
**Invented:** the 34 deluxe + 11 semi-suite + 4 suite split, the distribution across
A/B/C, every room number, and the dormitory's block.
**Question:** how many of each type, in which block, and what are the real room numbers?
Replace the whole file — nothing else depends on these specific values.

### A2. Palace room numbers — `db/masters.ts` (`PALACE_ROOMS`)
**Real:** 33 Deluxe + 3 Suite = 36 rooms at Rs. 5,000 / Rs. 8,000, plus dormitory blocks
A and B of 18 beds each at Rs. 35,000 (PRD §3.3).
**Invented:** the room numbers (P101-P133, P201-P203). The PRD gives none.

### A3. Golden Hall's capacity — `db/masters.ts` (`VENUES`)
Golden Hall appears **only** on the proposal ("DIAMOND & GOLDEN HALL 25,000/-") and in
no PRD table. Capacity 1-75 is copied from Diamond Hall as a guess.
**Questions:** (a) What is Golden Hall's real capacity? (b) Is Rs. 25,000 for the pair
together or for each hall? (c) Can either hall be booked standalone, and at what rate?

### A4. Saffron Hall & Lawn's capacity — `db/masters.ts`
PRD §3.1 prints "—". Seeded 100-300, **invented outright**. `venues.capacity_min/max`
are NOT NULL so some number had to go in. Affects FR-2.6 pax validation.

### A5. Gulmohar Lawn / Middle Lawn individual capacities — `db/masters.ts`
PRD §3.2 gives only the **combined** 500-1,000. The two must exist as separate venues
because they form the Gulmohar + Middle bundle, and each needs its own capacity.
Invented as 300-600 and 200-400 (summing to the real combined range).

### A6. Rate-card effective date — `db/masters.ts` (`RATE_EFFECTIVE_FROM`)
Set to **2026-01-01**. The proposal is titled "UPDATE 2026" but prints no effective date.
**Question:** from what date do the 2026 rates apply?

### A7. Terms & Conditions text — `db/masters.ts` (`SETTINGS`)
A placeholder string. FR-7.6 requires the hotel's real T&C, appended to every printed
bill above the signature blocks. **Admin must set this before any invoice is finalised.**

### A8. Seeded user identities — `db/masters.ts` (`USERS`)
Names are generic ("Booking Manager 1") and mobiles are sequential 9000000001-15. Only
the Auditor carries a real email. Replace with the hotel's actual staff before go-live.

---

## B. Interpretations

### B1. The two PDFs are one menu at two price points
`MAIN COURSE 650 - 1250.pdf` is the **base** card; the venue-proposal PDF's pp. 4-16 are
the **wedding** card. Item lists are identical; every tier differs by exactly Rs. 50.

This confirms BR-M5 applies uniformly to **all eight tiers**, Breakfast and High Tea
included (Gold 400→450, Platinum 500→550, High Tea Silver 300→350 are printed on p. 16).
So one set of tiers with `base_rate_paise` + `wedding_surcharge_paise`, exactly as
`menu_tier_prices` models it — not two sets of tiers.

Category and item **text** is taken from the base card: the wedding card extracts
without word spacing (`VEGMANCHOWSOUP`). Prices come from both.

### B2. Menu item spelling preserved; category names normalised
Items keep the cards' spelling, typos included: *Desert, Orinental, Woldrop/Woldrof,
Noddle(s), Bombey, Macroni, Seasnol, Hydrabadi, Pan Barffi, Cheese Fiters, Radar Paneer,
Potato and Chick Peace Salad*. They are the hotel's product names and are not mine to
rewrite silently. Cards are ALL CAPS; stored Title Case for display.

Category names **are** normalised (Desert → Dessert, Live Counte → Live Counter, Asst
Indian Bread → Assorted Indian Bread) because they are structural — BR-M2 and BR-M3
match on them.
**Question:** should the item typos be corrected? They will appear on guest-facing
proposals and kitchen day sheets.

### B3. Slash-separated dishes are one item — except three Crown counters
"Paneer Makhani / Handi Paneer" stays one item: the slash offers the kitchen a choice,
not the guest.

**Exception:** Crown's Pickle, Chutney and Papad counters each print a delimited list in
a *single* cell against "(ANY THREE)". Kept whole they would be one item and the pick of
3 could never be satisfied, so they are split (into 6, 7 and 8 items). The chutney cell
also omits the slash between "Amrood ( Seasonal )" and "Aam ( Seasonal )" — read as two.
Applied nowhere else. `db/seed-data.test.ts` fails if any category's pick exceeds its
item count, so this can't regress unnoticed.

### B4. Diamond Live Counter: printed "(ANY FIVE)" over only 4 items ⚠️
Identical in both PDFs — a **source data error**. As printed it is unsatisfiable: no
Diamond menu could ever reach complete, so no Diamond event could pass the lock
checklist (FR-7.1) or be billed. **Seeded as 4** (= all items).
**Question:** is a 5th live-counter item missing from the card, or is the correct pick 4?

### B5. All-included categories → `pick_count = NULL` *(schema amended)*
Assorted Indian Bread, Salad Bar, Accompaniments, Breakfast and High Tea print no
"(ANY N)" — everything is included. `db/schema.sql` was amended (approved) so
`menu_categories.pick_count` and `sub_event_menu_categories.base_pick` are **nullable**;
NULL = all items included. A CHECK forbids NULL + free-increase-eligible.

Behaviour for M4: render read-only with no counter, always count as complete, excluded
from the free-increase rule and GM increase exceptions, copy the full item list into the
snapshot at save time, bill at the tier rate like any other category.

### B6. BR-M2's free increase resolves to five category names
Eligible: **Soup, Veg Appetizer, Veg Starters, Veg Main Course, Salad**.

- **Paneer Main Course is excluded.** BR-M2 says "Main Course"; BR-M3 explicitly names
  paneer as exception-raising. Only *Veg* Main Course is free.
- **The free salad increase exists only on Silver and Gold.** Platinum, Diamond and
  Crown print "SALAD BAR" with no pick — all-included, so there is nothing to increase.
  **Question:** is that intended? A Crown guest cannot use their free increase on salad.

### B7. Permission verbs collapsed onto three actions
PRD §2.1 uses *Approve, Raise, Sign-off, Lock + Bill, Full, Edit*; `perm_action` is only
`view | create_edit | delete`. Mapping used:

| PRD | actions granted |
|---|---|
| View | `view` |
| Create/Edit, Edit, Approve, Raise, Sign-off | `view` + `create_edit` |
| Full, Lock + Bill | `view` + `create_edit` + `delete` |
| — | none |

The difference between *Raise* and *Approve* on the approvals module is a behavioural
rule for M6, not a permission bit. **Question:** should the enum grow an `approve`
action, or is role-based behaviour on top of `create_edit` acceptable?

### B8. Dormitories are one bookable unit, not N beds
Palace dormitory blocks A and B (18 beds, Rs. 35,000) and Regency's (30 beds,
Rs. 50,000) are each **one `rooms` row** with a `beds` count and one rack rate.
**Question:** is the rate per block per night, or per bed? Everything downstream (room
charges, the 35-room BR-L2 threshold) depends on the answer.

### B9. "Diamond & Golden Hall" priced for sangeet/engagement
On the Palace page this row's event-type cell is **blank** — unlike the two Crystal rows,
which say "MAHILA SANGEET/ENGAGEMENT" and "FOR WEDDING". Seeded as sangeet + engagement
per your instruction. Recorded because the cell is genuinely empty, not labelled.

### B10. Saffron Hall & Lawn priced for wedding
Also blank in the event-type column, but sits on the "WEDDING CEREMONY PROPOSAL" page.
Seeded as wedding at Rs. 55,000 (the card notes hall 35,000 / lawn 20,000; seeded as one
venue at the combined rate). **Question:** can the hall and lawn be booked separately?

### B11. The seed writes no audit rows
Bootstrap, not a user write — there is no acting user, and `audit_log.user_id` is NOT
NULL. Every write made *through the app* is audited per CLAUDE.md rule 5. If master-data
seeding must be auditable, the seed needs a system user.

### B12. Grand / Regency A-block seeded with zero rooms
PRD §3.3 gives rates (Executive Deluxe Rs. 7,000, Presidential Suite Rs. 11,000) but
prints "—" for both room count and structure. The unit exists; its inventory does not.
**No rooms can be allocated there until the client supplies the list.** Better an empty
unit than 40 invented rooms.

---

## C. Contradictions found in the source documents

### C1. PRD §3.1 mislabels sangeet/engagement rates as wedding rates ⚠️ *(PRD corrected)*
The proposal prices **Imperial at Rs. 75,000 and Kohinoor at Rs. 55,000 for MAHILA
SANGEET / ENGAGEMENT only**, and weddings via the **Imperial + Kohinoor bundle at
Rs. 1,51,000**. PRD §3.1 listed those same figures under a "Wedding rate" column.

Seeded per the proposal. **PRD §3.1 has been corrected.**

**Open question:** *can Imperial or Kohinoor be booked standalone for a wedding, and at
what rate? The 2026 proposal only prices them for sangeet/engagement (and as a combined
bundle for weddings).* Until answered, a standalone-Imperial wedding has **no rate** and
hits the missing-rate gate.

### C2. Missing rate is a gate, never a zero
A venue + event type with no rate card is **not** free and **not** an error to swallow.
The wizard must show *"No rate defined for this venue for this event type — needs a
manual rate with Higher Authority approval"* and block confirm until a rate card exists
or an Authority-approved manual rate is entered on that sub-event. Never price at 0,
never crash. Currently unpriced: **Upper Hall** and **Utsav Hall** (both "package-based"
in PRD §3.1), and any standalone wedding at Imperial or Kohinoor (C1).

*Implementation owed in M3 (confirm) — recorded here because the seed deliberately
leaves these gaps.*

### C3. No Auditor/Admin user in the provisioning list
PRD §2, CLAUDE.md and BUILD_PLAN all specify 14 users (2 higher authority, 3 lodge, 5
booking, 3 banquet, 1 maintenance) — **none of them an Auditor**, though the role owns
roles/users admin, the event lock and billing (§2.1), and M1's own acceptance test needs
one. **A 15th Auditor/Admin user is seeded.** BUILD_PLAN's "14 users" is now 15.

### C4. Lock sign-off roles disagree three ways — **unresolved, blocks M9**
- PRD §2.1 matrix: Banquet, Lodge, Maintenance **and Higher Authority** sign off;
  Booking Manager is "—".
- FR-7.1: lists only three (Banquet, Lodge, Maintenance).
- `schema.sql`: `signoff_role` is `('banquet_manager','lodge_manager','maintenance','booking_manager')`
  — **includes Booking Manager, omits Higher Authority** — and the lock comment says
  "all four signoffs".

Not touched in M0 (no lock code yet). **Must be resolved before M9.** Recommendation:
follow the §2.1 matrix (Banquet, Lodge, Maintenance, Higher Authority) and amend the enum.

### C5. "Residency" — a fourth property, or a typo?
PRD §1 says three units (Palace, Regency, Dipali Grand). PRD §3.1 puts **Upper Hall**
under "Residency". CLAUDE.md says 4 properties; schema.sql's comment lists
`'Palace','Regency','Dipali Grand','Residency'`. Seeded as a 4th property hosting only
Upper Hall. **Question:** is Residency real, or a typo for Regency?

### C6. Venue rate is snapshotted "at confirm", but pricing must precede confirm
`sub_events.venue_rate_paise` is commented "snapshot from rate card at confirm". But
BR-P1 requires a recorded advance **≥ 25% of `proposal_total_paise` before** confirm —
and the proposal total cannot exist without venue pricing. FR-11.3 compounds it ("the
discounted proposal cannot be confirmed until approved").

The rate must be snapshotted when the proposal is priced, at the latest when the advance
is recorded. **Affects M3.**

### C6b. `venue_rate_cards` has no unique constraint
Nothing at the DB level stops two rate cards for the same venue + event type + effective
date, which would make pricing ambiguous at confirm (C6). The seed works around it by
owning its effective-date slice (delete-then-insert), but a real app inserting rates
through the masters screen (FR-8.3) has no such guard. **Recommend** adding
`UNIQUE NULLS NOT DISTINCT (venue_id, bundle_id, event_type, effective_from)` in a future
migration — `NULLS NOT DISTINCT` because exactly one of venue_id/bundle_id is null per
row. Not done in M0: it is a schema change beyond the approved `pick_count` amendment.

### C7. Tables the API contract needs that schema.sql doesn't have
Not needed for M0; flagged so they aren't discovered mid-milestone.
`change_requests` (FR-1.9, `/change-requests` + `/change-requests/:id/decide` — **M8**);
`notifications` (FR-9.1, `GET /notifications` — **M7/M10**); tax rates per charge head
and the invoice number series (FR-8.3 calls both Admin-editable masters, but
`invoice_lines.gst_rate_bp` defaults to 0 with no master behind it — **M9**); room
occupancy (FR-4.5 wants promised vs allocated vs **occupied**, and nothing records
occupancy — **M5**); OTP/password-reset state (FR-8.2 — **M1**).

### C8. Can one venue host two sub-events on the same day? — ✅ RESOLVED (client)
**Yes**, as long as their time windows don't overlap. The client chose "simple logic —
if time doesn't overlap, booking accepted", with start and end time captured on the form.
The old fixed-slot model (one main booking per venue-day) is withdrawn. Implemented in M2
as `venue_bookings` with a GiST time-range exclusion. See D3.

### C9. How is an overnight function represented? — ✅ RESOLVED (client)
A single sub-event whose `end_time` is at or before its `start_time` runs past midnight;
the service builds its occupancy range as `[event_date + start_time,
event_date + 1 day + end_time)`. No separate carryover row. Implemented in M2. See D3.

---

## D3. Venue clash model changed in M2 (client-directed schema change)

The core clash table was redesigned from a fixed-slot model to a time-overlap model, on
the client's instruction ("simple logic — if time doesn't overlap, booking accepted").
Per CLAUDE.md this schema change was flagged and approved before implementation.

| Before (M0) | After (M2) |
|---|---|
| `venue_slot_bookings (venue_id, slot_date, slot)` PK; `slot_kind` enum (main/carryover) | `venue_bookings (venue_id, sub_event_id, event_id, occupancy tsrange)` with `EXCLUDE USING gist (venue_id WITH =, occupancy WITH &&)` |
| One main booking per venue-day; outgoing event must clear by 11:00 | Any number of non-overlapping windows per venue-day; **back-to-back allowed** (half-open ranges) |
| Overnight = separate carryover row | Overnight = one row; `end_time ≤ start_time` ⇒ window ends next day |

Pre-launch, this was folded into `db/schema.sql` (migration 0001) and the databases were
rebuilt, following the M0 precedent for the `pick_count` amendment rather than layering a
migration 0002. Documents updated to match: `CLAUDE.md` rule 3, PRD FR-2.2 / FR-2.5 /
BR-C1, `API_CONTRACT.md` (`/availability`, `/confirm`), `BUILD_PLAN.md` M2.

**Open sub-question (defaulted):** no turnaround/buffer between back-to-back events — the
client chose pure overlap, so a hall can be handed straight from one event to the next
with no gap. If the hotel later needs cleanup/setup time, add a buffer to the occupancy
range in the booking service.

---

## D4. Menu module design decisions (M4)

Interpretations made while building the menu module, recorded so they can be challenged.

- **Snapshot price is taken effective on the sub-event's date.** `saveSubEventMenu` reads
  `menu_tier_prices` with the latest `effective_from ≤ event_date` — the same rule venue
  rate cards use. A tier with no price effective on that date blocks the save with a clear
  message (never prices at 0), mirroring BR-R1 for venues.
- **A re-save re-snapshots the base data (tier name, price, per-category `base_pick`) from
  the master as of that save, but preserves the increase overlay** (`extra_picks`, the used
  free increase, and any pending exception link) as long as the tier is unchanged. Changing
  the tier resets the overlay. The BR-M1 immutability guarantee holds because a saved menu
  only changes when a user deliberately re-saves — a master edit alone never touches it.
- **`proposal_total_paise` now includes food and add-ons.** It is recomputed as priceable
  venue charges + Σ(pax × per-plate) over saved menus + Σ(qty × rate) over add-ons, on
  confirm and on every menu/add-on change (schema note: "recomputed on every relevant
  change"; pricing.ts M4 note). The 25% advance at confirm therefore covers any menu the
  guest picked before confirming; when menus are deferred (the common case) food is 0 and
  the confirm behaviour is unchanged.
- **An increase on an all-included category (`base_pick = NULL`) is refused outright** —
  every item is already included, so there is nothing to increase (it can't even raise an
  exception). Increases on ineligible pickable categories (paneer, dal, dessert, live
  counter, …) still raise an exception per BR-M3.
- **"Approved increases" do not change the per-plate price.** FR-7.3 lists food as
  "pax × per-plate … plus approved increases and add-ons"; the schema carries no
  incremental per-increase rate, so an increase changes menu *variety* (pick counts), not
  the plate rate. Only add-ons (their own rate) and the tier rate move the food total.

### Schema changes folded into migration 0001 (pre-launch, DBs rebuilt — D3 precedent)

| Change | Why |
|---|---|
| `forbid_locked_menu_write()` trigger on `sub_event_menus`, `_menu_categories`, `_menu_selections`, `sub_event_addons` | The menu tables have no `event_id`, so the existing lock guard couldn't cover them; this companion resolves the event via `sub_event_id`/`menu_id` so "locked means locked" (rule 6) holds at the DB level, backing the service-layer 409. |
| `semc_exception_fk` → `ON DELETE SET NULL` | Lets an exception (or a whole event) be deleted without the snapshot-category link blocking it; the pick is governed by `extra_picks`, not the FK. |

---

## D5. Rooms module design decisions (M5)

- **Per-room discount over the cap is a hard reject, not an exception** ⚠️ *(spec tension)*.
  BUILD_PLAN's M5 acceptance says a Rs.600 discount on a deluxe room is *rejected* and
  Rs.900 on a suite *accepted* — so BR-D1 is implemented as a firm ceiling (Rs.500 / Rs.1,000
  for suites, from the `*_discount_cap_paise` settings). **This is in tension with FR-11.3**,
  which reads "exceeding … any per-room cap auto-raises a Higher Authority exception." The
  milestone's explicit acceptance wins for M5; the combined-10% escalation (BR-D2) and, if the
  client prefers it, an "escalate over-cap room discounts to an exception" path can be layered
  in the M7 discount service. **Open question for the client: is a per-room cap a firm limit
  (reject) or an escalation trigger (exception)?** Recorded, not silently chosen.
- **35+ rooms defers the whole batch** (BR-L2/FR-4.7): reaching the `large_allocation_rooms`
  threshold (existing + requested) raises a `room_allocation_35plus` exception carrying the
  requested allocations in its payload and inserts **nothing** until an Authority approves it
  (application happens in M6). This mirrors the menu-increase deferral (D4).
- **Lawn-wedding Palace preference (BR-L1)** is enforced server-side: an event is a "lawn
  wedding" when its type `is_wedding` and it has a sub-event on a `kind = 'lawn'` venue; a
  non-Palace room then requires an `override_note`. It is not merely a UI hint.
- **Room charges do NOT fold into `proposal_total_paise`.** The proposal stays venue + food +
  add-ons (M4); rooms (count × nights × rate, less per-room discount) flow to the **bill** in
  M9 per FR-4.6. Allocation happens post-confirm, so it never affects the 25% advance gate.
- **The room discount lives on the allocation** (`room_allocations.discount_paise`), not (yet)
  as a `discounts` ledger row. The M7 discount service will sum allocation discounts into the
  combined-10% computation (BR-D2).
- **Allocation requires a confirmed (or later, pre-lock) event.** The Lodge Manager works the
  queue of confirmed events (FR-4.2); allocating against a bare enquiry is refused.

---

## D6. Approvals queue design decisions (M6)

- **"Notify the requester" is the audit log + the approvals list, not a notifications
  table.** FR-6.2 says every decision notifies the requester, but the `notifications` table
  is deferred to M7/M10 (C7). For M6, each decision is audit-logged with the remark, the
  requester can see their decided exceptions via `GET /exceptions?mine=1`, and a **rejected
  menu increase surfaces its remark inline in the menu picker** (the snapshot category keeps
  its `exception_id` link, and `getSubEventMenu` returns the rejected exception's remark).
  In-app/push notification delivery arrives with the notifications table.
- **Deciding is Authority/Auditor-only** — enforced by a role check in the service, not by
  the permission matrix. The `approvals` module grants `create_edit` to booking/banquet/lodge
  managers too (they *raise* exceptions), so "who may raise vs decide" is a behavioural rule
  (already noted in `db/masters.ts`), re-checked here.
- **Reject reverts nothing because nothing was ever committed.** Both deferred flows hold
  their change until approval — a menu increase never bumped `extra_picks`, a 35+ allocation
  inserted no rows — so rejection only records the status + mandatory remark. The menu
  category's link is kept (so the remark shows); a fresh increase request overwrites it.
- **Approve applies atomically inside the decide transaction.** Menu increase → bump
  `extra_picks` (and mark the menu incomplete until the item is picked). 35+ rooms → insert
  the held allocations; if a room was taken while the request was pending, the exclusion
  constraint 409s and the whole decision rolls back (the exception stays pending to retry or
  reject).
- **Approve-with-modification** (FR-6.2): menu → a modified pick delta (`modified.extraPicks`);
  rooms → a chosen subset (`modified.roomIds`). Approve is the delta-of-1 / full-batch case.

---

## D. Amendments made to the specs during M0

| Document | Change | Why |
|---|---|---|
| `db/schema.sql` | `menu_categories.pick_count` and `sub_event_menu_categories.base_pick` made nullable, + CHECKs | All-included categories (B5). Approved. |
| `CLAUDE.md` | "3 bundles" → 4 bundles | Diamond & Golden Hall (A3). The spec follows the hotel's data. |
| `docs/PRD.md` §3.1 | Rates restated per event type | The proposal is authoritative (C1). |
| `docs/PRD.md` FR-1.2, FR-2.5, §4.1 | Calendar shows confirmed→closed only; enquiry-contested state removed | Calendar carries locked-in (confirmed) deals only. **Implemented in M2.** |
| `docs/BUILD_PLAN.md` M0 | "14 users" → 15 | The Auditor (C3). |

---

## D2. How M0 was verified

Verified end to end against a real **Neon Postgres 16.14** (project "Banquet", databases
`neondb` and `dipali_test`): a full `DROP SCHEMA` → `pnpm migrate` → `pnpm seed` rebuild
from empty, and all 43 tests green (26 data-validation + 17 integration). Migration
idempotency, seed idempotency, slot-uniqueness, room-overlap exclusion, audit
immutability, and the per-line money round-trip were all confirmed on the live database.

Before the URL arrived, the same scripts were smoke-tested against a throwaway embedded
Postgres (PGlite over a socket). **The project has no PGlite dependency** — it was a
harness, now retired.

Three real bugs verification caught (all fixed, all now covered by a test):

1. **int8 returned as BigInt**, contradicting `Paise = number` in `lib/money.ts`. Every
   money value would have failed `assertPaise()` and broken invoice arithmetic in M9.
   `db/client.ts` pins int8 → number with a safe-integer guard.
2. **`.env.local` was never read.** `dotenv/config` only loads `.env`, but the project
   convention (and `.env.example`) is `.env.local`. `db/client.ts` now loads both, Next
   precedence order. Without this the scripts could not see the connection string at all.
3. **`venue_rate_cards` doubled on every re-seed.** It was the one table inserted with no
   `ON CONFLICT` and it has no unique key, so a second seed silently duplicated every
   rate card — making a venue's price ambiguous at confirm. The seed now owns that
   effective-date slice (delete-then-insert), and two tests guard it: the idempotency
   check compares *every* master table (it previously checked only `menu_items`, which
   is exactly how this hid), and a check asserts one rate card per venue+type+date.

**Postgres version:** the target is 16 (`CLAUDE.md`); Neon serves 16.14. Matches.

**Performance:** the seed writes ~700 rows. Batched into multi-row inserts it runs in
~15s against a remote database; an earlier per-row version took **3m37s** and tripped
the test hook timeout. Keep inserts batched — `db/seed.ts` says so at the top.

**Still true:** M3's concurrency test ("two parallel confirms, exactly one wins") needs
a real Postgres, which Neon now provides. `DB_POOL_MAX` (default 5) can force a single
connection for an embedded server.

**Connection:** use Neon's **direct** endpoint (no `-pooler`), not the pooled one — the
migration and seed each run as one long transaction, which is not what PgBouncer
transaction-mode pooling is for.

---

## E. Still needed from the client

Ranked by what they block.

| # | Question | Blocks |
|---|---|---|
| 1 | Lock sign-off roles — which of the three conflicting lists? (C4) | M9 |
| 2 | Diamond Live Counter — 5 items, or a pick of 4? (B4) | M4 |
| 3 | Regency's real room breakdown (A1) | M5 |
| 4 | Grand / Regency A-block inventory (B12) | M5 |
| 5 | Dormitory rate — per block or per bed? (B8) | M5, M9 |
| 6 | Standalone Imperial/Kohinoor wedding rate? (C1) | M3 |
| 7 | Golden Hall capacity; 25,000 for the pair or each? (A3) | M3 |
| 8 | Is "Residency" real? (C5) | cosmetic |
| 9 | GST rates per charge head (PRD open question 5) | M9 |
| 10 | Payment reminder schedule (PRD open question 1) | M7 |
| 11 | Correct the menu item typos? (B2) | cosmetic |
| 12 | Turnaround/buffer between back-to-back venue bookings? (D3) — defaulted to none | future |
| 13 | Per-room discount over cap — firm reject or escalate to exception? (D5) — defaulted to reject per M5 acceptance | M7 |

*Resolved since M0: C8/C9 (venue clash model — client chose time-overlap, see D3);
the 11 AM handover exceptions question is moot (the 11 AM rule itself was withdrawn).*
