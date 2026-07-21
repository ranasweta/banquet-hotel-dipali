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
Behavioural guidelines (after Andrej Karpathy's notes on LLM coding pitfalls).
These bias toward caution over speed; for trivial tasks, use judgement.

**1. Think before coding.** Don't assume. Don't hide confusion. Surface tradeoffs.
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, and ask.

**2. Simplicity first.** Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked; no abstractions for single-use code.
- No "flexibility" or configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Test: "would a senior engineer call this overcomplicated?" If yes, simplify.
- Caveat: the non-negotiable rules below are *requirements*, not speculative
  extras. Auditing a write, checking a permission, or snapshotting a menu is
  never scope creep — leaving it out is a bug.

**3. Surgical changes.** Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken. Match existing style even if you'd differ.
- Notice unrelated dead code? Mention it — don't delete it.
- Do remove imports/variables/functions that *your* change orphaned.
- Test: every changed line should trace directly to the request.

**4. Goal-driven execution.** Define success criteria, then loop until verified.
- "Add validation" → "write tests for invalid inputs, then make them pass".
- "Fix the bug" → "write a test that reproduces it, then make it pass".
- "Refactor X" → "ensure tests pass before and after".
- For multi-step work, state a brief plan as `step → verify: check` lines.
- Strong criteria let you work independently; "make it work" doesn't.

Working if: fewer stray diffs, fewer rewrites from overcomplication, and
clarifying questions arriving before implementation rather than after mistakes.

## Stack
- Next.js 14+ (App Router) + TypeScript strict
- PostgreSQL 16, Drizzle ORM (introspect from `db/schema.sql`, keep SQL as
  the source of truth — schema changes happen in SQL migrations first)
- Tailwind + shadcn/ui
- Auth: session-based (iron-session or NextAuth credentials), mobile + password
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
   - Confirm requires recorded advance ≥ 25% BEFORE inserting `venue_bookings`
     rows (BR-P1). The base is `proposal_total_paise` **plus the room estimate and
     its tax** (client, 20 Jul 2026) — rooms are deliberately outside
     `proposal_total_paise` because that column is BR-D2's denominator.
   - Combined discounts ≤ 10% of proposal total unless an approved exception
     exists (BR-D2); per-room caps Rs. 500 / Rs. 1,000 for suites (BR-D1).
   Each runs in ONE db transaction; rely on the PK/exclusion constraints to
   win races, and translate constraint violations into friendly errors.
4. **Snapshots, not references**: menus copy tier name, price, surcharge, and
   items onto the sub-event at save (BR-M1/M5). Bills read snapshots only.
5. **Every write is audited**: wrap mutations in a helper that appends to
   `audit_log` (entity, field, old, new, user, role). No exceptions.
6. **Locked means locked**: rely on the `forbid_locked_event_write` trigger,
   but also block in the service layer for a clean 409 message.
7. **Aadhaar images** go to object storage (or `storage/` locally in dev),
   encrypted at rest, referenced by `guest_documents.file_key`. Never log
   Aadhaar data; never return file bytes without a permission check.
   `lib/storage.ts` picks its driver from `BLOB_STORE_ID` **or**
   `BLOB_READ_WRITE_TOKEN` — a dashboard-connected store provides the former and
   authenticates by OIDC, so checking only the token silently falls back to disk.
   Vercel Blob with `access: 'private'` when either is set, the local `storage/`
   directory when neither is. On Vercel with neither, an upload throws rather
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
9. **Rooms are booked in bulk, and bounded twice** (client, 21 Jul 2026). The
   proposal states lodge + category + count + dates, and that IS the booking —
   `room_requirements`, not `room_allocations`, which nothing writes any more.
   Two independent limits apply: a **hard inventory cap** (never more of a
   category than the lodge physically has free on the tightest night of the stay)
   and the **35+ rule** (BR-L2), which is an Authority approval, not a limit.
   Enquiries hold nothing — whoever commits first takes the rooms. Room dates must
   fall inside the event's own span, check-out reaching at most the morning after
   the last function.
10. **Menu increases unlock, they do not increment** (client, 21 Jul 2026).
   Pressing Increase on a segment lifts its ceiling; every pick beyond
   `base_pick` is an extra, flagged on the selection so the picker can colour it
   and the Authority can be told which *dish* is in question. Two extras per
   FUNCTION are free (not per segment); the rest go to the GM when that
   function's submit button is pressed — not batched at the lock.

## UI conventions
- Use the ui-ux-pro-max skill for design decisions and the Magic MCP (`/ui`)
  for component generation where installed.
- Screens follow the approved mockups: calendar board (venues × dates, confirmed +
  carryover + in-progress states — locked-in deals only, no enquiries, per amended
  FR-2.5), 5-step booking wizard, tier dish picker with per-category any-N counters
  (all-included categories render read-only), approvals queue, lock checklist.
- Inline availability feedback on every sub-event form the moment
  date + venue + time are set.

## Testing bar
- Vitest unit tests for every service-layer rule (the three transactions
  above, free-increase tracking, discount caps, reminder scheduling).
- One integration test per milestone acceptance criterion (see BUILD_PLAN).
- Concurrency test: two parallel confirms on the same slot — exactly one wins.

## Seed data
Seed script must load: 4 properties, all venues + 4 bundles with rate cards **per event
type** (from the hotel's 2026 venue proposal, not PRD §3 — see below), menu
tiers/categories/items from the two menu PDFs with pick-counts, wedding surcharge
Rs. 50, lodging inventory (Palace 36 rooms + 2 dormitories, Regency 49 rooms in blocks
A/B/C), event types (wedding = 3 contacts), modules list, roles with the default
permission matrix (PRD §2.1), and users: 2 higher_authority, 3 lodge, 5 booking,
3 banquet, 1 maintenance, **1 auditor/admin** (15 total).

Sources rank: **the hotel's PDFs > docs/PRD.md > placeholders.** Where the PRD
summarises the hotel's own price list it can be wrong, and in §3.1 it was. The spec
follows the hotel's data, never the other way around.

**`docs/SEED_ASSUMPTIONS.md` records every invented value, every interpretation, and
every contradiction found in the source documents. Read it before touching seed data,
menus, or rate cards — and add to it rather than silently inventing.**

Two rules it establishes that reach beyond the seed:
- **A missing rate card is a gate, never a zero.** If a venue + event type has no rate,
  block confirm and demand an Authority-approved manual rate (BR-R1). Never price at 0.
- **`pick_count = NULL` means every item is included** (breads, salad bar,
  accompaniments, breakfast, high tea). Read-only in the picker, always counts complete,
  never free-increase eligible.
