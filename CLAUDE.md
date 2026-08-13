# Hotel Dipali Banquet Management System

Multi-property banquet/event management web app. Seven roles (the Chef was added
19 Jul 2026), clash-proof venue calendar, menu snapshots, GM approvals,
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
     A function is keyed to the day it STARTS on: one running 8 PM–6 AM consumes one day of that
     hall, and the calendar board draws it on that day only (no next-morning carryover chip).
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
     only). A discount is **an amount of money** off a head (menu / venue / room /
     overall) — client's lead, 4 Aug 2026, replacing the live percentage. What is typed
     is what the guest gets; the percentage survives only as the cap's arithmetic. Such
     a row stores `percent_bp = NULL`; older percentage rows still recompute live.
     Over the cap → Higher Authority approval. Per-room caps (BR-D1) are retired now
     that rooms are booked in bulk. Because a frozen rupee figure cannot shrink with the
     bill the way a percentage did, `confirmEvent` re-tests the same cap once more.
     Discounts are the **Booking Manager's** to give (he has `billing` edit) and the
     **Authority's** — both, from the Payment review or the event's Billing panel.
     **The cap does not bind the Authority himself** (amended 1 Aug 2026; widened 3 Aug 2026
     from the approvals screen to *wherever he gives it*): his discount is written with no
     `exception_id` — which is what `effectiveDiscountPaise` reads as in force — and may be a
     flat rupee amount. The cap's job is to route a big discount *to* him; it has nothing to do
     when he is the one giving it. `lib/discounts.ts` owns that test now, so every screen agrees.
     The remark is still mandatory.
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
   **Rooms 5%** — printed and collected. **Everything else 18%** (venue, food,
   add-ons, maintenance) — printed and collected from nobody: "at the end we are
   just showing we are taking 18% gst but we wont be taking it."
   Every document therefore carries two totals and must show both: **Total**
   (with all tax) and **Amount payable** (what is actually collected). Showing one
   figure is how a counter takes 18% too much.
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
   + **closed maintenance**, less discounts. Milestones are floors on the CUMULATIVE total
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
13. **No pax limit anywhere** (client, 4 Aug 2026, completing the 3 Aug removal of the
   venue-capacity cap). A positive whole number is a type check, not a limit — no
   ceiling in Zod, no capacity gate, and `pax_override_note` is gone with the capacity
   it explained. `venues.capacity_min/max` survive as descriptive seed data and gate
   nothing.

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
