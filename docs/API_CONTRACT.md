# API Contract (v1)

All routes under `/api/v1`. JSON in/out. Money in paise (integers).
Every route: session auth + `requirePermission(module, action)`.
Errors: `{ error: { code, message } }` with proper HTTP status; constraint
races return 409 with a human-readable message.

## Auth
- `POST /auth/login` { mobile, password } → session cookie + user + role + permissions
- `POST /auth/logout`
- `GET  /auth/me` → user, role, permission matrix (drives UI visibility)

## Masters (module: roles_users / respective masters — Admin/Authority)
- `GET|POST /roles`, `PUT /roles/:id`, `PUT /roles/:id/permissions`
- `GET|POST /users`, `PUT /users/:id` (role change, activate/deactivate)
- `GET|POST|PUT /venues`, `/venue-bundles`, `/rate-cards`
- `GET|POST|PUT /menu/tiers`, `/menu/tiers/:id/prices`, `/menu/categories`, `/menu/items`
- `GET|POST|PUT /lodging/units`, `/lodging/rooms`
- `GET|PUT /settings/:key` (incl. `terms_and_conditions`, `advance_pct`)

## Events & booking (module: bookings)
- `POST /events` — create enquiry { guest_name, event_type, contacts[], … }
  → validates contact count (3 for wedding, 1 otherwise)
- `GET  /events?status=&from=&to=&mine=` — list/dashboard
- `GET  /events/:id` — full detail (children included per permissions)
- `PUT  /events/:id` — pre-confirm edits; post-confirm → creates change request
- `POST /events/:id/documents` — multipart Aadhaar front/back upload
- `POST /events/:id/sub-events` | `PUT /sub-events/:id` | `DELETE /sub-events/:id`
- `GET  /availability?venue_id=&date=&start=&end=` — time-overlap check (bundle-aware),
  returns { available, conflicts[], open_enquiries }
- `POST /events/:id/confirm` — THE transaction: re-validates all windows, requires SOME
  recorded advance against a receipt, re-tests the 10% discount cap, inserts venue_bookings
  atomically → 409 on any race; 402 `advance_required` only when nothing at all was recorded.
  Returns `event.advanceShortfallPaise` / `advanceRequiredPaise` — a part payment confirms and
  carries the rest as Downpayment due (BR-P1, amended 4 Aug 2026)
- `POST /events/:id/cancel` { reason }
- `GET  /events/:id/proforma` — a live proforma estimate (same bill math, nothing persisted)
  for a confirmed-but-unlocked event; gated on `bookings` view so the Booking Manager can quote
- `GET  /events/:id/quote` — the priced proposal for the review step: per-function venue
  charges, `payablePaise`, `shownGstPaise`, `displayTotalPaise`, `advanceRequiredPaise`,
  `weddingMilestonePaise`, and `missing[]` for BR-R1 gaps

## Calendar (module: calendar)
- `GET /calendar?from=&to=` — venues × dates board; banquet manager capped to
  rolling 15 days server-side; states: confirmed | carryover | in_progress | downpayment due.
  Each booking carries `advanceShortfallPaise` (0 when paid up) and, for short bookings only,
  `contactPhone` — so the call to the GM can be made from the board (4 Aug 2026).
  Locked-in deals only — events at status confirmed or beyond. Enquiries are never
  returned (FR-2.5, amended 17 Jul 2026); slot contention surfaces via `/availability`,
  which still returns `open_enquiries`.
- `GET /calendar/day-sheet/:date` — consolidated ops/kitchen order (printable)
- `GET /calendar/horizon?from=&days=` — the operations board (client, 21 Jul 2026). Every
  function over a window with venue, timing, pax, the full menu including per-dish
  preferences and priced chef delicacies, and add-ons. **No money in the payload at all** —
  omitted at the query, not hidden in the UI, because it is served to roles with no billing
  grant. 15 days by default (the Banquet Manager's board), capped at 31; the Chef reads the
  same shape with `days=1`. Returns `{ from, to, days[] }`, each day flagged `isToday`.
- `GET|POST /change-requests`, `POST /change-requests/:id/decide`

## Menu master (module: menu_master — the catalog itself, not any event's copy)
- `GET  /menu/master` — every tier with its FULL price history, segments and dishes
  (including retired ones). Distinct from `/menu/catalog`, which is the picker's view:
  gated on `menus`, current rate only, retired dishes hidden.
- `POST /menu/master/tiers` { name, effective_from, base_rate_paise, wedding_surcharge_paise? }
  — a tier and its opening rate. The rate is part of creation: a tier with no price cannot
  be saved onto a sub-event, so a priceless one would appear in the picker and fail on save.
- `PUT  /menu/master/tiers/:id` { name } — rename. Saved menus keep their own `tier_name`
  snapshot, so an event booked as "Silver" still reads Silver on its bill.
- `GET  /menu/master/tiers/:id/price?effective_from=` — what a re-price would touch, asked
  BEFORE it is made: `{ savedMenus, upcomingUnbilled }`.
- `PUT  /menu/master/tiers/:id/price` { effective_from, base_rate_paise, wedding_surcharge_paise }
  — records a dated rate. **A new date is a new row, never an edit to the old one**, so what
  a tier cost last March stays on record and last March's bill can still be explained.
  Re-sending an existing date corrects that row; the screen only offers today and later.
- `POST /menu/master/categories` | `PUT /menu/master/categories/:id` — segments: name,
  `pick_count` (null = all included), `free_increase_eligible`, `sort_order`.
- `DELETE /menu/master/categories/:id` — requires **`menu_master:delete`**, the only place in
  the system where the `delete` action means anything. Cascades to the segment's dishes.
- `POST /menu/master/items` | `PUT /menu/master/items/:id` { name?, is_active? } — dishes are
  RETIRED via `is_active`, not deleted: snapshots copy by name so a delete would not corrupt
  a booked menu, but it would erase the dish from every tier's pooled Swap list with no undo.

## Menus (module: menus)
- `GET  /menu/catalog` — every tier → categories → items, for the dish picker (menus:view;
  reading tiers to build a booking is a `menus` concern, distinct from `menu_master` editing)
- `GET  /sub-events/:id/menu` — snapshot + completion state
- `PUT  /sub-events/:id/menu` — save tier + selections (tentative allowed);
  applies wedding surcharge; enforces pick-counts
- `POST /sub-events/:id/menu/increase` { category } — **unlocks** the segment (21 Jul 2026).
  Not a "+1": from here the segment has no ceiling and every pick beyond `base_pick` is an
  extra. Always 200; nothing reaches the Authority here. Returns
  `{ categoryName, basePick, extraPicks, freeRemaining }`.
- `GET  /sub-events/:id/menu/increase/submit` — what the submit button would carry: extras
  above the free two, by segment, with the dish names already ticked.
- `POST /sub-events/:id/menu/increase/submit` — sends this function's outstanding extras to
  the Authority as ONE request. Per function and on demand, not batched at the lock. Two
  extras per function are free; re-pressing sends only what is new. Returns
  `{ exceptionId, submitted }`, with `exceptionId: null` when nothing was outstanding.
- `POST /sub-events/:id/addons` | `DELETE /addons/:id`

## Rooms (module: rooms; booking a room is a `bookings` concern — see below)
- `GET  /events/:id/room-requirements` | `POST` (from wizard step 4). **This is the booking**
  (migration 0009): lodge + category + count + dates. Gated on `bookings:create_edit`, not
  `rooms`. Refuses more than the lodge has free (409) and dates outside the event's own span
  (400); ≥35 rooms still raises the BR-L2 request, which is an approval and not a limit.
- `POST /rooms/availability` { event_id?, lines[] } — how many of each category a lodge has
  free over a range, measured per night and reported at the tightest one. Drives the ceiling
  the form shows before a save; the same numbers are re-checked inside the save transaction,
  which is what actually binds. `event_id` excludes an event's own rows so editing does not
  count against itself. `bookings:view`.
- `GET  /rooms/units` — lodging units + room counts, for the board's unit selector
- `GET  /rooms/board?unit_id=&from=&to=` — availability grid
- `DELETE /room-allocations/:id` — un-assign a room. **Retired**: rooms are booked in bulk on
  the proposal and nothing writes `room_allocations` any more. Live but unreferenced by any UI.
- `POST /events/:id/room-allocations` — bulk allocate; overlap → 409; non-Palace for lawn
  wedding needs override_note. **Retired**, as above.
- `GET  /events/:id/rooms/reconciliation` — **can the lodge deliver what was sold?** Per line:
  promised, the lodge's capacity for that category, the peak held by other committed events
  over the same nights, and the shortfall. `deliverable` is the Lodge Manager's sign-off in one
  boolean. Excludes the event itself and measures at the tightest night.
- `GET  /rooms/calendar?from=&to=` — the Lodge Manager's 30-day board: cumulative counts per
  date × unit × room category, never room numbers. Both ends inclusive (unlike `/rooms/board`,
  which is half-open). Defaults to the next 30 days; span capped at 92 server-side. Returns
  `{ from, to, windowDays, inventory[], occupancy[] }` — `occupancy` carries only non-empty
  cells, each split `locked | confirmed | pending`; the client fills the rest from `inventory`.
  `pending` is now always 0 and the field is kept only for shape: it used to count rooms held
  inside an undecided 35+ exception, back when a deferred allocation wrote nothing.
  Requirements ARE the booking today and are saved whether or not the Authority has ruled, so
  counting them again there booked the same room twice. Enquiries hold nothing.
  A Lodge Manager sees only their own lodge (migration 0013); every other role sees all three.
- `GET  /rooms/calendar/:date` — that date drilled down: `{ date, inventory[], holders[] }`,
  each holder being an event, its category, its count and its state.

## Discounts & payments (module: billing — booking_manager has none; the advance is
## recorded on the bookings/confirm path instead)
- `GET|POST /events/:id/discounts` — head menu/venue/room/overall. POST takes `amount_paise`
  (a discount is money, 4 Aug 2026); `percent_bp` is still accepted for the approval-bundle path
  and older callers. Over cap → 202 { exception_id } (BR-D2). GET adds `cap`
  { capPct, capBasePaise, capPaise, usedPaise, headroomPaise } so a screen can state the
  remaining headroom in rupees.
- `DELETE /discounts/:id` — remove a discount (and its pending exception)
- `GET  /events/:id/ledger` — the payable amount (venue + food + rooms + 5% room GST, less
  discounts), the 18% shown-not-collected GST beside it, payments trail, paid vs balance, and
  `milestones[]` — 25% advance / wedding 50% at D-30 / 100% settlement, each with required,
  paid, shortfall, dueOn and overdue (4 Aug 2026)
- `POST /events/:id/payments` { kind, amount_paise, mode, receipt_no, received_on } — unique receipt
- `GET  /reminders/pending?as_of=` — due payment reminders for the caller's role (any auth
  role). Each carries `shortfallPaise` — the gap to the wedding's 50% milestone, not the whole
  outstanding balance (BR-P2, amended 4 Aug 2026)
- `POST /cron/run` { as_of? } — daily job: generate wedding reminders + surface stale enquiries
  (CRON_SECRET header, or Auditor/Admin session)

## Approvals (module: approvals)
Bundled by proposal since 1 Aug 2026 (client's lead): the GM decides a BOOKING, not a request.
The per-exception endpoints below are unchanged and still serve the history screen and any
single-request flow; the bundle endpoints are what the approvals screen uses.

- `GET  /approvals/bundles` — one row per proposal with pending asks: counts by section
  (food / rooms / discount / timing), oldest ask, requesters. Deciders only.
- `GET  /approvals/bundles/:eventId?settled=1` — that proposal's asks (exceptions AND change
  requests, merged) plus the full proposal document, so the GM decides against what he can see.
- `POST /approvals/bundles/:eventId/decide`
  { decisions[]: { id, source: exception|change_request, action, remark?, modified? },
    edits?: { event?, functions[]?, menus[]?, rooms[]?, addDiscounts[]?, removeDiscountIds[]?,
              reason? } }
  → ONE transaction. Edits apply first (they are the GM's real answer), then each ask is
  settled; an ask answered by editing is recorded, not applied twice. `reason` is mandatory
  when the booking is locked/billed/closed. 409 if a venue window was taken meanwhile — nothing
  is saved. Returns { settled[], skipped[], changes[], invoiceReissued, invoiceNo, remaining }.
- `GET  /exceptions?status=pending&mine=1` — flat queue (`mine=1` = raised by caller)
- `GET  /approvals/dashboard` — pending load + biggest upcoming events (FR-6.3)
- `POST /exceptions/:id/decide` { action: approve|reject|approve_modified, remark, modified? }
  → applies the deferred change on approval, notifies requester. Deciding is
  Authority/Auditor-only (behavioural rule); remark mandatory on reject.

## Maintenance (module: maintenance)
- `GET  /maintenance/events` — in-progress/completed events (the team's work queue)
- `GET  /events/:id/maintenance` — entries + running total + closed flag
- `POST /events/:id/maintenance` (multipart, optional receipt/photo) | `PUT|DELETE /maintenance/:id`
- `GET  /maintenance/:id/attachment` — decrypted receipt, permission-gated
- `POST /events/:id/maintenance/close` — freeze entries + record the maintenance sign-off (FR-5.2)

## Change requests (module: bookings to raise, calendar to decide)
Decided inside the proposal's approval bundle since 1 Aug 2026 — a venue move is the `timing`
section of `POST /approvals/bundles/:eventId/decide`. The endpoints below still stand: the
raiser reads their own outcomes here, and `/change-requests/:id/decide` remains for a
single-request decision.
- `GET  /change-requests?status=&event_id=` — the queue (pending first)
- `POST /change-requests` { sub_event_id, payload{event_date/start_time/end_time/venue_id/bundle_id}, reason } (FR-1.9)
- `POST /change-requests/:id/decide` { action: approve|reject, remark } — Higher Authority;
  approval re-books the venue slot (409 if taken meanwhile)
- `POST /sub-events/:id/pax` { pax } — a post-confirm pax change applies directly. No upper
  bound of any kind, and `override_note` is gone with the capacity it explained (4 Aug 2026)

## Lock & billing (module: billing — Auditor)
- `GET  /events/:id/lock-checklist` — computed item states
- `POST /events/:id/signoff` { designation }
- `POST /events/:id/lock` — validates checklist, freezes, drafts invoice
- `GET  /events/:id/invoice` | `PUT /events/:id/invoice/adjustments`
- `POST /events/:id/invoice/finalise` — assigns invoice_no, snapshots T&C, → billed
- `GET  /events/:id/invoice/print` — PDF: bill + T&C + signature blocks

## Audit & reports (module: audit)
- `GET /events/:id/trail?user=&module=&from=&to=` (+ `?export=csv`)
- `GET /reports/occupancy|revenue|pipeline|exceptions|maintenance|outstanding`

## Notifications
- `GET /notifications` — derived, role-aware actionable feed (v1: approvals/change requests to
  decide, reminders due, stale enquiries). No stored read-state yet, so `POST
  /notifications/:id/read` is deferred with the persistent notifications table (SEED_ASSUMPTIONS D10).
- Server cron (`POST /cron/run`, M7): stale enquiries (7d), wedding D-30 balance due,
  reminders to D-21, Authority escalation D-20 onward.

## Reports (module: audit)
- `GET /reports/occupancy|revenue|pipeline|exceptions|maintenance|outstanding` (PRD §7)
