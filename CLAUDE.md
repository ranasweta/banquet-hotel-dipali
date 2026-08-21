# Hotel Dipali Banquet Management System

Multi-property banquet/event management web app. Eight roles (the Chef was added
19 Jul 2026, the Utensil Manager 15 Aug 2026), clash-proof venue calendar, menu snapshots, GM approvals,
consolidated GST billing, append-only audit trail. This file is the source of
truth for conventions; read the docs below before implementing any feature.

## Authoritative documents (read in this order)
1. `docs/PRD.md` — every functional requirement (FR-x.y) and business rule (BR-*).
   Never implement behaviour that contradicts it; if ambiguous, ask.
2. `db/schema.sql` — validated PostgreSQL 16 DDL. Tested: slot uniqueness,
   room-overlap exclusion, audit immutability, and locked-event guard all
   enforce at DB level. Apply it as migration 0001; do NOT redesign tables
   without flagging the change.
3. `docs/API_CONTRACT.md` — endpoint surface. Extend, don't rename.
4. `docs/BUILD_PLAN.md` — milestone order with acceptance criteria. Work
   through milestones sequentially; each ends with passing tests.

## How to work
These rules bias toward caution over speed; for trivial tasks, use judgement.

**1. Simplicity first.** Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked; no abstractions for single-use code.
- No "flexibility" or configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Test: "would a senior engineer call this overcomplicated?" If yes, simplify.
- Caveat: the non-negotiable rules below are *requirements*, not speculative
  extras. Auditing a write, checking a permission, or snapshotting a menu is
  never scope creep — leaving it out is a bug.

**2. Surgical changes.** Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken. Match existing style even if you'd differ.
- Notice unrelated dead code? Mention it — don't delete it.
- Do remove imports/variables/functions that *your* change orphaned.
- Test: every changed line should trace directly to the request.

**3. Goal-driven execution.** Define success criteria, then loop until verified.
- For multi-step work, state a brief plan as `step → verify: check` lines.

## Stack
- PostgreSQL 16, Drizzle ORM (introspect from `db/schema.sql`, keep SQL as
  the source of truth — schema changes happen in SQL migrations first)
- Auth: session-based (iron-session or NextAuth credentials), `users.login_id` + password
  (migration 0027, client 11 Aug 2026). The ID is Admin-chosen and unique on
  `lower(login_id)` — every lookup must lower() both sides. `users.mobile` is contact
  information now: nullable, not unique, and identifies nobody.
- Zod validation on every API input

## Non-negotiable rules
1. **Money is BIGINT paise everywhere** — DB, API, and state. Format to rupees
   only in the UI. Never float.
2. **Permissions are enforced server-side** on every route handler via a
   `requirePermission(module, action)` helper reading `role_permissions`.
   UI hiding is cosmetic, never the control.
3. **Three rules live in service-layer transactions** (marked in schema.sql):
   - Venue time-overlap (BR-C1, amended 17 Jul 2026): a venue may hold any number of
     sub-events on a day as long as their time windows don't overlap; back-to-back is
     allowed. A window with end_time ≤ start_time runs past midnight into the next day.
     Rely on the `venue_bookings` GiST exclusion to win races; no fixed slots, no 11 AM
     rule. Booking a bundle inserts one `venue_bookings` row per member venue.
     **The hall is charged once a DAY, not once a function** (client, 12 Aug 2026, after staff
     hit it in the field). Hiring a venue takes it 9 AM to 8 AM the next morning; every function
     inside that window shares one let, whatever their menus. Three functions in one hall on one
     day billed the hire three times — the guest hired the room for the day and paid for it
     thrice. The **earliest** function of a venue-day carries the charge and the rest are covered
     by it; `lib/pricing.ts` owns that rule and `lib/invoice.ts` + `lib/proposal.ts` reproduce
     the same carrier, so total, bill and printed proposal agree. A different venue on the same
     day is a separate let, and so is the same venue on another day. **The overlap rule is
     untouched** — windows still may not collide; only the price changed.
     A single function running 8 PM–6 AM consumes one day of that hall, and the calendar board
     draws it on the day it started (no next-morning carryover chip).
     **A SEPARATE function starting before 8 AM belongs to the previous day's let** (client,
     21 Aug 2026): the hire runs to 8 AM, so a 6 AM breakfast in the hall the wedding ran in is
     inside a let already paid for and is charged nothing. At or after 8 AM it is a fresh let —
     a hall let go at 8 and taken again is a new day's hire. `VENUE_DAY_START_TIME` and
     `venueDaySql` in `lib/pricing.ts` own the boundary; the other three readers import it.
     This supersedes "keyed to the day it STARTS on", which was written to settle which calendar
     square the board draws and contradicted the 9-to-8 window for anything starting after
     midnight. The board and the occupancy range are unaffected — only the charge moves.
     The occupancy range still crosses midnight, so the exclusion refuses a clash as before —
     but the board no longer paints the next day as taken, and the availability check may still
     refuse an early slot that the board shows as free.
   - Confirm requires **some** recorded advance BEFORE inserting `venue_bookings`
     rows (BR-P1, amended 4 Aug 2026). The 25% is a debt now, not a gate: a guest who
     brings part of it confirms all the same, holds the venues like any other booking,
     and carries the rest as **Downpayment due** — on the calendar, on the booking, in
     the audit trail. What is still refused is a hold for nothing (zero, or no receipt).
     The shortfall has no timer and raises no exception: it is chased when a competing
     enquiry appears, by the Booking Manager phoning the GM, who can cancel.
     The base is the **payable amount** — `proposal_total_paise` + rooms + the 5% room
     tax, less discounts. The 18% GST is not in it (see rule 10).
   - Combined discounts ≤ 10% of the **total bill** — `proposal_total_paise` + rooms,
     pre-tax and free of GST of either kind (BR-D2, amended 25 Jul 2026; was venue+food
     only). A discount is **the price we are actually charging**, not money taken off
     (client, 20 Aug 2026, replacing the 4 Aug rupee-amount-off-a-head; migration 0036).
     Every priced line — venue and food per function, each room category — carries an
     **Actual** figure that never moves and a **Discounted** one prefilled with it and typed
     over. Nothing is subtracted anywhere. What is STORED is the gap below the actual, never
     the typed price, because "the Billing figure always follows the live feeding of pax,
     menu, everything as it is": pax moves and the Discounted column moves with it, keeping
     the same money off. A flat gap, not a per-plate one. Every reader clamps at
     `max(0, actual − gap)`. The line is keyed by `discounts.line_key` — text, because saving
     rooms deletes and re-inserts every row (rule 9) and a uuid would orphan.
     **Tax follows the money**: the room 5%/18% is charged on the discounted line and the band
     is re-read off the **discounted nightly rate**, so an ₹11,000 suite given for ₹7,000 a
     night is a 5% room; the shown 18% on venue and food is computed on the discounted figure
     too. `lib/discounts.ts` owns the sheet and `payableRows` / `computeBillLines` /
     `proposalDocument` each price a line the same way.
     A row with `line_key IS NULL` is a pre-20-Aug LUMP discount: still effective, still
     subtracted at the end of the bill, and moving no tax. Nothing new writes one from a screen.
     Over the cap → Higher Authority approval, as **one** request carrying every cell of that
     save, never one per cell. Per-room caps (BR-D1) are retired now
     that rooms are booked in bulk. Because a frozen rupee figure cannot shrink with the
     bill the way a percentage did, `confirmEvent` re-tests the same cap once more.
     Discounts are the **Booking Manager's** to give (he has `billing` edit) and the
     **Authority's** — both, from the Payment review or the event's Billing panel.
     **The cap does not bind the Authority himself** (amended 1 Aug 2026; widened 3 Aug 2026
     from the approvals screen to *wherever he gives it*): his discount is written with no
     `exception_id` — which is what every reader takes as in force. The cap's job is to route a
     big discount *to* him; it has nothing to do when he is the one giving it.
     `lib/discounts.ts` owns that test now, so every screen agrees.
     **The remark is optional** (client, 20 Aug 2026, reversing FR-11.1): one per save, covering
     every cell that moved in it. The audit row still names who moved which line from what to
     what — see `docs/SEED_ASSUMPTIONS.md` §F29, which flags the control that was given up.
   Each runs in ONE db transaction; rely on the PK/exclusion constraints to
   win races, and translate constraint violations into friendly errors.
4. **Snapshots, not references**: menus copy tier name, price, surcharge, and
   items onto the sub-event at save (BR-M1/M5). Bills read snapshots only.
5. **Every write is audited**: wrap mutations in a helper that appends to
   `audit_log` (entity, field, old, new, user, role). No exceptions.
6. **Locked means locked — except for the Higher Authority** (client's lead, 1 Aug 2026).
   Rely on the `forbid_locked_event_write` trigger, and also block in the service layer for a
   clean 409 message. The single exception is `lib/gm-authority.ts`: the Authority (and Auditor)
   may edit a booking in ANY status. A trigger cannot see the actor, so that module announces
   itself with a transaction-local GUC — `set_config('app.gm_override', 'on', true)`, migration
   0025 — which both lock guards check. Nothing else sets it; `SET LOCAL` dies with the
   transaction, so it can never leak onto a pooled connection. A reason is mandatory and is
   audited, and editing a **billed** booking supersedes its document and issues a new numbered
   version rather than mutating the one the guest holds (`reissueInvoice`).
   The override covers the *workflow*, never the building: the venue GiST exclusion, the lodge
   inventory cap and the append-only `audit_log` still bind the Authority like everyone else.
7. **Aadhaar images** go to object storage (or `storage/` locally in dev),
   encrypted at rest, referenced by `guest_documents.file_key`. Never log
   Aadhaar data; never return file bytes without a permission check.
   `lib/storage.ts` picks its driver from `GCS_BUCKET`: a private Google Cloud
   Storage bucket when set, the local `storage/` directory when not. The client
   authenticates as the Cloud Run service account through ADC, so no key file is
   shipped and nothing needs rotating. On a host whose disk is ephemeral —
   `K_SERVICE` (Cloud Run) or `VERCEL` — with no bucket, an upload throws rather
   than writing somewhere that forgets.
   AES-256-GCM encryption happens **before** the bytes leave the process either
   way, so a leaked URL or a bucket snapshot yields ciphertext. The local driver
   is a dev convenience and never a deployment option — a serverless filesystem
   forgets, and a lost Aadhaar image surfaces much later as "no event can be
   confirmed". Replacing a document deletes the bytes it replaced.
8. Event status transitions only via the state machine in PRD §4.1 — one
   `transitionEvent(eventId, to)` service, never ad-hoc status updates. Two of
   the moves belong to the calendar, not a person: `advanceEventStatuses` (run by
   the daily cron) starts an event when its first function's date arrives and
   completes it once the last has passed. Without it nothing reaches `completed`,
   and nothing can be locked, invoiced or billed.
9. **Rooms are booked in bulk, bounded twice, and priced at confirmation** (client,
   21 Jul 2026; the freeze added 13 Aug 2026). The
   proposal states lodge + category + count + dates, and that IS the booking —
   `room_requirements`, not `room_allocations`, which nothing writes any more.
   Two independent limits apply: a **hard inventory cap** (never more of a
   category than the lodge physically has free on the tightest night of the stay)
   and the **35+ rule** (BR-L2), which is an Authority approval, not a limit.
   Enquiries hold nothing — whoever commits first takes the rooms. Room dates must
   fall inside the event's **declared run** — the From/To window picked when the
   proposal is started, stored as `planned_from`/`planned_to` (amended 22 Jul 2026) —
   check-out reaching at most the morning after the To date. A guest may stay the
   whole event even when a function isn't scheduled on every day. Proposals made
   before that window was captured fall back to the functions' span.
   **The nightly rate freezes at confirm, like a venue's** — `room_requirements.rate_paise`,
   migration 0032. Until then a room charge was recomputed from the live rack rate on every
   read, so re-pricing a category in the lodge master moved bookings already quoted. Every
   reader is `COALESCE(rr.rate_paise, <live min>)`: NULL means "price it live" (an enquiry, or
   a booking confirmed before the column existed), never "free". Saving requirements deletes
   and re-inserts every line, so both writers call `freezeRoomRates` — without it a confirmed
   booking whose rooms were edited would quietly start pricing live again. A post-confirm edit
   therefore re-prices at today's rate, exactly as a post-confirm venue edit does.
10. **Menu increases unlock, they do not increment** (client, 21 Jul 2026).
   Pressing Increase on a segment lifts its ceiling; every pick beyond
   `base_pick` is an extra, flagged on the selection so the picker can colour it
   and the Authority can be told which *dish* is in question. Two extras per
   FUNCTION are free (not per segment); the rest go to the GM when that
   function's submit button is pressed — not batched at the lock.
11. **Two GSTs, and only one of them is money** (client's lead, 4 Aug 2026).
   **Rooms** — printed and collected, at **5%** up to ₹7,500 a night and **18%
   above it** (client, 17 Aug 2026; strictly above, so ₹7,500 exactly is 5%).
   **A dormitory is exempt whatever it costs** (same instruction): its rate buys a
   room of 18–30 beds, not a bed, so the threshold does not speak to it. The
   carve-out is keyed on the category NAME — anything containing `dorm` — because
   `room_type` is free text; renaming a dormitory away from that word moves it into
   the 18% band, which is why the lodge master shows each category's band beside
   its rate. `lib/tax.ts` owns both halves (`roomGstBp`, `roomGstBpSql`,
   `isDormitory`) and nothing re-derives them, client components included: the
   band travels down on the row (`gstRateBp`) instead.
   **Everything else 18%** (venue, food, add-ons, maintenance) — printed and
   collected from nobody: "at the end we are just showing we are taking 18% gst
   but we wont be taking it."
   The two 18%s are not the same thing and must never be summed: a room's is
   **money** — in the payable, the 25%, the wedding 50% and the balance, exactly
   as its 5% always was. The collected/shown split therefore stays keyed on the
   **section** (`isCollectedSection`), never on the rate; only the rate itself is
   per line, from `roomGstBp(nightlyRatePaise)`. The band is read off the **nightly
   rate**, never the line total — six nights of a ₹5,000 room is 5%, not 18%.
   **The bifurcation is printed**: a document showing room GST states the 5% and
   the 18% as separate lines with the money each was charged on
   (`totals.roomTaxSplit`), and names the 18% rooms on their own accommodation
   lines. It applies everywhere a room is charged, the Lodge Manager's day-of
   extra rooms included (rule 14).
   Every document carries two totals and must show both: **Total**
   (with all tax) and **Amount payable** (what is actually collected). Showing one
   figure is how a counter takes 18% too much.
   **Never explain the shown-not-collected 18% on a guest-facing document**
   (client, 17 Aug 2026). That the hotel prints it and does not take it is the
   hotel's business; the note that used to say so on the proposal has been struck
   out. On the **Payment review's total row** it is now just "GST 18%" as well
   (client, 20 Aug 2026) — that row sits directly under **Amount payable**, which is
   what the counter takes. Every other staff screen — the lock panel, the billing
   ledger, the reports — still spells the split out in words, and must.
   The 18% enters **no** threshold and **no** balance — not the 25% advance, not
   the wedding 50%, not the discount cap, not `balance = payable − paid`. Folding
   it into a balance would leave every booking 18% short of zero for ever and
   nothing could be settled or closed. `invoices.tax_paise` stays the collected
   tax; the 18% lives in `shown_tax_paise` (migration 0026) and feeds only the
   printed total. `lib/tax.ts` owns the rates and the collected/shown split, by
   section — rooms collected, all else shown — so every screen agrees.
   **Flagged, not settled:** a GST line on a guest-facing document for tax that is
   not charged is a question for the hotel's CA. Implemented as instructed and
   recorded in `SEED_ASSUMPTIONS.md` §F8; it is a one-constant change.
12. **The payable amount and the milestones live in `lib/payment-schedule.ts`**, and
   nothing recomputes them locally. Payable = venue + food + add-ons + rooms + the 5%
   + **closed maintenance** + **closed lodge extras**, less discounts. Milestones are floors on the CUMULATIVE total
   received, never instalments of their own: **25%** at confirm, **50%** thirty days before
   the first function for weddings (BR-P2, amended 4 Aug 2026 — was the whole remaining 75%),
   **100%** at billing. Over-payment is always accepted.
   Dates come from `min(sub_events.event_date)`, never the `events.first_date` cache.
   **Maintenance splits the base in two** (client, 11 Aug 2026). The bill has always charged
   closed maintenance and this module ignored it, so the Billing panel read "settled" over a
   Draft that still asked for money. It is in the payable now, but only the **settlement** and
   the **balance** are measured on it: maintenance is logged during and after the event, and
   folding it into the 25% or the 50% would raise a threshold that fell due months earlier and
   make a met milestone retrospectively short. So `preEventPayablePaise` (without maintenance)
   is the base for the advance and the wedding 50% — `confirmEvent` and the quote route read
   that one — and `payablePaise` (with it) is the base for the settlement and the balance.
   Only entries the Maintenance team has **closed** count, matching what `computeBillLines`
   charges. Maintenance is not in the 10% discount cap either (rule 3's base is unchanged).
   **The Lodge Manager's extras sit beside it** (client, 15 Aug 2026; see rule 14): same side of
   the split, same closed-only rule, same absence from the discount cap.
13. **No pax limit anywhere** (client, 4 Aug 2026, completing the 3 Aug removal of the
   venue-capacity cap). A positive whole number is a type check, not a limit — no
   ceiling in Zod, no capacity gate, and `pax_override_note` is gone with the capacity
   it explained. `venues.capacity_min/max` survive as descriptive seed data and gate
   nothing.
14. **The lodge's extras are logged after the fact and charged on the close** (client,
   15 Aug 2026; migration 0034, `lib/lodge-extras.ts`). Two things the desk had been carrying on
   paper: **extra rooms** given to a party that arrived bigger than it was booked
   (`additional_rooms` — lodge + category + count + **nights**, no date range), and **in-room
   dining**, one rupee total for the whole stay (`lodge_extras.in_room_dining_paise`, a single
   box that is overwritten, never incremented).
   They are **not** an edit to `room_requirements`: that is what was SOLD, frozen at its
   confirmed rate, and the base of the advance — adding September's rooms to it would raise a
   threshold that fell due in June. They behave like maintenance instead, and rule 12 places
   them: settlement and balance only, never the 25%, the 50% or the 10% cap.
   **Nothing counts until the Lodge Manager closes the log** — one `closed_at`, covering both
   kinds, a non-blocking lock-checklist item, and the same reason maintenance has one: an open
   log is still being typed. Closed-only is enforced identically in `computeBillLines`,
   `payableRows` and `proposalDocument`, so the three cannot disagree.
   **The rate is snapshotted at entry** (rule 4) with no live fallback — unlike a room
   requirement, one of these lines never had an enquiry phase to price live for. A category the
   lodge has no priced room of is refused, never zeroed.
   **Tax follows what the thing is** (rule 11): an extra room is a `rooms` line, printed and
   **collected**, at 5% or 18% by its own nightly rate; in-room dining is a `food` line at 18%,
   printed and collected from nobody. `lib/tax.ts` needs no new section — using the wrong one of
   the two is how a counter takes 18% too much or leaves a balance permanently short.
   Nights, not dates, is deliberate: this records what was handed over, so it reaches no
   availability check, no rooms board and no lodging calendar. The hard inventory cap (rule 9)
   governs the booking; this governs the bill.
15. **Extra plates are the Utensil Manager's, and no entry exists without a photograph**
   (client, 15 Aug 2026; migration 0035, `lib/utensils.ts`). On the day, more guests arrive
   than a function was catered for and the kitchen issues extra plates. He logs how many,
   against which **function**, with a remark and a picture of them.
   **The photo is mandatory and `file_key` is NOT NULL** — not "saved and flagged". This is the
   one charge in the system with no booking, no rate card and no guest signature behind it,
   only a number somebody counted at the pass, so the evidence *is* the entry. It is encrypted
   at rest (rule 7) and served behind `utensils:view`, which by default means the Auditor and
   the Higher Authority: the people who can question the charge are exactly the people who can
   see the picture. Deleting an entry deletes its photo.
   **A function, not just a booking**, because the price is that function's own per-plate rate:
   `base_rate_paise + surcharge_paise + priced chef delicacies`, composed exactly as
   `computeBillLines` composes a catered plate's, so an extra plate and a booked one at the same
   function cost the same to the paisa. Snapshotted at entry (rule 4), with no live fallback. A
   function with **no saved menu has no rate and is refused**, never priced at zero.
   **The close is his own** and works like Maintenance's (FR-5.2/5.3): nothing is charged until
   he presses it, a non-blocking lock-checklist item, green when there is nothing to close.
   Plates are food — **18%, shown and collected from nobody** (rule 11) — and they sit with
   maintenance and the lodge extras on the far side of rule 12's split: settlement and balance
   only, never the 25%, the 50% or the 10% cap.

16. **An enquiry is editable in place, everywhere, until it is confirmed** (client, 15 Aug 2026:
   *"if someone wants to change the no. of pax or venue or date or timing"*). The booking page
   edits guest, contacts, the declared run, and each function's name / date / time / venue /
   pax, alongside the menus and rooms it already edited. **Rooms are shown on an enquiry** — the
   requirements ARE the booking (rule 9) and the wizard has always captured them at step 4; the
   page used to say "Rooms can be allocated once the booking is confirmed", which was wrong.
   **The boundary is confirmation, and it is the server's.** `PUT /sub-events/:id` refuses
   anything past `enquiry` with a 409. That is not squeamishness: an enquiry holds **no**
   `venue_bookings` — they are written at confirm — so moving its date or venue moves nothing
   and can clash with nothing. A confirmed function is a held slot, and moving it belongs to the
   change-request flow or `lib/post-confirm.ts`, both of which re-book the hold.
   Editing a function **recomputes `proposal_total_paise`** (venue and pax are both priced) and
   audits field by field, so the trail says what moved rather than "the function changed".

## UI conventions
- Use the ui-ux-pro-max skill for design decisions and the Magic MCP (`/ui`)
  for component generation where installed.
- Screens follow the approved mockups: calendar board (confirmed + in-progress states —
  locked-in deals only, no enquiries, per amended FR-2.5; the carryover tail was withdrawn
  12 Aug 2026, see rule 3), 5-step booking wizard, tier dish picker with per-category any-N counters
  (all-included categories render read-only), approvals queue, lock checklist.
- The approvals queue is **one row per proposal** (1 Aug 2026), opening onto that booking's
  asks grouped by section and, below them, the whole proposal as an editable form. Requested
  items are marked in **violet** — always with the word "Requested" beside them, never colour
  alone, since a decision hangs on seeing them.
- A booking short of its 25% shows **Downpayment due** on the calendar in rose, with the
  words beside the colour, and the day panel carries the shortfall and the guest's number so
  the call to the GM can be made from that screen (4 Aug 2026). The number rides along only
  for short bookings — everyone with `calendar: view` can open that board.
- Anywhere money is totalled for a human, **Total** and **Amount payable** appear together
  (rule 11). Never one alone.
- Inline availability feedback on every sub-event form the moment
  date + venue + time are set.

## Testing bar
- Vitest unit tests for every service-layer rule (the three transactions
  above, free-increase tracking, discount caps, reminder scheduling).
- One integration test per milestone acceptance criterion (see BUILD_PLAN).
- Concurrency test: two parallel confirms on the same slot — exactly one wins.

## Seed data
The full seed inventory (properties, venues, bundles, menus, lodging, roles, the 15
users) lives in the `seed-data` skill — invoke it before writing or regenerating seed data.

Sources rank: **the hotel's PDFs > docs/PRD.md > placeholders.** Where the PRD
summarises the hotel's own price list it can be wrong, and in §3.1 it was. The spec
follows the hotel's data, never the other way around.

**`docs/SEED_ASSUMPTIONS.md` records every invented value, every interpretation, and
every contradiction found in the source documents. Read it before touching seed data,
menus, or rate cards — and add to it rather than silently inventing.**

Two rules it establishes that reach beyond the seed:
- **A missing rate card is a gate, never a zero.** If a venue + event type has no rate,
  block confirm and demand an Authority-approved manual rate (BR-R1). Never price at 0 to
  mean "unpriced". **A DELIBERATE zero is a different fact and is allowed** (client, 12 Aug
  2026): an `other` booking pays no standalone hall charge, stored as a 0 rate card, and
  confirmation proceeds normally. Bundles keep their rate — only standalone halls go free,
  and only for `other`. The rule is data, not a branch: the Auditor owns it in the **venue
  master** (`venue_master`, migration 0029 — venues, bundles and every per-event-type rate,
  dated). A new venue is created with NO rate rather than a zero, and a bundle's membership
  freezes once it is booked because it decides which halls that booking holds.
- **`pick_count = NULL` means every item is included** (breads, salad bar,
  accompaniments, breakfast, high tea). Read-only in the picker, always counts complete,
  never free-increase eligible.
