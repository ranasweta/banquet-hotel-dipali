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

## Discounts & payments (module: billing; record by booking manager)
- `POST /events/:id/discounts` — validates BR-D1 caps + live 10% total;
  over cap → 202 { exception_id }
- `GET  /events/:id/ledger` — payments trail + paid vs balance
- `POST /events/:id/payments` { kind, amount_paise, mode, receipt_no, received_on }
- `GET  /reminders/pending` — due payment reminders for current role

## Approvals (module: approvals)
- `GET  /exceptions?status=pending&mine=1` — Authority queue (`mine=1` = raised by caller)
- `GET  /approvals/dashboard` — pending load + biggest upcoming events (FR-6.3)
- `POST /exceptions/:id/decide` { action: approve|reject|approve_modified, remark, modified? }
  → applies the deferred change on approval, notifies requester. Deciding is
  Authority/Auditor-only (behavioural rule); remark mandatory on reject.

## Maintenance (module: maintenance)
- `GET  /maintenance/events` — in-progress/completed events
- `POST /events/:id/maintenance` | `PUT /maintenance/:id` | `POST /events/:id/maintenance/close`

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
- `GET /notifications` | `POST /notifications/:id/read`
- Server cron: stale enquiries (7d), wedding D-30 balance due, reminders to
  D-21, Authority escalation D-20 onward, lock-pending nudges.
