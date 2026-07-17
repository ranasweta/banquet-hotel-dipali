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

### C8. Can one venue host two sub-events on the same day?
`venue_slot_bookings`'s PK `(venue_id, slot_date, slot)` allows exactly **one** main-slot
booking per venue-day. Haldi 11:00-15:00 and Sangeet 19:00-23:00 in the same hall on the
same date collide — **even within one event**. Intended house rule, or does the slot
model need a third portion? **Blocks M2.**

### C9. How is an overnight function represented?
`sub_events.start_time`/`end_time` are `time` with no date and no CHECK. For a reception
running 20:00-01:00, is the midnight crossing detected by `end_time < start_time` (and
the next day's carryover row auto-inserted), or is the carryover a **separate** sub-event
row? CLAUDE.md's phrase "carryover sub-event ends ≤ 11:00" reads like the latter.
**Blocks M2.**

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
| 2 | Can one venue host two sub-events on the same day? (C8) | **M2** |
| 3 | Overnight sub-events: one row or two? (C9) | **M2** |
| 4 | Diamond Live Counter — 5 items, or a pick of 4? (B4) | M4 |
| 5 | Regency's real room breakdown (A1) | M5 |
| 6 | Grand / Regency A-block inventory (B12) | M5 |
| 7 | Dormitory rate — per block or per bed? (B8) | M5, M9 |
| 8 | Standalone Imperial/Kohinoor wedding rate? (C1) | M3 |
| 9 | Golden Hall capacity; 25,000 for the pair or each? (A3) | M3 |
| 10 | Is "Residency" real? (C5) | cosmetic |
| 11 | GST rates per charge head (PRD open question 5) | M9 |
| 12 | Payment reminder schedule (PRD open question 1) | M7 |
| 13 | 11 AM handover exceptions and who grants them (PRD open question 3) | M2 |
| 14 | Correct the menu item typos? (B2) | cosmetic |
