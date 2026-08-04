# Build plan — execute milestones in order

Each milestone ends with its acceptance tests passing before moving on.
Reference: PRD.md for behaviour, schema.sql for data, API_CONTRACT.md for routes.

## M0 — Scaffold
Next.js (App Router, TS strict) + Tailwind + shadcn + Drizzle + Vitest.
Apply `db/schema.sql` as migration 0001; write the seed script (see CLAUDE.md).
✓ Accept: `pnpm dev` runs; `pnpm test` green; seed loads all masters + 15 users
(the PRD's 14 plus the Auditor/Admin — see SEED_ASSUMPTIONS.md C3).

## M1 — Auth, roles, permission middleware
Login/logout/me; `requirePermission` helper; role matrix admin screen
(module × view/create-edit/delete grid, Vyapar-style); user management.
✓ Accept: a booking manager receives 403 on `POST /roles`; matrix edits persist
and take effect without re-login.

## M2 — Availability engine + calendar board
`/availability` implementing the time-overlap model (BR-C1, amended) + bundle
expansion + past-midnight windows; calendar board UI (venues × dates;
confirmed / in-progress / carryover states — confirmed-and-beyond only, no
enquiries per amended FR-2.5); banquet manager capped to rolling 15 days server-side.
✓ Accept: unit/integration tests for all BR-C1 cases (non-overlapping same-day
windows accepted, overlapping rejected, back-to-back accepted, past-midnight
window blocks next morning, bundle blocks members and vice versa); board renders
states.

## M3 — Booking wizard (enquiry → confirm)
5 steps per PRD 5.1: dates, event type (contact count rule), sub-events with
inline availability, room requirements (Palace default for lawn weddings),
review. Aadhaar upload. Confirm transaction: SOME advance against a receipt +
atomic slot inserts; stale-enquiry flagging. (Amended 4 Aug 2026 — the 25% is a
debt carried by the booking, not a gate on it: a part payment confirms and shows
as Downpayment due until the rest arrives. BR-P1, FR-1.7a.)
✓ Accept: concurrency test — two parallel confirms, exactly one succeeds,
loser gets 409 with friendly message; wedding without 3 contacts cannot confirm.

## M4 — Menu module
Tier dish picker (per-category any-N counters, save-incomplete allowed),
snapshot write incl. wedding +Rs. 50 surcharge, free-increase (one eligible
category, tracked), over-limit → exception (deferred until approval), add-ons,
tentative swap versioning.
✓ Accept: master price change after save does not alter snapshot; second
increase attempt returns 202 with exception; surcharge applied only for weddings.

## M5 — Rooms module
Rooms board, bulk allocation (overlap 409 from DB), 35+ → exception,
non-Palace override note for lawn weddings, reconciliation view, room
discounts with per-room caps.
✓ Accept: overlap insert fails cleanly; 35-room allocation sits pending until
Authority approves; Rs. 600 discount on a deluxe room is rejected, Rs. 900 on
a suite is accepted.

## M6 — Approvals queue (Higher Authority)
Unified exceptions list, decide endpoint (approve/reject/approve-modified,
remark mandatory on reject), deferred-change application, notifications to
requester, Authority dashboard.
✓ Accept: approving a menu-increase exception applies the extra pick; rejecting
reverts and surfaces the remark to the booking manager.

## M7 — Discounts, payments, reminders
Discount service (heads, live 10% computation, cap escalation), payment
ledger with unique receipt numbers, cron: wedding D-30 notification,
reminders to D-21, Authority escalation from D-20; stale-enquiry job.
✓ Accept: mixed discounts totalling 9.9% pass, 10.1% raises exception;
reminder rows generated correctly for a wedding 45 days out (time-travel test).

## M8 — Maintenance + day sheet + change requests
Maintenance entry CRUD with attachments and close-out; printable day sheet;
post-confirm change requests with banquet-manager decision for venue/date/time.
✓ Accept: maintenance blocked before in_progress and after lock; day sheet
shows every sub-event of a date with menus.

## M9 — Lock, invoice, audit trail
Lock checklist computation, sign-offs, lock transaction, invoice draft
(venue + food pax×rate + rooms + maintenance − advances, per-line GST — rooms 5%
collected, 18% elsewhere shown and not collected, so the bill carries both a Total
and an Amount payable; 4 Aug 2026),
adjustments, finalise with invoice_no + T&C snapshot, print view with
signature blocks; audit trail timeline UI with CSV export.
✓ Accept: lock refused while an exception is pending; post-lock edit attempts
return 409; invoice totals reconcile to the paise against a hand-computed case.

## M10 — Reports, polish, hardening
Six reports (PRD §7), notification center, empty/loading/error states,
mobile-tablet pass for calendar + day sheet, rate limiting on auth,
backup documentation.
✓ Accept: Lighthouse ≥ 90 on core screens; all Vitest + integration suites green.
