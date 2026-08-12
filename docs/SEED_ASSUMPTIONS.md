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

## Behavioural amendments after the PRD

### KYC (Aadhaar) is optional — no longer a confirm gate (client, 22 Jul 2026)
The PRD's **FR-1.10** required Aadhaar front + back on file before an enquiry could be
confirmed. Testing showed the images usually arrive *after* the date is held, so the client
asked for KYC to be **skippable, and addable afterwards**. What changed:

- the booking wizard's KYC step no longer blocks moving on (only the proposal must exist);
- `confirmEvent` no longer checks for the images (`lib/confirm.ts`);
- `POST /events/:id/documents` accepts uploads on any live booking, not only an enquiry;
- the booking's detail page gained an Aadhaar upload, so KYC can be completed later.

Aadhaar is still stored encrypted and permission-checked (rule 7) — only the *requirement*
was dropped. If the client later wants it back as a gate, restore the check in `confirmEvent`.

### Rooms follow the event's declared window, not the functions (client, 22 Jul 2026)
Rule 9 originally capped a room's check-out at "the morning after the last **function**".
Testing showed guests stay the whole event even when a function isn't on every day (a 25-27
Jul wedding with one function on the 25th still needs a room to the 27th). So rooms are now
bounded by the proposal's **declared From/To window**, stored on the event as
`planned_from`/`planned_to` (migration **0018**) and set from the wizard's step-1 dates.

- `getEventRoomWindow` and `saveRoomRequirements` clamp against `planned_from`/`planned_to`,
  falling back to the functions' `min/max(event_date)` for a proposal made before this.
- These columns are separate from `first_date`/`last_date` (the functions' span cached for
  the calendar) and are **never** rewritten by confirm.
- **Deploy note:** run `pnpm migrate` against the target DB — the new columns must exist or
  every event-create / room-save query referencing them will error.

---

## A. Invented data (placeholders)

### A1. Regency's 49-room type breakdown — `db/rooms.regency.seed.json`
**Real:** 49 guest rooms; blocks A, B, C; rack rates Deluxe Rs. 4,500 / Semi-suite
Rs. 6,000 / Suite Rs. 7,000 / Dormitory (30 beds) Rs. 50,000.
**Invented:** the 34 deluxe + 11 semi-suite + 4 suite split, the distribution across
A/B/C, every room number, and the dormitory's block.
**Question:** how many of each type, in which block, and what are the real room numbers?
Replace the whole file — nothing else depends on these specific values.

> **Amended 20 Jul 2026 (§F2/F3).** Semi-suite is retired: the split is now 34 deluxe +
> 15 suite, and the Rs. 6,000 rate above is no longer represented anywhere. Regency also
> now holds both dormitory blocks, A and B.

### A2. Palace room numbers — `db/masters.ts` (`PALACE_ROOMS`)
**Real:** 33 Deluxe + 3 Suite = 36 rooms at Rs. 5,000 / Rs. 8,000, plus dormitory blocks
A and B of 18 beds each at Rs. 35,000 (PRD §3.3).
**Invented:** the room numbers (P101-P133, P201-P203). The PRD gives none.

> **Amended 20 Jul 2026 (§F1/F2).** The client puts Palace at 38 rooms with no dormitory.
> Seeded as 35 Deluxe + 3 Suite (P101-P135, P201-P203); the 2 extra deluxe are invented,
> and the dormitory blocks moved to Regency.

### A3. Golden Hall's capacity — `db/masters.ts` (`VENUES`)
Golden Hall appears **only** on the proposal ("DIAMOND & GOLDEN HALL 25,000/-") and in
no PRD table. Capacity 1-75 is copied from Diamond Hall as a guess.
**Questions:** (a) What is Golden Hall's real capacity? (b) Is Rs. 25,000 for the pair
together or for each hall? (c) Can either hall be booked standalone, and at what rate?

### A4. Saffron Hall & Lawn's capacity — `db/masters.ts`
PRD §3.1 prints "—". Seeded 100-300, **invented outright**. `venues.capacity_min/max`
are NOT NULL so some number had to go in. *Resolved 3 Aug 2026:* the client withdrew FR-2.6,
so these invented numbers no longer gate anything — pax is whatever the Booking Manager enters.
The columns remain descriptive only; the answer to A3/A4 is still worth having, but nothing is
blocked while it is missing.

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

> **Superseded 20 Jul 2026 (§F1).** The unit is gone: the client's third lodge is Residency,
> not the Grand. Both rates moved to Residency's 28 rooms — Executive Deluxe becoming plain
> `deluxe` under the four-category rule. If that transfer is wrong, so is Residency.

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

### C5. "Residency" — a fourth property, or a typo? — **RESOLVED 20 Jul 2026**
PRD §1 says three units (Palace, Regency, Dipali Grand). PRD §3.1 puts **Upper Hall**
under "Residency". CLAUDE.md says 4 properties; schema.sql's comment lists
`'Palace','Regency','Dipali Grand','Residency'`. Seeded as a 4th property hosting only
Upper Hall.

**Client's answer:** Residency is real and "Dipali Grand" is not — the lodging units are
Regency, Palace and Residency. Residency has 28 rooms. See F1: whether the Grand's rates
(Executive Deluxe Rs. 7,000, Presidential Suite Rs. 11,000, per B12) transfer to Residency
is still open, and the unit rename is not yet applied to the seed.

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

## D7. Discounts, payments & reminders design decisions (M7)

- **The combined-10% cap (BR-D2) counts room-allocation discounts too.** The effective
  discount total = Σ `room_allocations.discount_paise` (BR-D1-capped at allocation, M5) + Σ
  ledger discounts whose exception is absent or approved. Adding a ledger discount that would
  push the combined total over 10% of the total bill (proposal + rooms, pre-tax — amended
  25 Jul 2026, was venue+food only) is recorded but held behind a pending
  `discount_over_cap` exception; it does not count until approved. **Caveat:** the M5
  allocation path checks only the per-room cap, not the combined 10% — so an allocation
  discount can consume 10% headroom without escalating; the combined check fires when ledger
  discounts are added. Acceptable for now; revisit if allocation discounts grow large.
- **Discounts are per-head percentages (client, 25 Jul 2026).** Heads are menu / venue /
  **room** / overall; a row stores `percent_bp` and its rupee value recomputes live from the
  head's current subtotal, so a pax/room change flows through. Rooms are a normal head now
  (bulk-booked); the old per-room allocation caps (BR-D1) are retired. The Booking Manager
  gains billing `edit` to apply them; over the 10% cap still routes to the Higher Authority.
- **A discount is a rupee amount (4 Aug 2026), not a live percentage** — see §F21, including
  the drift the change introduces and the second cap test at confirm that answers it.
- **Over-cap discount apply/reject reuses the M6 decide path unchanged.** The discount row is
  written immediately with its `exception_id`; approval flips the exception to approved (the
  effective query then counts it — no M6 code needed), rejection leaves it uncounted. Deleting
  a discount also deletes its still-pending exception.
- **Wedding reminder schedule (BR-P2; open question 1 answered 4 Aug 2026):** BM reminded daily
  D-30→D-21, HA added D-20→D-1. **What is chased changed on 4 Aug 2026:** the ask is the gap to
  **50% of the amount payable**, not the whole outstanding balance, and a wedding already at 50%
  generates none. Rows are pre-generated into `payment_reminders` (idempotent on the unique key)
  for every upcoming confirmed wedding still short of the milestone. `/reminders/pending` surfaces rows whose `remind_on ≤ today` and balance is
  still due. The row generator series over integer day-offsets subtracted from `first_date`
  (the date/interval `generate_series` signature does not exist in Postgres).
- **Ledger balance = ~~proposal~~ payable less payments** — corrected 4 Aug 2026. It measured
  `proposal_total_paise`, which is venue+food, so every booking with rooms under-stated its
  balance by the whole lodging charge (§F22). Payable now comes from `lib/payment-schedule.ts`:
  venue + food + add-ons + rooms + the 5% room GST, less discounts. The 18% GST is displayed
  alongside and is in no balance.
- **Cron is a route, not a tsx script.** The lib modules import `server-only`, which a plain
  `tsx` run can't load, so the daily job is `POST /cron/run` (scheduler with a `CRON_SECRET`
  header, or a manual Auditor run). A general in-app **notifications table is still deferred to
  M10** (C7); for now reminders surface via `/reminders/pending` and the dashboard widget.

---

## D8. Maintenance, day sheet & change requests design decisions (M8)

- **New table `change_requests`** (flagged in C7, added now). Post-confirmation edits split
  by FR-1.9: pax / menu / add-ons apply directly (versioned in the audit trail — pax via
  `POST /sub-events/:id/pax`, menu/add-ons via the menu module); date / time / venue file a
  `change_requests` row the Banquet Manager decides. On approval the service re-books the
  venue slot inside one transaction, so the same GiST exclusion decides clashes — an approved
  move 409s cleanly if the slot was taken in the meantime, and nothing changes. Folded into
  migration 0001 and added to the lock-guard trigger list (DBs rebuilt — D3 precedent).
- **Maintenance closure is a `lock_signoffs` row, not a new column.** Closing the section
  (`POST /events/:id/maintenance/close`) sets `is_closed` on every entry AND inserts a
  `lock_signoffs(designation='maintenance')` row — which is exactly the "Maintenance closure"
  lock-checklist sign-off (FR-7.1), so M9's checklist reads it for free. "Is it closed?" =
  that sign-off exists. No schema change needed.
- **Maintenance write window (FR-5.1):** entries are writable only while the event is
  `in_progress` or `completed`, and only before closure. The service refuses outside that
  window (a clean 400/409); the DB lock-guard trigger is the backstop for locked+ states.
  Entries are editable/deletable by their **author or the Auditor** (FR-5.2).
- **Change-request permissions:** raising is `bookings` create_edit (the Booking Manager acts
  for the guest); deciding is `calendar` create_edit — which only the Banquet Manager and
  Auditor hold — matching "Banquet Manager approval" (FR-1.9). A behavioural split expressed
  through two modules rather than a role check.
- **Day sheet** (`GET /calendar/day-sheet/:date`) lists confirmed-and-beyond sub-events on the
  date with their menu snapshot (tier + dishes) and add-ons — it reads snapshots, never the
  master, and is print-styled. Cross-midnight tails are not folded in (kept to `event_date`).

---

## D9. Lock, invoice & audit design decisions (M9)

- **No schema change.** invoices, invoice_lines, lock_signoffs and audit_log already exist.
  GST rates and the invoice-number series are handled without a migration (below).
- **GST rates are placeholder constants** in `lib/invoice.ts` (venue 18%, food 5%, rooms 12%,
  maintenance 18%, adjustment 0%) pending the hotel's tax consultant (PRD open question 5).
  FR-8.3 wants them Admin-editable; making them settings-backed is a small follow-up. **Tax
  is charged per line on the GROSS amount; discounts are a separate deduction, not pro-rated
  into each line's taxable value** — a simplification (real GST discounts before tax) to
  revisit with the consultant.
- **Invoice numbers via an atomic settings counter, not a sequence** (avoids a schema
  change): `INSERT … ('invoice_next_no','1') ON CONFLICT DO UPDATE SET value = value+1
  RETURNING` inside the finalise transaction — the row lock serialises concurrent
  finalisations. Format `INV-2026-0001`. The prefix is a constant; both prefix and the GST
  rates become masters when the client confirms them.
- **Invoice totals** (verified to the paise in tests): gross = Σ line amounts (venue rate
  snapshots + pax×per-plate food + add-ons + nights×rate rooms + closed-maintenance) + Auditor
  adjustment lines; discount = effective discounts (BR-D2); net = gross − discount + Σ line
  tax; advances = payments − refunds; balance = net − advances.
- **Maintenance closure doubles as the maintenance lock sign-off** (set in M8); the checklist
  reads the four sign-offs from `lock_signoffs`. The lodge sign-off is required only when the
  event has rooms; otherwise it auto-passes. Lock is Auditor-only and only from `completed`.
- **Post-lock immutability** rides on what M4–M8 already built: every service's editability
  guard 409s on locked+ states, and the DB lock-guard trigger is the backstop.
- **Audit trail** reads the append-only `audit_log` per event (FR-10), filterable by entity /
  user / date, with CSV export. The log is never mutated (DB-enforced, FR-10.3).

---

## D10. Reports, notifications & hardening design decisions (M10)

- **The six reports (PRD §7)** are read-only aggregations gated on the `audit` module
  (management view — Higher Authority + Auditor). Two are intentionally partial and can be
  deepened once the data supports it: **revenue** attributes venue revenue by property via
  `sub_events.venue_rate_paise` but does not yet break food/rooms revenue down by venue or
  menu tier (the invoice lines don't carry that attribution); **pipeline** reports status
  counts + conversion rate but not "lost-slot analysis" (losing enquiries aren't distinctly
  tracked — a cancelled enquiry is the closest proxy).
- **Notifications are a derived, role-aware feed, not a stored table.** `GET /notifications`
  computes what needs the signed-in user's attention right now — approvals to decide, change
  requests to decide, payment reminders due, stale enquiries — from live data. This satisfies
  FR-9.1 for v1 without a schema change or retrofitting notify() calls into every M4–M9
  service (which would have risked regressions in the final milestone). **Trade-off:** there
  is no per-item read state (an item clears when the underlying thing resolves), and passive
  events (lock executed, bill finalised, slot lost) aren't pushed — they're visible on the
  relevant screen. A persistent `notifications` table with read state and those push events
  (C7's deferral) is the natural follow-up; the derived feed is the honest v1.
- **Login rate limiting** is an in-process fixed-window limiter (10 attempts / 5 min per
  mobile+IP). Multi-instance deployments should move it to Redis (`lib/rate-limit.ts` keeps
  the same interface). Documented in `docs/OPERATIONS.md`.
- **Lighthouse ≥ 90 (acceptance)** could not be run in this environment (no headless Chrome
  audit available here). The screens are built to score well — semantic HTML, explicit
  loading/empty/error states, wide content in `overflow-x-auto` so the page body never scrolls
  horizontally — and the target is tablet-first per NFR-1 (the fixed sidebar suits a 10-inch
  screen; a collapsing sidebar for phones is a later enhancement). **Run Lighthouse manually
  against the deployed build to confirm the ≥ 90 target.**

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

## F. Lodging model — client instructions, 20 July 2026

From the client's conversation with the hotel. **F1–F3 are applied to the seed** at the
client's explicit instruction (20 Jul: "add the residency and do what's needed"), on the
understanding that the real category-wise room and price list follows shortly and replaces
all of it. Everything invented in the process is flagged below and in the seed files
themselves. The lodging calendar reads room categories from `rooms.room_type` at query time,
so the incoming list needs no code change — only new data.

**The cost of applying early:** two rates that used to be sourced are now invented (F3), and
one dormitory block's shape is a guess (F2). Both were unavoidable once the categories were
collapsed and the dormitories moved; neither can be checked without the client's list.

### F1. Lodging units are Regency, Palace, Residency
Resolves C5. Regency 49 rooms, Palace **38**, Residency 28. PRD §3.3 gives Palace as 36
(33 deluxe + 3 suite) — **two rooms unaccounted for**. The earlier reading that 38 = 36
rooms + 2 dormitory blocks dies with F2, which moves the dormitories out of Palace.
**Seeded:** `LODGING_UNITS = ['Palace','Regency','Residency']` — the old
`'Grand / Regency A-block'` unit is retired into Residency and its two PRD §3.3 rates carried
over (B12). Palace is 35 deluxe + 3 suite = 38, the 2 extra deluxe invented to reach the
client's count. Residency is **27 deluxe @ Rs. 5,000 + 2 suite @ Rs. 8,000 = 29**, confirmed
by the client 25 Jul 2026 (migration 0021). This supersedes the earlier assumption — 20
deluxe @ Rs. 7,000 + 8 presidential @ Rs. 11,000 = 28, whose split, room numbers and
B12-inherited rates were all invented.

Note Residency returns as a **lodging unit only**, not a property: the 2026 proposal still
prices no venue there, so the 19 Jul removal of Upper Hall and the Residency *property*
stands. `PROPERTIES` is unchanged and Dipali Grand remains a venue property (Signature,
Lotus Lawn, both really priced on proposal p. 3).

**Questions:** where are Palace's other 2 rooms? (The Grand-rates question for Residency is
**resolved** — the client supplied its own 27/2 split and Rs. 5,000 / 8,000 rates, 25 Jul 2026.)

### F2. Dormitories are in Regency, blocks A and B — contradicts PRD §3.3
The client states the dormitory is in Regency across blocks A and B. PRD §3.3 says the
opposite: Palace holds dorm blocks A and B (18 beds, Rs. 35,000 each) and Regency holds a
single 30-bed dorm (Rs. 50,000). The client's instruction wins per CLAUDE.md's source
ranking, but this is a **direct contradiction of the PRD, recorded rather than silently
applied**.

**Seeded:** Regency holds `DORM-A` (block A, 30 beds, Rs. 50,000 — its own, real) and
`DORM-B` (block B, 18 beds, Rs. 35,000 — Palace's, relocated). Palace has none. This keeps
**both** real dormitory rates alive while giving the two blocks the client named; the cost
is that **which block is which size is invented**, and Palace's *second* 18-bed block is
dropped, since the client described exactly two. **Question:** is that the right shape, or
are both Regency blocks the same size?

### F3. Four room categories — semi-suite and executive deluxe are dropped
The client's categories are **deluxe, suite, presidential suite, dormitory**. Semi-suite
folds into suite; executive deluxe folds into deluxe.

This **destroys real price data**, which is why it is not yet applied. Semi-suite
(Rs. 6,000, real per A1) and Executive Deluxe (Rs. 7,000, real per B12) are rates attached
to the categories being removed. Merging reprices those rooms to the target category's rate
— Regency suite Rs. 7,000 and Regency deluxe Rs. 4,500 — so eleven rooms move Rs. 1,000 up
and the A-block's deluxe rooms move Rs. 2,500 down, and both figures become **invented where
they were previously sourced**. The merge also widens BR-D1's per-room discount cap on those
11 rooms from Rs. 500 to Rs. 1,000, because the suite cap follows the category name.

**Seeded:** Regency is now 34 deluxe + 15 suite = 49 (was 34 + 11 semi-suite + 4 suite), the
11 former semi-suites repriced to Rs. 7,000. Executive Deluxe needed no merge — the Grand
had zero rooms (B12); Residency's deluxe once inherited its Rs. 7,000 but is now the
client-confirmed Rs. 5,000 (see F1, 25 Jul 2026). `db/seed-data.test.ts` now asserts
semi-suite is gone rather than asserting its rate. **Question:** confirm the merged rates,
or supply the real ones (expected with F1's list).

### F4. The lodging calendar reads locked, not confirmed — with an amber middle state
The client chose **red at lock**, not at confirm. Taken alone that hides sold inventory: an
event can be confirmed (25% advance recorded, venue held) and still paint its rooms green
until the lock checklist completes. The calendar therefore carries three states, not two —
red locked, **amber confirmed-but-unlocked**, green free — so the client's choice stands
without the Lodge Manager being able to promise a room twice.

Amber also covers rooms inside an undecided 35+ exception (BR-L2), which by design write
nothing to `room_allocations`; a calendar reading only that table would show them free while
the Authority is still deciding.

### F5. The lodging window is 30 days, the venue board's is 15
FR-2.1 caps the venue calendar to a rolling 15 days for operational roles. The client asked
for 30 days of lodging. Implemented as 30 for everyone with `rooms:view` — not role-capped,
unlike `/calendar` — with a 92-day hard ceiling on the query as a guard, not a permission.
**Amended 20 Jul 2026:** the venue board's own cap now applies to the **Banquet Manager
only**. `/calendar` previously capped every role except Auditor and Higher Authority, which
over-read FR-2.1 — PRD §2 assigns the 15-day operational view specifically to the Banquet
Manager, who owns that calendar. A Booking Manager quoting dates needs to see as far ahead
as a guest might ask, so they are now uncapped (client instruction). `CAPPED_ROLES` in
`app/api/v1/calendar/route.ts` is the single place to change this.

This also settles the Lodge Manager question: no, their 30-day lodging window is not capped.

### F6. The Lodge Manager's sidebar is the lodging calendar alone — departs from PRD §2.1
PRD §2.1's matrix gives the Lodge Manager `bookings: view`, `calendar: view`, `rooms: edit`,
`approvals: edit`, `billing: edit`. The client wants their sidebar trimmed to the lodging
calendar and nothing else (20 Jul 2026), so `bookings`, `calendar` and `approvals` are
revoked in `MATRIX` (`db/masters.ts`) and by migration `0006`.

**Two things this uncovered.** First, the live database had the Lodge Manager on *only*
`calendar: view` — no `rooms` grant at all, so the module built for that role was invisible
to it and `/rooms/calendar` would have bounced them. That is not what the seed says; the
grants had drifted, most likely edited through `/admin/roles`. Migration 0006 restores
`rooms` (view + create_edit) as well as trimming.

**`billing` is deliberately kept** even though the client asked for "only the lodging
calendar": it puts no tab in the sidebar, but it carries the Lodge Manager's lock sign-off.
Revoking it would have removed capability without changing anything they can see.

**`approvals: view` restored** (client, same day, migration `0007`). Revoking it left the
Lodge Manager able to raise a 35+ room exception (BR-L2) but unable to see the decision.
`view`, not the matrix's `edit` — deciding one is the Higher Authority's call.

### F7. `lodging_calendar` is its own module
The calendar originally shared the `rooms` module with the room-by-room board, which made
the client's "lodge calendar should be shown to lodge managers only" impossible to express:
one grant drove both screens. It is now a module of its own (`MODULES` in `db/masters.ts`,
registered by migration `0007`), granted by default to **lodge_manager and auditor only**.

This keeps access **utility-based**, as PRD §2.1 requires: nothing is hardcoded to a role
name: an Admin can grant `lodging_calendar` to anyone from `/admin/roles`, and both API
routes enforce `requirePermission('lodging_calendar','view')` server-side. The Auditor keeps
`full` because that role *is* the permission utility — locking it out of a module would
leave the module ungovernable.

**Residual, flagged to the client:** the Lodge Manager still sees a **Rooms** tab, because
allocating rooms (FR-4.2) needs `rooms: view` — the allocation screen reads
`/rooms/units` and `/rooms/board`. Revoking it to hide the tab would break their core job.
**Question:** leave the Rooms tab, or hide it another way?

### F8. Two GSTs — rooms 5% collected, 18% shown and not collected
**Amended 4 Aug 2026 (client's lead), superseding the 20 Jul ruling below.** GST is now
charged at **18% on venue, food, add-ons and maintenance** and **5% on rooms** — but only the
5% is money. The 18% is printed on the document and taken from nobody: *"at the end we are
just showing we are taking 18% gst but we wont be taking it."*

That distinction is the whole of the design:

| | Rate | Printed | Collected | In the 25% / 50% / cap bases |
|---|---|---|---|---|
| Rooms | 5% | yes | **yes** | **yes** (the 5%; see §F10) |
| Venue, food, add-ons, maintenance | 18% | yes | **no** | no |

So every money view carries **two** totals — `Total` and `Amount payable` — and shows both.
A single headline figure is how a counter collects 18% too much. In the data:
`invoices.tax_paise` keeps its meaning (collected tax, inside `net_paise` and therefore inside
`balance_paise`) and the 18% goes to `invoices.shown_tax_paise` (migration 0026), which feeds
only the printed total. Had the 18% gone into `net_paise`, `balance = net − advances` could
never reach zero and no booking could be settled or closed. `lib/tax.ts` owns the rates and the
collected/shown split, **by section** — rooms collected, everything else shown — so the bill,
the proposal, the quote, the reports and the payment thresholds cannot disagree.

**FLAGGED TO THE CLIENT, NOT SETTLED.** Printing a GST line on a guest-facing document for tax
that is not being charged or remitted is a question for the hotel's CA, not for this codebase:
a guest could reasonably read that line as tax paid. It was raised explicitly at the time and
implemented as instructed. **One sample bill should go in front of the hotel's Auditor before a
real guest sees one.** If the answer comes back differently, the fix is small and local: either
drop `STANDARD_GST_BP` to 0 in `lib/tax.ts`, or keep the figure on internal views and omit the
line from `components/invoice-print.tsx`.

*Superseded, kept for the record:* on 20 Jul 2026 the client instructed that **only rooms are
taxed, at 5%**, with venue, food and maintenance zero-rated — replacing the placeholder rates
of `venue 18% / food 5% / rooms 12% / maintenance 18%`. Zero-rating banquet food and venue hire
is unusual enough that it was queried and **confirmed a second time on 20 Jul**. The 4 Aug
instruction reinstates an 18% on those heads for display only, so the money collected is the
same as it was under the 20 Jul rule — the change is entirely to what the document says.

Tax is rounded **per line** and summed; the sum of line taxes is the authoritative figure, not
a percentage of a sub-total (the two can differ by a paisa). `tests/m9.integration.test.ts`
re-computes the whole bill by hand against the current rates.

### F9. "Invoice" and "final" are banned words — the documents are Draft and Draft 2
House terminology (client, 20 Jul 2026). There are exactly two documents:

- **Draft** — the tentative statement. Amounts still move. No document number.
- **Draft 2** — the money actually to be paid. Issued once, then locked.

Neither may be called an invoice, and **nothing may be called "final"**, even though Draft 2
is functionally the final figure. The mechanism is unchanged — issuing Draft 2 is the old
finalisation step: it assigns a number and moves the event to `billed`.

The client confirmed **code names may stay**, so the `invoices` / `invoice_lines` tables and
`lib/invoice.ts` keep their names; only what a human reads changed. Two consequences worth
knowing: the document-number prefix changed from `INV-2026-` to **`D2-2026-`** (the old one
put the banned word in front of the guest), and the on-screen panel is now **Payment review**.
The word "proforma" was also retired from the UI under the same rule — the tentative print is
simply the Draft — though the route and function names still use it internally.

### F10. Room tax shows live, and counts toward the advance base
The 5% is shown on the wizard's Rooms step the moment requirements are entered, computed
per line and summed exactly as `lib/invoice.ts` does it, so the estimate and the Draft can
never disagree by a rounding paisa.

**Rooms and their tax DO count toward the 25% advance** (client, 20 Jul 2026) — an amendment
to BR-P1, which previously measured 25% of `proposal_total_paise` alone.

Implemented as a separate `advanceBase = proposal_total + rooms + room tax` rather than by
folding rooms into `proposal_total_paise`. That column is **also** what BR-D2 measures its
10% combined-discount cap against, so widening it would have quietly raised the discount
ceiling on every event — a side effect nobody asked for. The stored proposal total is
therefore unchanged; only the advance gate sees the bigger number.

The room figure uses `min(rack_rate_paise)` per type across units — the same basis the wizard
shows — because at proposal time no unit has been chosen.

**Amended 4 Aug 2026.** The 5% stays in the advance base, confirmed explicitly by the client's
lead when the 18% was introduced ("yes yes 5% one will stay in 25% one"). So the base is
unchanged: `payable = proposal_total + rooms + room tax − discounts`, and the new 18% never
enters it. The recommendation at the time was to drop **all** tax from every threshold for a
rule anyone could state in a sentence; the client kept the 5%, and the 20 Jul instruction
stands as written.

The single implementation moved from `lib/pricing.ts:roomEstimatePaise` to
`lib/payment-schedule.ts:payableBreakdown`, which is now what the quote endpoint, the confirm
gate, the ledger, the wedding reminders and the calendar's Downpayment-due marker all read, so
the number quoted and the number enforced cannot drift. `roomEstimatePaise` remains as the
wizard's live rooms-only estimate and computes the tax identically — rounded per line, then
summed.

### F11. Two free dishes per function, and increases batch per proposal
Client, 20 Jul 2026. Two amendments to the menu-increase rules:

**BR-M2 — the free allowance is 2, not 1.** `FREE_INCREASE_MAX` in `lib/menus.ts` is now 2:
pressing increase on an eligible category grants two extra dishes with no Authority
involvement. Scope is unchanged — **per function** (per sub-event), on one eligible
category — confirmed by the client rather than assumed.

**BR-M3 — one request per proposal, not per segment.** Increases beyond the free allowance
are unlimited: the manager keeps picking, and every increment lands in a single pending
`menu_increase` exception for the whole proposal. Its payload is
`{ items: [{ subEventId, subEventName, menuId, categoryName, currentPick, requestedPick, reason }] }`,
so the Authority sees which function and which segment each increment belongs to. Pressing
the same segment twice raises that segment's ask rather than adding a row.

Previously each segment raised its own exception, which is why a single wedding could put
five rows in the queue. FR-3.7 needed no change: lock is still blocked while any exception
is pending, so approving the one batch releases the lock.

`db/migrations/0008` rewrites **pending** requests from the old single-segment payload into
the new batch shape — without it the new apply path could not read them and the Authority
would be unable to approve work already in flight. Decided requests are left untouched:
nothing re-reads their payload, and rewriting history to suit new code is worse than
leaving it honest.

### F12. Discounts live on Payment review
Moved out of the Billing section into Payment review (`components/event-discounts.tsx`),
where the money is actually read. **The 10% combined cap is unchanged** (BR-D2), including
the fact that it is measured against `proposal_total_paise` — which excludes rooms by
design (§F10). On a proposal with heavy lodging the cap therefore applies to the smaller
number; the client was asked and chose to keep it as is.

### F13. Rooms are capped by real inventory, and by the event's own dates
Client, 21 Jul 2026. Two bounds now sit on a room line, and they are different things:

**The hard cap.** A lodge cannot sell a category it does not have. `getRoomAvailability`
(`lib/rooms.ts`) measures each requested line against `rooms` for that unit and category,
and refuses a save that exceeds it. It is measured **per night and reported at the tightest
one** — a 1–5 Jul stay where nights 1–2 have 20 of 27 taken and night 3 has 25 has two rooms
free, not seven. Quoting the average would promise a room that vanishes mid-stay.

**The 35+ rule (BR-L2) is unchanged and is NOT a limit.** It is an Authority approval. The
two stack: 40 rooms when 27 exist is blocked outright; 36 rooms that do exist are allowed
and escalated.

**Enquiries hold nothing.** Only committed events (`confirmed` and beyond) count against
inventory, so two managers may both be drafting the same rooms and whoever confirms first
takes them. The client was explicit: no soft reservations, and the loser is *notified* to
change dates, category or lodge rather than being blocked in advance.

**The notification.** `listRoomShortfalls` (`lib/rooms.ts`) finds every live proposal whose
rooms can no longer be honoured, and `lib/notifications.ts` turns each into a feed entry:
*"Rooms no longer free — E-1042: 7 of 10 Palace deluxe (10 Oct to 12 Oct). Change the dates,
category or lodge."*

It is **derived, never stored**, like the rest of the feed: a shortfall stops existing the
moment the booking is trimmed, so the notice clears itself and there is no row to clean up.
Scoped the way every other queue is — the proposal's owner hears about their own, a Lodge
Manager about their own lodge, the Auditor about all of it. A Lodge Manager with no lodge
assigned is given nothing rather than everything.

It catches two cases, not one: rooms taken by an event that committed later, and a room
**retired** under a booking that was sound when it was made — which no save-time check can
ever prevent.

**Room dates are bounded by the event.** Check-in may not precede the first function's date,
and check-out may reach at most the morning after the last — read from `sub_events`, never
from the `events.first_date` cache, which is only written at confirm and is NULL while a
proposal is still being built.

**Reconciliation was rewritten to match.** It compared `room_requirements` against
`room_allocations` — promised vs assigned — and since nothing has written an allocation since
migration 0009, every event reported `allocated = 0` and a variance of `-promised`. The Lodge
Manager's sign-off blocks the lock, so it was gating on a figure that was wrong by
construction. It now answers *can the lodge deliver what was sold?*: promised, capacity, the
peak held by other committed events, and the shortfall — with `deliverable` as the boolean the
sign-off actually attests to. The hard cap stops an overbooking at save time; this is the
re-check at lock, when the answer can have changed.

### F14. A Lodge Manager sees one lodge
Client, 21 Jul 2026: "the palace lodge manager should see palace data only". `users.lodging_unit_id`
(migration 0013) carries it, and `lodgeScopeFor` in `lib/auth.ts` applies it to the lodging
calendar and its day drill-down. The inventory itself stays **single and shared** — only the
read is filtered.

**NULL is a loud failure, not a wildcard.** A Lodge Manager with no lodge assigned gets a 403
telling them to ask an Admin, rather than silently widening to all three. Every other role is
unscoped. The seed matches managers to lodges by the name in their title.

### F15. Increases unlock a segment; the GM hears per function
Client, 21 Jul 2026. This **supersedes F11's second half** and the lock-time batching of
migration 0008.

**Increase is not "+1" — it unlocks.** Pressing it on a segment lifts that segment's ceiling
entirely; from there the manager takes as many dishes as the guest wants. Everything above
`base_pick` is an extra.

**Extras are dishes, not a count.** `sub_event_menu_selections.is_extra` (migration 0013)
records which ones, so the picker can colour them apart and the Authority decides on
"two more starters: paneer tikka, galouti" rather than on "+2 on segment 3". This also
retires the old partial-approval behaviour of dropping dishes in **alphabetical** order,
which deleted a guest's choice at random because the snapshot could not say which picks
were the additions.

Which dishes are extras is decided **positionally** — the tail of the selection array, in
click order. Selections carry no insertion timestamp, so the read path returns base picks
first and extras after, and that ordering *is* the record.

**Two free per FUNCTION, not per segment.** Asked explicitly. Per segment was rejected: a
four-function wedding with five unlocked segments each would give away forty dishes unseen.
The allowance is derived at read time as `min(2, total extras on the sub-event)` rather than
stored, so removing an extra hands it back automatically.

**Submission is per function, on a button.** Modelled on the chef delicacy request and
pre-filled with what has been ticked. `submitted_extra_picks` is the high-water mark, so
pressing it again after adding more dishes sends only what is new. Increases no longer reach
the GM at the lock; instead the lock checklist gains a blocking item — *every menu increase
sent to the Higher Authority* — because an unsubmitted extra is a dish the guest is getting
that nobody sanctioned. It is not auto-sent: pressing submit is the manager's call, and the
Authority should not receive a request nobody chose to make.

### F16. The Banquet Manager reads; the Authority decides
Client, 21 Jul 2026: "the banquet manager does not need to approve anything he will just see
which event when how many people and what is the menu". Venue/date/time change requests pass
to the Higher Authority (`lib/change-requests.ts` `DECIDER_ROLES`), and migration 0014 moves
`calendar:create_edit` and `approvals:create_edit` accordingly.

**One grant deliberately NOT revoked: `billing:create_edit`.** It carries his day-sheet
sign-off, which is an attestation that he has read the sheet rather than an approval of
anything — and it is a blocking lock item, so dropping it would stop every event from
locking. Flagged rather than assumed either way; see question 14 below.

His screen is the new 15-day operations board (`/day-sheet`), which finally gives the day
sheet the page `docs/UI_BRIEF.md` always specified and the lock checklist always referred to.
It carries **no money at all**, and that is enforced at the query in `lib/daysheet.ts`, not by
hiding fields in the UI — the payload is served to roles with no billing grant, so a per-plate
rate travelling to the browser and being styled away would be a leak with a stylesheet in
front of it. The Chef reads the same board for a single day.

### F17. The lifecycle had no way to advance
Not a client instruction — a defect found while mapping the system on 21 Jul 2026.

`transitionEvent` declared eleven legal moves and only five had a caller: **nothing anywhere
wrote `in_progress` or `completed`**. Since `lockEvent` requires `completed`, sign-offs require
`in_progress`/`completed`, and the maintenance module only lists events in those states, the
entire back half of the product was unreachable — an event could be confirmed and then never
change again. No event could be locked, invoiced or billed.

`advanceEventStatuses` (`lib/events.ts`), run by the daily cron, closes it: an event starts
when its first function's date arrives and completes once the last has passed. It catches up
in a single pass when the job has not run for days, and it reads dates from `sub_events`
rather than the `first_date` cache. PRD §4.1 always implied this ("In Progress: event dates
have begun"); nothing had implemented it.

### F18. `menu_master` finally does something
Built 21 Jul 2026 on the client's request for "a master menu for the auditor... in case any
menu changes in future, prices of per plate changes".

The module was in the permission matrix from the start, seeded to four roles, and
`requirePermission('menu_master', …)` appeared **nowhere in the codebase** — granting it was
a no-op. `/admin/menus` and the `/menu/master/*` routes are its first enforcement sites.

**Re-pricing never re-prices a booked event**, and two existing mechanisms already
guaranteed it — this screen only had to avoid breaking them:
- `menu_tier_prices` is effective-dated on `(tier_id, effective_from)`, so a new price is a
  new ROW. History survives, and an old bill can still be explained.
- `saveSubEventMenu` snapshots the rate onto the sub-event and reads it effective on the
  **sub-event's own date** — so a rate dated 1 April prices April's weddings and leaves
  March's alone, with nobody having to time the edit.

The screen states the consequence out loud before the change is made (`priceChangeImpact`)
rather than leaving a manager to discover it on a bill.

**Dishes are retired, not deleted.** Snapshots copy dishes by name, so deleting one would
not corrupt a booked menu — but it would erase the dish from the pooled Swap list every
other tier draws on, with no undo. Segments *can* be deleted, because an empty segment on a
printed card is a mistake rather than history — and that delete is gated on
`menu_master:delete`, which makes it **the only place in the system where the `delete`
action means anything**. Every other DELETE route still asks for `create_edit`.

### F19. The Banquet Manager is the 15-day board, scoped to their own venues
Client, 22 Jul 2026: "for banquet manager only keep next 15 days and dashboard, that's it,
nothing more. also name each banquet manager with their respective lodge... only their lodge,
regency is the dipali grand."

**Sidebar (migration 0016).** Trimmed to Dashboard + Next 15 days. Every read grant that only
gave a tab (bookings, menus, menu_master, rooms, maintenance, approvals) is revoked so the
pages bounce him. `calendar` stays (the board reads it), `billing` stays (his lock sign-off,
no tab). The three tabs `calendar` drives are hidden by a role allowlist in the nav, since
permission alone cannot split them.

**Names (migration 0016).** Banquet Manager — Palace / Regency / Residency, mirroring the
Lodge Managers.

**Scope (migration 0017).** Each manager's board shows only functions at venues they own.
The link lives on `properties.banquet_manager_id`, not on the user, because one manager owns
several — Regency covers Dipali Grand ("regency is the dipali grand"). A bundle that spans
properties shows to every owner of a member venue.

**The Residency wrinkle, unresolved.** There are three banquet PROPERTIES — Palace, Regency,
Dipali Grand — and no Residency property (Residency is lodging only, rooms with no venues).
So the Residency banquet manager owns nothing and sees an empty board. The mechanism is
correct; the inventory has no venues for that manager. Open: is a Residency banquet manager
wanted at all, or should that seat map to a property, or will Residency venues be added? The
name and the empty board stand until the client says.

### F20. A part payment holds the dates — "Downpayment due"
Client's lead, 4 Aug 2026. BR-P1 used to refuse a confirmation below 25% with a 402 and leave
the dates open to anyone. The hotel's own answer: *"sometime people come with variable money…
25% was 3 lakh and they gave 1 lakh for now we cant let them go so what our team decided is
lets take that money and on the calendar lets mark it downpayment due."*

**Implemented without a new status.** The booking confirms normally and inserts its
`venue_bookings` rows, so the GiST exclusion protects the slot exactly as it does for a fully
paid booking — which is the entire point of not letting the guest go. "Partially locked" is a
**derived** state: `advanceShortfallPaise > 0`. The alternative, a real `provisional` status,
would have meant touching every `status IN ('confirmed', …)` query in the codebase —
availability, day sheet, reports, approvals, maintenance, the cron advancer, the payment guard —
where missing one would make a paid booking vanish from the day sheet or read as free.

What is still refused is a hold for nothing: an advance of zero, or one with no receipt number.

**No timer, no exception, no promised-by date.** The client was asked how long before the GM is
told and answered with a mechanism rather than a duration: the marker sits on the calendar, and
when a second guest wants the same venue the Booking Manager sees it, rings the GM, and they
settle it with the guest's details in hand. So the escalation is **contention-driven**, and the
design has no cron, no `overdue_advance` exception kind and no extra column. The GM's cancel
authority already existed (`lib/events.ts:cancelEvent`, pre-lock, releases venues and rooms);
what was missing was the trigger, and the trigger is a person looking at a calendar.

The chip is rose (amber already means carryover) and always carries the words *Downpayment
due* — colour is never the only signal. The day panel adds the shortfall and the guest's
primary number, and that number is sent **only** for short bookings: everyone with
`calendar: view` opens that board, including the Banquet Manager, and a paid-up guest's phone
number has no business travelling to a screen with no use for it.

### F21. A discount is money now, and what that costs
Client's lead, 4 Aug 2026, reversing the 25 Jul percentage-of-a-head input. The manager types
rupees; the guest gets exactly that; the percentage survives only as the arithmetic BR-D2's cap
is tested in — *"in the backend it will see it as percentage only that 10% increment cap"*.

No schema change: `discounts.amount_paise` was always the stored value and `percent_bp IS NULL`
already meant "fixed". Rows written before today keep recomputing live, so existing bookings are
undisturbed.

**The cost, stated plainly.** A percentage shrank with the bill and so could never drift over
the cap on its own. A frozen rupee figure can: give ₹50,000 on a ₹6,00,000 bill (8.3%), then
remove a function and the bill falls to ₹4,00,000 — the same ₹50,000 is now 12.5% and nothing
notices, because the cap was only ever tested at entry. `confirmEvent` therefore applies
`discountCap` a second time, at the last gate before the money is committed, and refuses with a
message naming the new combined figure. It does not bind the Higher Authority, here as anywhere
(FR-11.3a).

The panel states headroom in rupees — "₹42,000 left" — because that is the unit the manager is
now working in.

### F22. Milestones are floors, and the ledger used to be wrong
Client's lead, 4 Aug 2026: weddings top up to **50% of the amount payable** by D-30 rather than
clearing the whole remaining 75%, and *"payment logs should be maintained so that whenever they
reopen the proposal they can get how much is due"*.

Each milestone is a floor on the **cumulative** total received, not an instalment of its own:
25% at confirm, 50% at D-30 for weddings, 100% at billing. A guest who pays 60% up front has met
the wedding milestone and owes nothing at D-30. Over-payment is never refused.

**Two live bugs surfaced while wiring this and are fixed by it.** Both `payments.getLedger` and
`reminders.outstandingPaise` measured `proposal_total_paise` — venue and food — and nothing else.
Rooms live outside that column by design (§F10), so **every booking with lodging under-stated its
balance by the entire room charge**: a guest with thirty rooms could be told they were square
while owing lakhs, and wedding reminders stopped chasing early for the same reason. The reminder
query also summed `discounts.amount_paise` raw, ignoring live percentage rows, pulling the figure
a second way. All of it now reads `lib/payment-schedule.ts`, which is also what confirm, the
quote and the calendar read.

Reminder dates moved from `events.first_date` to `min(sub_events.event_date)`: `first_date` is a
cache written at confirm and can be NULL or stale after a function moves.

### F23. No pax limit anywhere
Client's lead, 4 Aug 2026 — *"compleetely remove any pax llimit from everywhere"* — completing
the 3 Aug removal of the venue-capacity cap. Gone: the `.max(100000)` ceilings in the sub-event
and pax-change routes, and `pax_override_note`, which existed to explain exceeding a capacity
there is no longer any of. A positive whole number is a type check, not a limit.

The `sub_events.pax_override_note` **column is kept** though nothing reads or writes it: it holds
real notes on old bookings, and dropping it would delete them. `venues.capacity_min/max` likewise
survive as descriptive inventory (useful to a salesperson: "Kohinoor seats 150–250") and gate
nothing. Both are dead weight to be removed only on the client's word.

### F24. The bar — priced brands, ordered by the bottle
Client, 12 Aug 2026. A booking may take alcohol: the Auditor keeps a list of brands and what one
bottle costs (a **Bar** tab beside the menu tiers, same `menu_master` permission), and whoever
builds the proposal picks a brand and a number of bottles **on the function that wants it** —
the client's own choice of level, and the one the bill already groups by. Migration 0028.

**No brands are seeded.** The hotel's PDFs price no alcohol, so every brand here would be
invented, and a made-up liquor rate card is exactly what this document exists to prevent. The
list starts empty and the Auditor fills it. Nothing breaks meanwhile: a function with no bar
lines charges nothing, and the Alcohol panel says where the prices come from.

**Two questions for the client / the hotel's CA, implemented as instructed and recorded rather
than decided here:**

1. **The 18% GST label.** Asked how alcohol should be taxed, the client chose "same as food" —
   18%, printed on the Total and collected from nobody (§F8). The money is therefore right by
   construction: a bar line enters no threshold, no balance and no discount cap beyond what
   `proposal_total_paise` already carries, and nothing is collected. But alcohol for human
   consumption sits **outside GST in India** — state excise applies instead, and it is normally
   already inside the per-bottle price. So the *label* on a guest-facing document may be wrong
   even where the arithmetic is not. Moving it is a section in `lib/tax.ts` plus one line in
   `lib/invoice.ts`; nothing else reads it.
2. **Whether the hotel is selling or serving.** A priced per-bottle list reads as a sale, which
   needs the relevant licence. If what is actually happening is corkage or a permit-room service
   charge on the guest's own liquor, the model is the same but the wording on the document is
   not. Nobody has told us which; the code says "Bar: <brand>" and takes no position.

**A price change never re-prices a quoted bottle.** `sub_event_bar_items` snapshots the brand's
name and rate when the line is added (rule 4), so re-pricing the bar tomorrow moves nothing on a
proposal made today — the same guarantee menus get, by the same means. That is also why the bar
has one price and no effective-from date, unlike `menu_tier_prices`: the snapshot already does
the work dating would, and a date nobody needs is a date somebody sets wrong.

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
| 8 | ~~Is "Residency" real?~~ (C5) — answered 20 Jul: yes, and "Dipali Grand" is not | done |
| 8a | **Real category-wise rooms + prices for all three units** (F1) — supersedes 3 and 4 | M5 |
| 8b | Palace's 2 unaccounted rooms: 38 stated vs 36 in PRD §3.3 (F1) | M5 |
| 8c | Regency's A/B dormitory — 18 beds/Rs. 35,000 or 30 beds/Rs. 50,000? (F2) | M5, M9 |
| 8d | Confirm the merged semi-suite → suite and exec-deluxe → deluxe rates (F3) | M5 |
| 8e | Should the Lodge Manager's 30-day window be role-capped like the venue board? (F5) | future |
| 9 | GST rates per charge head (PRD open question 5) | M9 |
| 10 | Payment reminder schedule (PRD open question 1) | M7 |
| 11 | Correct the menu item typos? (B2) | cosmetic |
| 12 | Turnaround/buffer between back-to-back venue bookings? (D3) — defaulted to none | future |
| 13 | Per-room discount over cap — firm reject or escalate to exception? (D5) — defaulted to reject per M5 acceptance | M7 |
| 14 | Does the Banquet Manager keep his day-sheet sign-off now that he approves nothing? (F16) — kept, since it blocks every lock | next |
| 15 | Residency's real room and category list — still the only invented inventory (F1) | next |
| 16 | ~~When a booking loses rooms to someone who committed first, who is notified and how?~~ **Built** — see F13 | done |

*Resolved since M0: C8/C9 (venue clash model — client chose time-overlap, see D3);
the 11 AM handover exceptions question is moot (the 11 AM rule itself was withdrawn).*
