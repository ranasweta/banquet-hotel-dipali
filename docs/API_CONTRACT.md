# API Contract (v1)

All routes under `/api/v1`. JSON in/out. Money in paise (integers).
Every route: session auth + `requirePermission(module, action)`.
Errors: `{ error: { code, message } }` with proper HTTP status; constraint
races return 409 with a human-readable message.

## Auth
- `POST /auth/login` { login_id, password } → session cookie + user + role + permissions
  (`login_id` matched case-insensitively; was `mobile` before migration 0027)
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
  preferences, the chef delicacies (`{ description, pending }` — `pending` where the Chef has
  not priced it yet; declined asks are dropped), and add-ons. **No money in the payload at all** —
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
  POST **cascades up the tier ladder** (Silver → Gold → Platinum → Diamond → Crown, 12 Aug
  2026): the dish is added to the matching segment of every tier above, once each, and the
  response says where it went — `{ id, cascadedTo: string[], skippedTiers: string[] }`.
  Segments match by name plus `SEGMENT_ALIASES`, which carries the three the card relabels as
  it climbs — Salad/Salad Bar, Veg Appetizer/Veg Starters, Raita/Raita Bar — so every seeded
  segment reaches Crown and `skippedTiers` is empty in practice. A tier appears there only
  when it carries no counterpart segment at all; the caller must show it. Tiers off the
  ladder — Breakfast Gold, High Tea Silver, anything newly created — neither cascade nor
  receive, and both arrays come back empty.

### The bar (12 Aug 2026)
- `GET /menu/master/bar-brands` | `POST` { name, price_per_bottle_paise } — the priced brand
  list, retired brands included. Names are unique on `lower(name)`: one brand, one price, one
  row in the dropdown. **`menu_master`**, like the rest of this section.
- `PUT /menu/master/bar-brands/:id` { name?, price_per_bottle_paise?, is_active? } — rename,
  re-price, retire or restore. Brands are RETIRED, never deleted (`ON DELETE RESTRICT`): bottles
  already quoted reference them, and they read their own snapshot.
  `GET /menu/master/bar-brands/:id` returns `{ orderedOn }` — what a re-price would *not* move.
- `GET /sub-events/:id/bar` — `{ lines, brands }`: the bottles on this function plus the brands
  still orderable, together, because the Alcohol panel needs both the moment it opens
  (**menus:view**).
- `PUT /sub-events/:id/bar` { brand_id, bottles } — order bottles for this function
  (**menus:create_edit**). **Idempotent per brand**: sending it again REPLACES the count rather
  than adding a second line, and re-snapshots the price. Returns the same shape as GET.
- `DELETE /bar-lines/:id` — take a brand off a function (**menus:create_edit**).

A bar line carries the brand's name and rate as snapshots, so re-pricing the catalogue never
re-prices a quoted booking. The money reaches `proposal_total_paise` through
`recomputeProposalTotal` — so it is inside the payable, the advance base and the discount-cap
base without those modules knowing the bar exists — and prints as a `food`-section line, i.e.
18% shown and collected from nobody (rule 11). See SEED_ASSUMPTIONS §F24 for the two questions
that leaves for the hotel's CA.

## Venue master (module: venue_master)
Added 12 Aug 2026. Venues, the bundles made out of them, and what each costs per event type —
everything the pricing code reads about a venue. Auditor `full`, Higher Authority `edit`.

- `GET  /venue-master` — properties, event types, venues and bundles, each with the rates in
  force today. A venue with an empty `rates` array is UNPRICED, which is not the same as free.
- `POST /venue-master/venues` { property_id, name, kind, capacity_min, capacity_max } — a new
  hall or lawn. **It carries no rate**, so it is not offered standalone until one is set;
  creating it at zero would give a hall away by accident.
- `PUT  /venue-master/venues/:id` { name?, kind?, capacity_min?, capacity_max?, is_active? }
- `POST /venue-master/bundles` { name, venue_ids[] } — two venues minimum.
- `PUT  /venue-master/bundles/:id` { name?, venue_ids? } — renaming is always allowed;
  **replacing the membership is refused once the bundle is on a booking** (409), since it
  decides which halls that booking holds (FR-2.3).
- `PUT  /venue-master/rates` { venue_id | bundle_id, event_type, rate_paise, effective_from } —
  **`rate_paise: 0` is valid and means free.** Setting the same date twice corrects in place;
  a new date is a new row, so last March's price still explains last March's bill.
- `DELETE /venue-master/rates` { venue_id | bundle_id, event_type } — removes the rate, turning
  that venue + event type back into a **gate** (BR-R1). Requires **`venue_master:delete`**, not
  `create_edit`: an unpriced venue vanishes from the picker and blocks confirmation, which is a
  heavier act than pricing one at zero.

**The two kinds of no-charge, because every caller has to keep them apart:** a rate of `0` is a
decision and confirmation proceeds; a missing rate is unpriced and confirmation is blocked until
the Authority approves a manual rate. An "Other" booking pays no standalone hall charge and that
is stored as zeroes, not as gaps (SEED_ASSUMPTIONS §F26). Bundles keep their rate for every
event type.

## Lodge master (module: lodge_master)
Added 13 Aug 2026 — the venue master's counterpart for rooms. Auditor `full`, Higher Authority
`edit`. Distinct from `rooms` (who is staying where) and `lodging_calendar` (the day sheet), so
a Lodge Manager can run the desk without being able to re-price the hotel.

**The screen is category-wise; the table is room-wise.** `rooms` keeps one row per physical room
because the hard inventory cap counts real rooms (rule 9), but every room of a category already
shares one rate and pricing reads `min(rack_rate_paise)` per category. So the API speaks in
categories and does the row bookkeeping underneath.

- `GET  /lodge-master` — lodges → categories: `{ roomType, rooms, ratePaise, beds, committedPeak }`.
  `committedPeak` is the most that category is promised on any single night; it is the floor a
  reduction cannot cross, surfaced so the screen can explain a refusal before it happens.
- `POST /lodge-master/lodges` { name } — a new lodge, with no categories yet.
- `POST /lodge-master/categories` { unit_id, room_type, rate_paise, rooms, beds } — add a
  category. `room_type` is normalised (`"Semi Suite"` → `semi_suite`), so it cannot be added
  twice under two spellings.
- `PUT  /lodge-master/categories` { unit_id, room_type, rate_paise?, rooms? } — re-price, resize,
  or both. **A REDUCTION IS GUARDED**: rooms already promised to committed bookings are counted
  per night and dropping below the busiest is refused (409) with the number that blocks it.
  Growing is free. Enquiries hold nothing, so a draft never freezes the Auditor out.
- `DELETE /lodge-master/categories` { unit_id, room_type } — retire a category. Same guard as
  shrinking it to zero. Requires **`lodge_master:delete`**.

Rooms are RETIRED (`is_active = false`), never deleted, so an old booking still explains itself;
growing a category revives retired rows before numbering new ones.

**Re-pricing moves unbilled bookings.** A room's rate is snapshotted nowhere — billing and the
payable read it live — so a change reaches every proposal and unissued Draft of that category.
Issued invoices keep the lines they were issued with. This is unlike venue and menu rates, which
ARE snapshotted, and the screen says so rather than implying a protection that does not exist.

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

## Lodge extras (module: rooms)
Added 15 Aug 2026 — what the desk gave out beyond the booking. Lodge Manager `edit`, Booking
Manager and Higher Authority `view`, Auditor `full`. Two kinds of charge, one close, and the
same lifecycle as maintenance: logged while the event is **In Progress / Completed**, and
charged only once the log is **closed**. Both stay out of the 25% advance, the wedding 50% and
the 10% discount cap — they are in the settlement and the balance only (CLAUDE.md rule 12).

- `GET  /lodge-extras/events` — the work queue: In Progress / Completed events with a line
  count and a closed flag, mirroring `/maintenance/events`.
- `GET  /events/:id/lodge-extras` — `{ closed, rooms[], roomsPaise, roomsTaxPaise,
  inRoomDiningPaise, totalPaise, options[] }`. `options` is every priced lodge + category, sent
  with the view because the Lodge Manager has no `bookings` permission and so cannot call
  `/booking-options`, which is where every other room form gets its categories.
- `POST /events/:id/lodge-extras/rooms` { unit_id, room_type, count, nights, remarks? } —
  rooms given beyond the booking. Priced `count × nights ×` the lodge's rate for the category
  and **snapshotted** at entry, so re-pricing the lodge master never moves it. A category the
  lodge has no active room of is refused (400), never priced at zero. Deliberately NOT a date
  range: this records what was handed over, so it reaches no availability check and no board.
- `DELETE /additional-rooms/:id` — remove a line, before the close.
- `PUT  /events/:id/lodge-extras/dining` { amount_paise } — the in-room dining total for the
  whole stay. A PUT because it is one box overwritten as it grows: sending 4,200 twice leaves
  4,200. The figure it replaced is in the audit log.
- `POST /events/:id/lodge-extras/close` — freeze both kinds and let them reach the bill. A
  lock-checklist item (`lodge_extras`), non-blocking and green when there is nothing to close.

**Tax.** An extra room is a room: 5%, printed **and collected**. In-room dining is food: 18%,
printed and collected from nobody (rule 11). So the bill carries them as `rooms` and `food`
lines respectively and `lib/tax.ts` needs no new section.

## Extra plates (module: utensils)
Added 15 Aug 2026 — the Utensil Manager's log. Utensil Manager `edit`, Higher Authority and
Auditor `view`, everyone else nothing. Same lifecycle as maintenance and the lodge extras:
logged while **In Progress / Completed**, charged only once **closed**, and outside the 25%
advance, the wedding 50% and the 10% discount cap.

- `GET  /utensils/events` — the work queue, mirroring `/maintenance/events`.
- `GET  /events/:id/extra-plates` — `{ closed, entries[], totalPaise, functions[] }`.
  `functions` carries each function's per-plate rate, `ratePaise: null` where no menu is saved,
  so the screen can say why plates cannot be charged there rather than silently omitting it.
- `POST /events/:id/extra-plates` — **multipart**, fields `sub_event_id`, `plates`, `remarks?`
  and **`photo` (required)**. Images only (JPEG/PNG/WebP/HEIC, ≤ 8 MB); a request without one is
  a 400. Priced at the function's own `base + surcharge + priced chef delicacies` and
  snapshotted; a function with no saved menu is refused (400), never priced at zero.
- `DELETE /extra-plates/:id` — remove an entry before the close. Its photo is deleted with it.
- `GET  /extra-plates/:id/photo` — the decrypted image, `utensils:view`, `no-store`.
- `POST /events/:id/extra-plates/close` — freeze the log and put it on the bill. A
  lock-checklist item (`utensils`), non-blocking and green when there is nothing to close.

**Why a function and not just the booking:** a wedding's Sangeet is Silver where its Reception
is Gold, so "the event's menu price" is not one number. **Tax:** plates are food — 18%, shown
and collected from nobody.

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
