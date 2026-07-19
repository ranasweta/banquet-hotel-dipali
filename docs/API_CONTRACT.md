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
- `POST /events/:id/confirm` — THE transaction: re-validates all windows, checks
  advance ≥ 25%, inserts venue_bookings atomically → 409 on any race
- `POST /events/:id/cancel` { reason }
- `GET  /events/:id/proforma` — a live proforma estimate (same bill math, nothing persisted)
  for a confirmed-but-unlocked event; gated on `bookings` view so the Booking Manager can quote

## Calendar (module: calendar)
- `GET /calendar?from=&to=` — venues × dates board; banquet manager capped to
  rolling 15 days server-side; states: confirmed | carryover | in_progress.
  Locked-in deals only — events at status confirmed or beyond. Enquiries are never
  returned (FR-2.5, amended 17 Jul 2026); slot contention surfaces via `/availability`,
  which still returns `open_enquiries`.
- `GET /calendar/day-sheet/:date` — consolidated ops/kitchen order (printable)
- `GET|POST /change-requests`, `POST /change-requests/:id/decide`

## Menus (module: menus)
- `GET  /menu/catalog` — every tier → categories → items, for the dish picker (menus:view;
  reading tiers to build a booking is a `menus` concern, distinct from `menu_master` editing)
- `GET  /sub-events/:id/menu` — snapshot + completion state
- `PUT  /sub-events/:id/menu` — save tier + selections (tentative allowed);
  applies wedding surcharge; enforces pick-counts
- `POST /sub-events/:id/menu/increase` { category } — free bump if eligible
  and unused, else auto-raises exception → 202 { exception_id }
- `POST /sub-events/:id/addons` | `DELETE /addons/:id`

## Rooms (module: rooms)
- `GET  /events/:id/room-requirements` | `POST` (from wizard step 4)
- `GET  /rooms/units` — lodging units + room counts, for the board's unit selector
- `GET  /rooms/board?unit_id=&from=&to=` — availability grid
- `DELETE /room-allocations/:id` — un-assign a room
- `POST /events/:id/room-allocations` — bulk allocate; ≥35 rooms auto-raises
  exception (202); overlap → 409; non-Palace for lawn wedding needs override_note
- `GET  /events/:id/rooms/reconciliation` — promised vs allocated vs occupied

## Discounts & payments (module: billing — booking_manager has none; the advance is
## recorded on the bookings/confirm path instead)
- `GET|POST /events/:id/discounts` — head menu/venue/overall (per-room discounts live on the
  allocation, BR-D1); live 10% combined total; over cap → 202 { exception_id } (BR-D2)
- `DELETE /discounts/:id` — remove a discount (and its pending exception)
- `GET  /events/:id/ledger` — proposal − effective discounts, payments trail, paid vs balance
- `POST /events/:id/payments` { kind, amount_paise, mode, receipt_no, received_on } — unique receipt
- `GET  /reminders/pending?as_of=` — due payment reminders for the caller's role (any auth role)
- `POST /cron/run` { as_of? } — daily job: generate wedding reminders + surface stale enquiries
  (CRON_SECRET header, or Auditor/Admin session)

## Approvals (module: approvals)
- `GET  /exceptions?status=pending&mine=1` — Authority queue (`mine=1` = raised by caller)
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
- `GET  /change-requests?status=&event_id=` — the queue (pending first)
- `POST /change-requests` { sub_event_id, payload{event_date/start_time/end_time/venue_id/bundle_id}, reason } (FR-1.9)
- `POST /change-requests/:id/decide` { action: approve|reject, remark } — Banquet Manager;
  approval re-books the venue slot (409 if taken meanwhile)
- `POST /sub-events/:id/pax` { pax, override_note } — a post-confirm pax change applies directly

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
