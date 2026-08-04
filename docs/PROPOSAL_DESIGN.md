# Proposal — full system reference

How a proposal (a booking) is designed, built, priced, confirmed, edited and billed in the
Hotel Dipali banquet system. This is a reference for anyone designing, extending, or reviewing
the proposal flow. It is grounded in the code as of 25 Jul 2026; where it summarises a rule,
the authoritative source is named so you can verify.

**Source-of-truth documents** (read these for the underlying "why"):
- `CLAUDE.md` — conventions and the **non-negotiable rules** (the BR-* rules below).
- `docs/PRD.md` — every functional requirement (FR-x.y) and business rule (BR-*).
- `db/schema.sql` — the validated DDL (applied as migration 0001); constraints live here.
- `docs/API_CONTRACT.md` — the endpoint surface.
- `docs/SEED_ASSUMPTIONS.md` — every invented/interpreted value (rate cards, inventory, menus).

---

## 1. What a proposal is

A **proposal = one `events` row** ("the booking"), plus its children:
- one or more **functions** (`sub_events`) — e.g. Mehndi, Sangeet, Wedding, Reception — each
  with a date, a time window, a venue (or a bundle of venues), and a pax count;
- **contacts** (`event_contacts`) and optional **KYC** (`guest_documents`, Aadhaar);
- **rooms** booked in bulk (`room_requirements`);
- **menus** snapshotted per function (`sub_event_menus` + categories + selections);
- **money**: `payments`, later `discounts`, `maintenance_entries`, and an `invoices` bill.

The word **"proposal"** is what the guest-facing flow is called; internally it is an event. The
words **"invoice"/"final"** are never shown to a guest — the two printable documents are
**"Draft"** and **"Draft 2"** (see §12).

Every amount is **BIGINT paise** in the DB, API and state; rupees appear only in the UI
(`lib/money.ts`). Never float money. Times are stored 24h (`HH:MM`) and shown 12h AM/PM
(`lib/time.ts`). Dates are ISO `YYYY-MM-DD`.

---

## 2. Lifecycle & statuses

`events.status` moves only through the state machine in `lib/events.ts` (`transitionEvent`);
never an ad-hoc status update (CLAUDE.md rule 8).

```
enquiry ──▶ confirmed ──▶ in_progress ──▶ completed ──▶ locked ──▶ billed ──▶ closed
   │            │              │              │
   └────────────┴──────────────┴──────────────┴──▶ cancelled   (any pre-lock state)
```

| Status | Meaning | How it's reached |
|--------|---------|------------------|
| `enquiry` | Draft proposal, holds nothing on the calendar | `POST /events` |
| `confirmed` | 25% advance recorded, venue slots blocked | `POST /events/:id/confirm` (BR-P1) |
| `in_progress` | The event's dates have begun | daily cron `advanceEventStatuses` (first function's date ≤ today) |
| `completed` | All dates have passed | daily cron (last function's date < today) |
| `locked` | Frozen for billing; no further edits | Auditor, `POST /events/:id/lock` after `completed` |
| `billed` | Draft 2 issued | invoice finalise |
| `closed` | Settled | after `billed` |
| `cancelled` | Withdrawn | `POST /events/:id/cancel` (from any pre-lock state) |

Two moves belong to the **calendar, not a person** — `advanceEventStatuses` (the daily cron,
`POST /cron/run`) starts an event when its first function's date arrives and completes it once
the last has passed. Without the cron nothing ever reaches `completed`, so nothing can be
locked/invoiced/billed. Cron dates come from `sub_events.event_date`, not the
`first_date`/`last_date` cache (which is written at confirm and can be stale — see
[[first-date-derived-cache]] in memory).

**"Locked means locked"** (CLAUDE.md rule 6): a DB trigger `forbid_locked_event_write` blocks
writes to a locked event's child tables; the service layer also blocks for a clean 409.

---

## 3. The 5-step wizard (`components/booking-wizard.tsx`)

The proposal is built in `/bookings/new` (create) or `/bookings/:id/edit` (resume/edit). Steps:

**Step 0 — Date & event**
- From / To date = the **declared run** (`events.planned_from` / `planned_to`, migration 0018).
  Rooms are bounded by this window, not by the functions' dates. Confirm never rewrites it.
- Event type: **Wedding** or **Others** (`other`). Wedding drives the 3-contact rule and the
  silent food surcharge. **Fixed once the proposal exists** (drives contact count + surcharge;
  the `PUT /events/:id` schema never accepted a change).
- Guest name (free text; never affects pricing).

**Step 1 — KYC**
- Contacts: **Wedding needs 3, Others need 1**; each a **10-digit** mobile. The first save
  (`POST /events` if new, else `PUT /events/:id`) creates/updates the proposal → this is where
  `eventId` comes into being.
- Aadhaar front + back: **optional** (client, 22 Jul 2026) — can be added later from the
  booking page. Stored **encrypted at rest** (AES-256-GCM before the bytes leave the process),
  referenced by `guest_documents.file_key` (CLAUDE.md rule 7). Never a confirm gate any more.

**Step 2 — Functions & menu**
- Add a function: name, date (inside the declared run), start/end time, **exactly one** of
  venue or bundle, and pax. Pax is uncapped (FR-2.6 withdrawn, 3 Aug 2026): whatever the guest
  says, no venue range to argue with and no override note to write.
- Pick a menu **tier** per function now; dishes can be chosen later (FR-3.2 — an incomplete
  menu is allowed). The per-plate rate is read back from the server (the wedding surcharge is
  added server-side; the client never recomputes money).
- Each add/remove persists immediately (`POST`/`DELETE /sub-events`).

**Step 3 — Rooms** (see §8)
- Lodge + category + count + check-in/out. Auto-saves (debounced) — deciding lodging can take
  days. Bounded by the declared run; inline availability feedback per line.

**Step 4 — Payment review**
- Full breakdown line by line (venue, food, rooms grouped by lodge with sub-totals, 5% room
  tax, estimated total, **advance required = 25%**). Record the advance (amount, mode, receipt
  no., received-on — **received-on cannot be in the future**), then **Confirm proposal**.

**Inline availability feedback** on every function form the moment date + venue + time are set
(`POST /availability`), and per-line room availability on step 3 (`POST /rooms/availability`).

The stepper is clickable once the proposal exists, so any step can be edited directly.

---

## 4. Data model (key tables — `db/schema.sql` / `db/schema.ts`)

```
events (the proposal)
 ├─ event_contacts            phone + label (primary/father/coordinator)
 ├─ guest_documents           aadhaar_front / aadhaar_back → encrypted file_key
 ├─ sub_events (functions)    name, event_date, start/end_time, venue_id|bundle_id, pax,
 │   │                        venue_rate_paise (snapshot at confirm)
 │   ├─ venue_bookings        one row per venue window; GiST exclusion = no overlap (BR-C1)
 │   ├─ sub_event_menus       tier snapshot (tier_name, base_rate, surcharge) — BR-M1/M5
 │   │   ├─ sub_event_menu_categories   base_pick, extra_picks, approved_extra_picks
 │   │   └─ sub_event_menu_selections   chosen dishes (snapshot by name); is_extra flag
 │   └─ sub_event_addons      ad-hoc line items
 ├─ room_requirements         unit_id + room_type + count + check_in/out  ← THE room booking
 ├─ discounts                 head: menu/venue/overall (per-room live on the room line)
 ├─ payments                  advance_block / part_payment / settlement / refund
 ├─ maintenance_entries       post-event extras
 ├─ exceptions                approvals: menu_increase / room_allocation_35plus /
 │                            discount_over_cap / counter_change …
 ├─ change_requests           post-confirm date/time/venue amendments
 ├─ invoices (+ invoice_lines) the bill (Draft / Draft 2)
 └─ lock_signoffs             per-designation sign-offs before lock
audit_log                     append-only; every mutation writes here (CLAUDE.md rule 5)
```

`events` columns of note: `code` (E-1234), `guest_name`, `event_type`, `status`,
`first_date`/`last_date` (derived cache, written at confirm), `planned_from`/`planned_to`
(declared run), `proposal_total_paise`, `confirmed_at`, `locked_at/by`, `cancelled_at/reason`.

---

## 5. Non-negotiable business rules (CLAUDE.md rule 3)

Three rules run inside **one service-layer transaction each**, relying on DB constraints to win
races:

- **BR-C1 — Venue time-overlap** (`lib/confirm.ts`, `venue_bookings` GiST exclusion): a venue
  may hold any number of functions on a day as long as their **time windows don't overlap**;
  back-to-back is allowed. A window with `end_time ≤ start_time` runs **past midnight** into the
  next day. Booking a **bundle** inserts one `venue_bookings` row **per member venue**. The
  exclusion decides races — exactly one of two racing confirms wins, the other gets a 409.

- **BR-P1 — 25% advance to confirm** (`lib/confirm.ts`): confirm requires recorded advance
  **≥ 25%** *before* inserting `venue_bookings`. The base is `proposal_total_paise` **plus the
  room estimate and its 5% tax** (client, 20 Jul 2026). Rooms are deliberately **outside**
  `proposal_total_paise` because that column is BR-D2's discount denominator.

- **BR-D1 / BR-D2 — Discounts**: combined discounts **≤ 10% of proposal total** unless an
  approved exception exists (BR-D2); per-room caps **Rs 500 / Rs 1,000 for suites** (BR-D1).

Other non-negotiables:

- **BR-R1 — A missing rate card is a gate, never a zero.** If a venue + event type has no rate,
  confirm is blocked and an Authority-approved manual rate is demanded. Never price at 0.
- **BR-L2 — 35+ rooms need the Authority.** Booking 35 or more rooms defers to Higher Authority
  approval (an approval, not a hard limit). Enforced at **confirm** (that is when rooms take
  inventory). Separately, a **hard inventory cap**: never more of a category than the lodge has
  free on the tightest night of the stay.
- **BR-M1 / BR-M5 — Snapshots, not references.** Menus copy tier name, price, surcharge and
  items onto the function at save; bills read snapshots only. **Wedding surcharge Rs 50.**
  `pick_count = NULL` means every item is included (read-only, always complete, never
  free-increase eligible).
- **Menu increases unlock, they don't increment** (client, 21 Jul 2026): pressing *Increase* on
  a segment lifts its ceiling; every pick beyond `base_pick` is an **extra**. **Two extras per
  FUNCTION are free**; the rest go to the GM when that function's submit is pressed.
- **Permissions are server-side** on every route via `requirePermission(module, action)` reading
  `role_permissions` (CLAUDE.md rule 2). UI hiding is cosmetic.
- **Every write is audited** (CLAUDE.md rule 5).

---

## 6. Pricing model (`lib/pricing.ts`, `lib/confirm.ts`, `lib/invoice.ts`)

`proposal_total_paise` = **venue** + **food** + **add-ons**:
- **Venue** = rate from a rate card keyed on **(venue OR bundle) × event type**
  (`venue_rate_cards`). Missing rate ⇒ BR-R1 gate. Snapshotted onto `sub_events.venue_rate_paise`
  at confirm.
- **Food** = Σ over functions of `pax × per-plate`, where per-plate = tier base + wedding
  surcharge (from the menu snapshot).
- **Add-ons** = `sub_event_addons`.

**Rooms are separate** (see §8): `rooms = Σ count × nights × rack-rate`, plus **5% room tax**
(`ROOM_TAX_BP = 500`; rooms are the only taxed head). Rooms stay **out of**
`proposal_total_paise` (BR-D2 denominator) but **count toward the 25% advance base**:

```
advance_base = proposal_total_paise + rooms_paise + rooms_tax_paise
advance_required = 25% of advance_base
```

The **proforma** (`GET /events/:id/proforma`, `lib/invoice.ts`) computes the same line math as
the real bill from current data but persists nothing — it is the live "Draft" estimate and the
source for the downloadable PDF. It **throws for an enquiry** (confirm the booking to get an
estimate).

---

## 7. Times, dates, money conventions

- Money: BIGINT **paise** everywhere; format to rupees only in the UI.
- Time: stored `HH:MM` (24h); displayed 12h AM/PM via `lib/time.ts` (`formatTime` /
  `formatTimeRange`, which appends `+1` for an overnight window). `todayISO()` gives today in
  IST — used to bar future "received-on" dates.
- Dates: ISO `YYYY-MM-DD`.

---

## 8. Rooms model (`lib/rooms.ts`, CLAUDE.md rule 9)

Rooms are **booked in bulk on the proposal**: lodge (unit) + category + count + dates **is** the
booking (`room_requirements`) — `room_allocations` is retired; nothing writes it. No room
numbers (which actual room a guest gets is the reception desk's call).

- Bounded by the **declared run** (`planned_from`/`planned_to`); check-out may reach the morning
  after the To date. A guest may stay the whole event even if a function isn't scheduled every
  day. Proposals made before the window was captured fall back to the functions' span.
- **Two independent limits**: a **hard inventory cap** (never more than the lodge has free on
  the tightest night) and the **35+ rule** (BR-L2, an Authority approval).
- **Enquiries hold nothing** — whoever confirms first takes the rooms; the loser is *told*
  (a live shortfall detection, `lib/rooms.ts`), not blocked in advance.
- Rooms stay **editable after confirmation** (up to lock) — a guest's lodging changes right up
  to the event.
- Seed inventory (see `docs/SEED_ASSUMPTIONS.md` for authoritative values): Palace, Regency,
  Residency lodges with deluxe / suite / dormitory categories.

---

## 9. Menus model (`lib/menus.ts`)

- A function's menu is a **snapshot** of a chosen **tier** → **categories (segments)** →
  **items (dishes)**. Saved at `PUT /sub-events/:id/menu`; the picker reads
  `GET /sub-events/:id/menu`; the catalog is `GET /menu/catalog`.
- `base_pick` = how many dishes a segment includes; `pick_count = NULL` = all items included
  (read-only, always complete). The wedding surcharge (Rs 50) is added server-side.
- **Increases**: `POST /sub-events/:id/menu/increase { category }` unlocks a segment's ceiling.
  Extras beyond `base_pick` are flagged (`is_extra`). **Two extras per function are free**; the
  rest are submitted to the GM (`POST /sub-events/:id/menu/increase/submit`) as a
  `menu_increase` exception. On approval, `approved_extra_picks` is bumped; a partial/rejected
  decision rolls the surplus dishes out (`lib/approvals.ts applyDeferred`).
- The menu master (the catalog itself) is a separate module (`menu_master`), edited by the
  Authority/Auditor/Chef at `/admin/menus`.

---

## 10. Confirm — THE transaction (`lib/confirm.ts`, `POST /events/:id/confirm`)

In one transaction: lock the event; require it's an `enquiry`; check guest name + contact count
(3 for weddings) + ≥1 function; **price** (BR-R1 gate); block if a 35+ room request is pending
(BR-L2); record the advance and require **≥ 25%** of the advance base (BR-P1); insert one
`venue_bookings` row per venue window (GiST exclusion decides races); snapshot venue rates; set
`proposal_total_paise` + `first_date`/`last_date`; transition to `confirmed`. Any failure rolls
back — no partial confirmation. Concurrency: two confirms racing for one slot → exactly one
wins, the other gets a 409 (`tests/booking.integration.test.ts`).

---

## 11. Editing & post-confirm changes

- **Enquiry** — fully editable by anyone with `bookings:create_edit`. Reopen the wizard at
  `/bookings/:id/edit` ("Continue proposal").
- **Confirmed** — **Higher Authority + Auditor** can reopen the full wizard and add / remove /
  move functions, edit rooms, contacts and dates (`lib/post-confirm.ts`, tester 23 Jul 2026).
  The venue holds stay in sync: an add inserts `venue_bookings` (overlap-checked by the same
  GiST exclusion as confirm), a remove drops them via `ON DELETE CASCADE`, and the total + dates
  recompute. A booking must keep ≥1 function. Everyone else's post-confirm changes go through:
  - **Change requests** (`change_requests`, `POST /change-requests`): date/time/venue amendments
    to a confirmed function, decided by the Banquet Manager / Authority.
  - **Pax** — `POST /sub-events/:id/pax` applies a post-confirm pax change directly (audited).
- **Locked+** — no edits (rule 6).

---

## 12. Documents, print & PDF

- **Proforma / Draft** — `GET /events/:id/proforma` (any stage; `bookings:view`), rendered by
  `components/invoice-print.tsx` as a designed A4 document: the proposal first, then the Terms &
  Conditions annexure (`lib/terms.ts`), watermarked on every page. **Draft** = an enquiry's
  provisional estimate; **Draft 2** = a confirmed (or later) booking's proposal. The words
  "invoice"/"final" never reach the guest. An enquiry Draft prices the venue live off the rate
  card until the confirm snapshot exists, so it is complete rather than blocked (client, 25 Jul 2026).
- **Print → Save as PDF** — "Print Draft" is available at every stage and opens the print view;
  the browser print dialog (Ctrl/Cmd+P → Save as PDF, A4, background graphics on) produces the
  shareable file. The old client-side `@react-pdf` one-click download was retired 25 Jul 2026 —
  it could not reproduce the designed template.
- Aadhaar bytes are never returned without a permission check; never logged.

---

## 13. Roles & permissions (`db/masters.ts` MATRIX; enforced by `requirePermission`)

Grants: `view`, `create_edit`, `delete`. Current matrix for the proposal-relevant modules:

| Module | booking_mgr | banquet_mgr | lodge_mgr | maintenance | higher_authority | auditor | chef |
|--------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| bookings | edit | – | – | – | **edit** | full | – |
| calendar | view | view | – | – | edit | full | view |
| menus | edit | – | – | – | edit | full | view |
| menu_master | – | – | – | – | edit | full | view |
| rooms | view | – | edit | – | view | full | – |
| lodging_calendar | – | – | view | – | – | full | – |
| maintenance | – | – | – | edit | view | full | – |
| approvals | – | – | – | – | **edit** | full | – |
| billing | – | edit | edit | edit | edit | full | – |
| roles_users | – | – | – | – | **–** | full | – |
| audit | – | – | – | – | view | full | – |

Notable (tester round, 23–25 Jul 2026): **Higher Authority can now create/edit proposals**
(bookings edit) and edit **confirmed** bookings; **Approvals is deciders-only** (Higher
Authority + Auditor); **Roles & Permissions is Auditor-only**. "Deciders" for approvals and
change requests = `higher_authority`, `auditor` (`DECIDER_ROLES`). The **Banquet Manager** is
scoped to Dashboard + the Next-15-days board; the **Lodge Manager** to the Lodging calendar.

---

## 14. Approvals & counter-change (`lib/approvals.ts`, `/approvals`)

Exceptions raised by other flows (menu increase, 35+ rooms, discount over cap) queue for the
Authority/Auditor. `POST /exceptions/:id/decide { approve | reject | approve_modified }` decides
and applies the deferred change atomically; every decision is audited and terminal.

**Counter-change** (tester, 23 Jul 2026): a settled decision is never edited. To revise one, the
Authority raises a new, linked `counter_change` exception with a required reason
(`POST /exceptions/:id/counter`). It's logged and appears in the queue for HA + Auditor; by
design it **never auto-touches** a guest's saved menu/rooms — the operational change is made
through the normal tools ("record & route"). The decided view shows who decided, when, the
remark, and what was requested.

---

## 15. Screens (proposal-relevant)

- **Proposals list** (`/bookings`) — status filters (All / **Upcoming** future-dated / Enquiry /
  Confirmed / …), per-row **View** (all statuses) and **Edit** (enquiry for any editor;
  confirmed for HA/Auditor), and **Download PDF** (confirmed+).
- **Booking wizard** (`/bookings/new`, `/bookings/:id/edit`) — the 5-step flow (§3).
- **Booking detail** (`/bookings/:id`) — functions + menus, rooms, billing, maintenance, lock &
  payment review, audit trail; "Continue proposal" (enquiry) / "Edit booking" (confirmed,
  HA/Auditor) / "Print Draft" / "Download PDF".
- **Calendar board** (`/calendar`) — venues × dates; confirmed + carryover + in-progress; no
  enquiries (FR-2.5). **Lodging calendar** (`/rooms/calendar`) — month grid of room occupancy.
- **Approvals** (`/approvals`), **Change requests** (`/change-requests`).
- All screens are mobile-friendly (drawer nav below `lg`; calendars scroll horizontally on
  phones).

---

## 16. Key API endpoints (see `docs/API_CONTRACT.md` for the full surface)

```
POST   /events                         create enquiry {guest_name, event_type, contacts[], from/to}
GET    /events?status=&from=&to=&mine=  list / dashboard
GET    /events/:id                      full detail (children per permission)
PUT    /events/:id                      pre-confirm edits (HA/Auditor may edit confirmed)
POST   /events/:id/documents            Aadhaar upload (multipart, encrypted)
POST   /events/:id/sub-events           add function   (confirmed → HA/Auditor, holds synced)
PUT    /sub-events/:id | DELETE          edit / remove function
POST   /sub-events/:id/menu | GET        save / read the menu snapshot
POST   /sub-events/:id/menu/increase[/submit]   unlock a segment / submit extras to GM
POST   /events/:id/room-requirements | GET      THE room booking (bulk)
POST   /rooms/availability               how many of each category are free
POST   /availability                     venue time-overlap check (bundle-aware)
POST   /events/:id/confirm               THE confirm transaction (BR-P1)
GET    /events/:id/quote | /proforma     live estimate / draft
POST   /events/:id/cancel                cancel {reason}
GET|POST /events/:id/discounts | payments | ledger    billing
GET    /exceptions | POST /exceptions/:id/decide | /counter   approvals + counter-change
GET|POST /change-requests | POST /change-requests/:id/decide  post-confirm amendments
```

---

## 17. Where to look in the code

| Concern | File |
|---------|------|
| Wizard (all 5 steps, resume/edit) | `components/booking-wizard.tsx` |
| Confirm transaction (BR-C1, BR-P1, BR-R1, BR-L2 gate) | `lib/confirm.ts` |
| Pricing (venue/food/rooms) | `lib/pricing.ts` |
| Rooms (requirements, availability, shortfalls) | `lib/rooms.ts` |
| Menus (snapshot, increases) | `lib/menus.ts` |
| Post-confirm function editing (HA/Auditor) | `lib/post-confirm.ts` |
| State machine + cron transitions | `lib/events.ts` |
| Approvals + counter-change | `lib/approvals.ts` |
| Invoice / proforma / bill math | `lib/invoice.ts` |
| Proposal print + T&C annexure | `components/invoice-print.tsx`, `lib/terms.ts` (print → Save as PDF) |
| Permissions matrix | `db/masters.ts` (+ migrations under `db/migrations/`) |
| Schema (constraints, triggers) | `db/schema.sql` / `db/schema.ts` |
| Detail / list / calendars | `components/event-detail.tsx`, `bookings-list.tsx`, `calendar-board.tsx`, `lodging-calendar.tsx` |
