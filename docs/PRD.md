# Product Requirements Document
## Hotel Dipali Banquet & Event Management System

**Version:** 1.1 (Draft — client review round 1 incorporated) · **Date:** 15 July 2026 · **Status:** For review

---

## 1. Overview

Hotel Dipali (Near Makronia Railway Crossing, Jabalpur Road, Sagar) operates a multi-property event business spanning three hotel units — Dipali Palace, Dipali Regency, and Dipali Grand — with seven banquet halls, three lawns, and two lodging units. Today, bookings, menus, room allocation, maintenance costs, and billing are coordinated manually, which creates risk of double-booked venues, un-billed extras, and untraceable changes.

This document specifies a single web application that manages the complete lifecycle of an event — from first guest enquiry to a locked, consolidated, tax-compliant bill — with role-based (designation-based) access for every staff function, a clash-proof venue calendar, and a full audit trail.

### 1.1 Goals

1. Zero venue double-bookings: every date/venue/time combination is validated against a single source of truth.
2. One event record shared by all designations — booking, banquet operations, lodging, maintenance, GM, and audit — each seeing and editing only what their role permits.
3. Every rupee on the final bill traceable to an entry made by an identified user at a known time (menu snapshot, room allocation, maintenance log, approved exception).
4. Configurable menus and pricing managed as data by hotel staff, not by developers.
5. A locked event is immutable; the consolidated bill is generated only from locked data.

### 1.2 Non-goals (v1)

- Online self-service booking by guests (staff-operated only).
- Payment gateway integration (payments recorded manually against the bill).
- Inventory/stock management for the kitchen.
- Payroll, HR, or accounting ledgers beyond the event bill itself.

---

## 2. Users and roles

| # | Role | Primary responsibility |
|---|------|------------------------|
| 1 | Booking Manager | Guest-facing intake: enquiries, dates, event setup, sub-events, menus, room requirements, confirmation. |
| 2 | Banquet Manager | Owns the venue calendar (15-day operational view), day sheets, and change approvals affecting venues/timing. |
| 3 | Lodge Manager | Allocates rooms and dormitories per event across Palace and Regency lodging units. |
| 4 | Maintenance Team | Logs event-linked extra costs (generator hours, damages, additional equipment) during and after execution. |
| 5 | Higher Authority (GM) | Approves escalations — menu exceptions, 35+ room allocations, discounts beyond 10% of proposal, overdue wedding balances; visibility across all modules. Two accounts provisioned. |
| 6 | Auditor / Admin | Full access; creates roles, grants module-level permissions (view / create-edit / delete), reviews the audit trail, executes event lock, and drafts the bill. |

**Initial user provisioning:** 2 Higher Authority accounts, 3 Lodge Managers (one per lodging unit), 5 Booking Managers, 3 Banquet Managers, 1 Maintenance user. Access is utility-based: the Authority/Admin can grant or revoke any module permission for any user at any time through the permission matrix — these counts are a starting configuration, not a system constraint.

### 2.1 Permission model

Permissions are granted per **role × module × action** (View, Create/Edit, Delete), mirroring a standard role-matrix screen. The Auditor/Admin creates roles, sets the matrix, and assigns users to roles. Key principles:

- A role can hold different actions on different modules (e.g. Booking Manager: Create/Edit on Bookings, View-only on Calendar and Rooms).
- Multiple users can share a role; a user has exactly one active role.
- Every write action is stamped with user, role, timestamp, and old→new values in the audit log (Section 10).
- Default matrix (editable by Admin):

| Module | Booking Mgr | Banquet Mgr | Lodge Mgr | Maintenance | Higher Auth | Auditor |
|---|---|---|---|---|---|---|
| Bookings & enquiries | Create/Edit | View | View | — | View | Full |
| Venue calendar | View | Create/Edit | View | — | View | Full |
| Menus (per event) | Create/Edit | View | — | — | Approve | Full |
| Menu master (tiers/items) | — | View | — | — | Edit | Full |
| Rooms & lodging | View | View | Create/Edit | — | View | Full |
| Maintenance entries | — | View | — | Create/Edit | View | Full |
| Approvals queue | Raise | Raise | Raise | — | Approve/Reject | Full |
| Event lock & billing | — | Sign-off | Sign-off | Sign-off | Sign-off | Lock + Bill |
| Roles & users | — | — | — | — | View | Full |
| Audit trail | — | — | — | — | View | Full |

---

## 3. Property inventory (master data)

All inventory below is seed data, editable by Admin in a Venue Master and Lodging Master screen. Prices shown are wedding-event rates; the system supports per-event-type rate cards with effective dates.

### 3.1 Banquet halls

> **Corrected 17 Jul 2026 (M0).** An earlier draft of this table listed every rate in a
> single "Wedding rate" column. That was a summarisation error: the hotel's 2026 venue
> proposal prices several halls for **mahila sangeet / engagement only**, and prices the
> corresponding wedding as a *bundle*. Rates below are now per event type, exactly as
> the proposal prints them. **The proposal is authoritative over this table.**

| Hall | Property | Capacity (pax) | Rate | Applies to |
|---|---|---|---|---|
| Kohinoor | Regency | 150–250 | Rs. 55,000 + taxes | Mahila sangeet, engagement |
| Imperial | Regency | 250–400 | Rs. 75,000 + taxes | Mahila sangeet, engagement |
| Imperial + Kohinoor (bundle) | Regency | 400–650 | Rs. 1,51,000 + taxes | Wedding |
| Crystal | Palace | 300–450 | Rs. 1,51,000 + taxes | Wedding; also mahila sangeet / engagement at the same rate |
| Signature | Dipali Grand | 300–600 | Rs. 2,00,000 + taxes | Mahila sangeet, engagement, wedding |
| Diamond + Golden Hall (bundle) | Palace | 1–75 (Golden capacity unconfirmed) | Rs. 25,000 | Mahila sangeet, engagement |
| Upper Hall | Residency | 1–50 | Package-based — **no rate card** | — |
| Utsav Hall | Regency | 1–50 | Package-based — **no rate card** | — |
| Saffron Hall & Lawn | Regency | — | Rs. 55,000 (hall 35,000 / lawn 20,000) | Wedding |

Diamond Hall is "usually assigned within a package" — no automation, see open question 6.

**Kohinoor and Imperial have no standalone wedding rate.** The 2026 proposal prices a
wedding at those halls only as the Imperial + Kohinoor bundle. See open question 7.

**BR-R1 — a missing rate is a gate, never a zero.** Where a venue + event type has no
rate card (Upper Hall, Utsav Hall, a standalone Imperial/Kohinoor wedding), the system
shall block confirmation with *"No rate defined for this venue for this event type —
needs a manual rate with Higher Authority approval"*, and proceed only once a rate card
exists or an Authority-approved manual rate is recorded on that sub-event. It shall
never price the sub-event at zero and never fail silently.

### 3.2 Lawns

| Lawn | Property | Capacity (pax) | Wedding rate |
|---|---|---|---|
| Tulip Lawn + Mandap Hall | Regency | 500–900 | Rs. 1,75,000 + taxes |
| Gulmohar Lawn + Middle Lawn | Palace | 500–1,000 | Rs. 2,25,000 + taxes |
| Lotus Lawn | Dipali Grand | 500–1,200 | Rs. 1,75,000 + taxes |
| Lotus Lawn + Signature Hall | Dipali Grand | — | Rs. 5,00,000 + taxes |

Combined-venue offerings (Imperial+Kohinoor, Lotus+Signature, Gulmohar+Middle, Diamond+Golden) are modelled as **venue bundles**: booking a bundle blocks all member venues for that slot. Tulip Lawn + Mandap Hall and Saffron Hall & Lawn are each modelled as a single venue, not a bundle — the proposal never prices their halves separately (Saffron's 35,000/20,000 split is informational; see open question 8).

### 3.3 Lodging units

| Unit | Rooms | Structure | Room types & rack rates |
|---|---|---|---|
| Palace | 36 rooms | 33 Deluxe, 3 Suite + Dormitory A-block and B-block (18 beds each) | Deluxe Rs. 5,000; Suite Rs. 8,000; Dormitory Rs. 35,000 (+taxes) |
| Regency | 49 rooms | 3 blocks: A, B, C | Deluxe Rs. 4,500; Semi-suite Rs. 6,000; Suite Rs. 7,000; Dormitory (30 beds) Rs. 50,000 (+taxes) |
| Dipali Grand / Regency A-block | — | Executive Deluxe Rs. 7,000; Presidential Suite Rs. 11,000 (+taxes) | — |

**Business rule (BR-L1):** For wedding events booked on the lawns, **Palace is the preferred/default lodging unit** — the system pre-selects Palace room blocks on the rooms step, and the Lodge Manager may override with a reason.

---

## 4. Core concepts

1. **Event (primary event):** One guest engagement — e.g. "Sharma Wedding, 18–21 Jul". Carries guest details, event type, date range, status, and owns everything below.
2. **Sub-event:** The atomic operational unit. One function within the event — sangeet, haldi, wedding, reception, or any custom-named function. Each sub-event has its own date, time window, venue (or bundle), pax, menu snapshot, and add-ons. All clash checks, day sheets, and bill lines derive from sub-events.
3. **Venue-day slot:** A venue on a date has two bookable portions: the **carryover slot** (midnight–11:00 AM, belonging to the previous day's event) and the **main slot** (11:00 AM onward). This encodes the house rule that an outgoing event must wrap up by 11 AM before the next event can begin at the same venue.
4. **Menu snapshot:** On menu save, the chosen tier, its price, category pick-counts, and selected items are copied onto the sub-event. Later changes to the menu master never alter existing bookings.
5. **Exception (approval request):** Any request that deviates from standard rules — chiefly menu-quantity increases beyond the free allowance — raised by a role, resolved by the GM, and logged.
6. **Room block:** A set of rooms/dormitory beds from a lodging unit allocated to an event for a date range.
7. **Maintenance entry:** An event-linked cost line (item, qty, rate, remarks, attachment) created by the Maintenance team.
8. **Lock:** The terminal editing state. All designation checklists complete → Auditor locks → record becomes read-only → bill drafts from locked data.

### 4.1 Event status lifecycle

`Enquiry → Confirmed → In Progress → Completed → Locked → Billed → Closed` (plus `Cancelled` from any pre-lock state).

- **Enquiry:** Nothing is blocked, and nothing appears on the calendar board (FR-2.5, amended 17 Jul 2026). Multiple enquiries may target the same slot; contention is surfaced through the inline availability check and the pipeline report rather than the board.
- **Confirmed:** Calendar slots block; first confirmation wins a contested slot, and competing open enquiries on that slot flip to "no longer available". Edits after confirmation are versioned and, where they touch venue/date/time, require Banquet Manager approval.
- **In Progress:** Event dates have begun; Maintenance can log entries.
- **Completed:** Last sub-event finished; designations complete their checklists.
- **Locked:** Immutable. Only the Auditor can lock, and only when every checklist item is green.
- **Billed / Closed:** Consolidated bill generated; payments recorded; event archived.

---

## 5. Functional requirements

Requirements are numbered FR-x.y. "Shall" items are mandatory for v1.

### 5.1 Enquiry & booking (Booking Manager)

- FR-1.1 The system shall provide a five-step booking wizard: (1) dates & availability, (2) event type & structure, (3) sub-event details, (4) room requirements, (5) review & confirm.
- FR-1.2 Step 1 shall show live venue availability for the chosen date range, including carryover ("frees at 11 AM") states. *(Amended 17 Jul 2026 — the requirement to show "the count of other open enquiries per venue-date" is withdrawn; see FR-2.5.)*
- FR-1.3 Step 2 shall offer configurable event types (Wedding, Engagement, Mahila Sangeet, Birthday, Corporate, Other/custom). A wedding may span 1–2 days with 2–4 sub-events by default; the manager may add or remove sub-events freely.
- FR-1.4 Step 3 shall capture, per sub-event: name, date, start–end time, venue or bundle, pax, menu tier, dish selections (may be deferred), and add-ons. Availability is validated inline the moment date + venue + time are set.
- FR-1.5 Different sub-events of one event may occur at different venues, on different properties, with different pax and menus.
- FR-1.6 Step 4 shall capture room requirements (counts by room type, dormitory needs, date range) and hand them to the Lodge Manager as a pending allocation task. For lawn weddings the system shall pre-select Palace as the lodging unit (BR-L1).
- FR-1.7 Confirmation shall require guest name, contact number(s) per FR-1.11, Aadhaar images on file (FR-1.10 — relaxed 22 Jul 2026, captured later from the booking page), and **a recorded down payment with an internal receipt number** (BR-P1); only this recorded payment atomically blocks all venue-day slots of every sub-event. If any slot was taken between validation and confirm, the confirm fails with a clear message.
- FR-1.7a **A part payment confirms (client's lead, amended 4 Aug 2026).** The 25% is no longer a gate on confirmation but a debt carried by it. A guest who brings less than 25% is confirmed all the same, blocks the venue windows like any other booking, and the balance of the advance is shown as **Downpayment due** on the calendar, on the booking, and in the audit trail. "we cant let them go so what our team decided is lets take that money." Only an advance of **zero**, or one without a receipt number, is still refused — a date is held against money or not at all. The shortfall carries no deadline and raises no exception: it surfaces when a competing enquiry wants the same date, and the Booking Manager rings the Higher Authority, who may cancel the booking (§4.1).
- FR-1.8 An enquiry with no activity for a configurable number of days (default 7) shall be flagged stale on the Booking Manager's dashboard.
- FR-1.9 Post-confirmation edits shall create a change request: changes to pax, menu, or add-ons apply directly with versioning; changes to date, time, or venue require Banquet Manager approval before taking effect.
- FR-1.10 KYC at intake: the wizard shall capture photographs of the guest's Aadhaar card, front and back, stored against the event and visible only to roles holding Bookings view permission.
- FR-1.11 Contact numbers: wedding events shall capture three contact numbers; every other event type captures one.
- FR-1.12 Tentative menus: menus stay in a tentative, swappable state (e.g. replacing a Chinese live counter with a dosa counter) until finalised on the lock checklist; every swap is versioned in the audit trail.

### 5.2 Venue calendar & clash engine (Banquet Manager)

- FR-2.1 The system shall render a rolling calendar board — venues as rows, dates as columns — defaulting to the next 15 days. The Banquet Manager's operational access is limited to this rolling 15-day window; Auditor and Higher Authority may open any date range.
- FR-2.2 **Venue time-overlap (BR-C1, amended 17 Jul 2026).** A new booking may occupy a venue only if its time window does not overlap any existing booking on that venue. A venue may therefore host several sub-events on the same day (e.g. a morning haldi and an evening sangeet) provided their windows don't overlap. **Back-to-back is permitted** — a window ending at 15:00 and another starting at 15:00 do not conflict. A window whose end time is at or before its start time runs past midnight into the next day, and the occupancy range blocks the next morning accordingly. **Amended 12 Aug 2026:** that occupancy is unchanged, but the venue is *charged* and *drawn* by the day it STARTS on — see FR-2.2a. The fixed carryover/main-slot model and the 11 AM handover are withdrawn. *(Client-confirmed: "simple logic — if time doesn't overlap, booking accepted"; the booking form captures start and end time.)*
- FR-2.3 Booking a venue bundle shall block every member venue for the same window; booking any member venue shall block the bundle for that window.
- FR-2.4 The Banquet Manager shall have a per-date Day Sheet consolidating all sub-events of that date: venue, timing, pax, menu tier, selected dishes, add-ons, and special notes — printable/exportable as the kitchen & operations order.
- FR-2.2a **The hall is charged once a day, not once a function.** *(Client, 12 Aug 2026, after staff hit it in the field.)* Hiring a venue takes it for the day — check-in 9 AM to check-out 8 AM the next morning — and any number of functions, with any number of different menus, may run inside that window for one hire charge. Three functions in one hall on one day were billing the venue three times. The **earliest** function of a venue-day carries the charge; the rest are shown as included in it, never as a blank line. A different venue on the same day is a separate let, as is the same venue on another day. This changes only the price: FR-2.2's overlap rule is untouched and the windows still may not collide.

- FR-2.5 **The calendar carries locked-in deals only.** *(Amended 17 Jul 2026.)* Only events that have reached Confirmed or beyond (Confirmed, In Progress, Completed, Locked, Billed, Closed) appear on the board. Enquiries are never rendered, and the enquiry-contested (dashed, with count) state is withdrawn. The calendar shall visually distinguish confirmed and in-progress states. *(Amended 12 Aug 2026: the carryover tail is withdrawn — a sub-event running past midnight is drawn on its start day only, marked "⁺¹". Hiring a hall takes it 9 AM to 8 AM the next morning, so the night it ends in belongs to the same let and painting the next day as taken lost a sellable day. The GiST exclusion is unchanged and still refuses a clashing booking.)*

  *Rationale and consequence:* the board is an operational view of committed business, not a pipeline view. Slot contention between competing enquiries is therefore **not** visible on the calendar — a Booking Manager taking a second enquiry for a contested slot sees only that the slot is still unblocked. Contention remains visible through `/availability` (FR-1.4's inline check) and the pipeline report (§7.3). "First confirmation wins", and losers flipping to "no longer available" (§4.1, FR-9.1), are unchanged — only the board's rendering changes.
- FR-2.6 **Withdrawn — pax is not capped by the venue.** *(Client, 3 Aug 2026.)* The Booking Manager enters whatever head count the guest gives him; `venues.capacity_min`/`capacity_max` no longer gate the figure, no override note is demanded, and neither the form nor the API refuses an out-of-range number. *Rationale:* the hotel seats guests across a lawn and its adjoining hall in combinations the stored range does not describe, and for half the venues that range was invented in the first place (SEED_ASSUMPTIONS A3/A4) — a manager taking a booking should not have to argue with it. The columns stay: they still describe the venues, and `sub_events.pax_override_note` keeps the notes already recorded against past bookings. A positive whole number below 100,000 is still required, as a typo guard.

### 5.3 Menu management

- FR-3.1 Menu masters shall be data-driven: Tier (Silver, Gold, Platinum, Diamond, Crown, plus Breakfast Gold/Platinum and High-Tea Silver) → Category (welcome drink, soup, appetizer/starter, veg main course, paneer main course, dal, rice, breads, dessert, salad, raita, live counter, pickle/chutney/papad counters) → Items. Each tier defines a per-plate price with effective-from date and a pick-count per category (e.g. Platinum: welcome drink any 3, starters any 4).
- FR-3.2 The dish picker shall enforce pick-counts per category, show per-category and overall completion, and allow saving an incomplete menu; menu completion is a lock-checklist item, not a booking gate.
- FR-3.3 On save, tier price, pick-counts, and chosen items are snapshotted onto the sub-event (BR-M1). Menu-master edits never alter saved snapshots.
- FR-3.4 **Free increase rule (BR-M2):** Per sub-event, the guest may increase the pick-count of exactly ONE category from the set {Salad, Appetizer/Starter, Main Course, Soup} by one item, without approval. The Booking Manager applies it directly; the system records which category consumed the free increase.
- FR-3.5 **GM approval rule (BR-M3):** Any further increase — a second increase in the same or another of those four categories, or any increase in any other category (paneer, dal, dessert, live counter, etc.) — shall automatically raise an Exception to the Higher Authority approvals queue. The increase takes effect only on approval; rejection reverts the menu with the Authority's remark visible to the Booking Manager.
- FR-3.6 Add-ons (items outside the tier, e.g. paan counter, extra live counter) shall carry their own description and rate and flow to the bill as separate lines.
- FR-3.7 An event shall not be lockable while any menu exception is pending (BR-M4).
- FR-3.8 **Wedding surcharge (BR-M5):** for wedding events, every tier's per-plate rate is the base rate + Rs. 50 (Silver 650→700, Gold 750→800, Platinum 850→900, Diamond 950→1000, Crown 1250→1300). The surcharge is a master value applied automatically by event type and captured in the menu snapshot.

### 5.4 Lodging & rooms (Lodge Manager)

- FR-4.1 Lodging masters: units (Palace: 36 rooms — 33 Deluxe, 3 Suite; dormitory blocks A and B, 18 beds each; Regency: 49 rooms in blocks A, B, C with room-type mapping; Grand/Regency A-block executive inventory), each room with number, block, type, and rack rate.
- FR-4.2 The Lodge Manager shall see pending room requirements from confirmed events and allocate specific rooms/blocks/dormitories per date range against them.
- FR-4.3 The system shall prevent allocating the same room to two events on overlapping dates (hard block).
- FR-4.4 For lawn weddings, Palace inventory is presented first (BR-L1); overriding to another unit requires a reason note.
- FR-4.5 A rooms board shall show, per event: promised vs allocated vs occupied counts, with variances highlighted; unresolved variance blocks the Lodge Manager's lock sign-off.
- FR-4.6 Room charges (count × nights × snapshotted rate, or negotiated package rate with note) shall flow to the consolidated bill.
- FR-4.7 **Large allocation approval (BR-L2):** if the total rooms selected for an event reaches 35 or more, the allocation shall raise a Higher Authority exception and takes effect only on approval.

### 5.5 Maintenance

- FR-5.1 Maintenance users shall see events in In Progress or Completed states and add cost entries: item, quantity, unit, rate, amount, remarks, optional photo/receipt attachment.
- FR-5.2 Entries are editable by their creator until the maintenance section for the event is marked closed by the Maintenance lead; closure is a lock-checklist item.
- FR-5.3 All closed entries flow to the bill as itemised maintenance lines.

### 5.6 Higher Authority approvals

- FR-6.1 A single approvals queue shall list all pending exceptions (menu increases beyond the free allowance, 35+ room allocations, discounts beyond the 10% cap, overdue wedding balances, and any future exception types) with event context, requested change, requester, and age.
- FR-6.1a **Bundled by proposal (client's lead, amended 1 Aug 2026).** The queue is grouped by BOOKING, not by request: every pending ask on one proposal — menu increases from any function, the 35+ room request, an over-cap discount, and venue/date/time change requests (FR-1.9), which no longer have a queue of their own — is presented as a single item the Authority opens once. A request raised later joins the same bundle, whether or not part of that bundle has already been decided; nothing about *when* a request is raised changes, only how it is read and settled.
- FR-6.2 Authority actions: Approve, Reject (remark mandatory), or Approve-with-modification. Every action is audit-logged and notifies the requester.
- FR-6.2a **Deciding by editing (client's lead, 1 Aug 2026).** Beneath the asks the Authority sees the full proposal as the Booking Manager filled it, live and editable, with the requested items marked. He may change any of it — functions, dates, venues, pax, dish selections, room lines, discounts — and his edits are written straight to the booking, not returned as instructions. Leaving a requested item as it stands approves it; removing it refuses it. An ask answered this way is recorded as decided and its deferred change is not applied a second time. All asks and all edits on one proposal commit in a single transaction, and the Booking Manager is notified of what changed.
- FR-6.2b **The Authority's override (client's lead, 1 Aug 2026).** The Authority (and Auditor) may edit a booking in any status, including Locked, Billed and Closed — the one exception to FR-7.2's immutability. A reason is mandatory and is recorded against every field changed. Editing a booking whose document has been finalised supersedes that document and issues a new numbered version (FR-7.4); the superseded version is retained, never altered. The override extends to the workflow only: the venue-overlap exclusion (BR-C1), the lodge's physical inventory (FR-4.x) and the append-only audit log (FR-10.x) are not waivable by anyone.
- FR-6.3 The Authority dashboard shall show pending-approval count, upcoming high-value events, and exception history per event.

### 5.7 Event lock & billing (Auditor)

- FR-7.1 The lock checklist per event shall include, at minimum: all sub-event menus complete; no pending exceptions; Banquet Manager day-sheet sign-off; Lodge Manager rooms reconciliation sign-off; Maintenance closure; advances/payments recorded to date.
- FR-7.2 Lock is executable only by the Auditor and only when every checklist item is complete; lock freezes all event data.
- FR-7.3 The consolidated bill shall draft automatically from locked data with sections: venue charges (per sub-event, from the event-type rate card snapshot), food (pax × per-plate tier price per sub-event, plus approved increases and add-ons), rooms & dormitories, maintenance lines, less advances received; taxes computed per line at configurable GST rates per charge category, producing a GST-compliant invoice (invoice number series, HSN/SAC per line, hotel GSTIN, guest details).
- FR-7.4 The Auditor may add discount/adjustment lines with mandatory remarks before finalising; finalisation assigns the invoice number and moves the event to Billed.
- FR-7.5 Payments (advance and settlement) shall be recordable against the event with mode, date, reference; the bill shows outstanding balance; full settlement enables Closed.
- FR-7.6 The printed final draft/bill shall append the hotel's Terms & Conditions (static text supplied by the client, maintained by Admin in masters) followed by signature blocks for the guest and every designation, for physical signing.
- FR-7.7 Payment ledger: part-payments of any amount are recorded as they arrive (date, amount, mode, internal receipt number); the event shows running paid-vs-balance and the complete receipt trail internally.

### 5.8 Roles, users & administration

- FR-8.1 Admin shall create roles, edit the permission matrix (module × view/create-edit/delete), and manage users (name, mobile, role, active flag).
- FR-8.2 Authentication: mobile/email + password with OTP-based reset; sessions expire after configurable inactivity.
- FR-8.3 Masters administration: venues, bundles, rate cards (per event type, effective-dated), menu tiers/categories/items, lodging inventory, tax rates, invoice series — all Admin-editable without code changes.

### 5.9 Notifications

- FR-9.1 In-app notifications (v1) for: enquiry going stale, slot lost to a competing confirmation, change request raised/decided, exception raised/decided, wedding balance due at D-30 and subsequent payment reminders with Authority escalation, checklist item pending as event end approaches, lock executed, bill finalised. WhatsApp/SMS integration is a v1.1 candidate.

### 5.10 Discounts & payment schedule

- FR-11.1 Discounts may be given at any head — menu, venue, room — or as an overall adjustment, each with a mandatory remark; the system computes the combined discount live against the proposal total.
- FR-11.1a **A discount is an amount of money (client's lead, 4 Aug 2026),** replacing the percentage-of-a-head input introduced on 25 Jul 2026. The user enters rupees and the guest receives exactly that, whatever the bill does afterwards; the percentage survives only as the arithmetic BR-D2's cap is tested in. The screen states the remaining headroom in rupees for the same reason. Percentage rows written before this date keep recomputing live against their head, so existing bookings are undisturbed.
- FR-11.2 **Room discount caps (BR-D1):** maximum Rs. 500 discount per room for all room categories, except Suite and Presidential Suite which allow up to Rs. 1,000 per room.
- FR-11.3 **Overall cap (BR-D2):** the combined discount across all heads must remain ≤ 10% of the total bill — venue + food + rooms, pre-tax (amended 25 Jul 2026; was venue+food only). **No GST enters that base — neither band of the room tax, nor the 18%** (FR-11.7, FR-11.7a). Exceeding the cap auto-raises a Higher Authority exception; the discounted proposal cannot be confirmed until approved. Per-room caps (BR-D1, FR-11.2) are retired now that rooms are booked in bulk.
- FR-11.3b **The cap is re-tested at confirmation (4 Aug 2026).** A percentage discount shrank with the bill and so could never drift over the cap unaided; a fixed rupee figure (FR-11.1a) can, if a function is removed after it was given. Confirmation applies the same test once more and refuses with a message naming the new combined figure. It does not bind the Higher Authority, here as anywhere (FR-11.3a).
- FR-11.3a **The Authority's own discount (client's lead, amended 1 Aug 2026; widened 3 Aug 2026 to every screen he can reach — the approvals queue, the Payment review, and the event's Billing panel — since the same discount changing answer depending on which page he was on was an accident of where the rule was coded, not a rule).** A discount entered by the Higher Authority himself is exempt from BR-D2's cap: it is recorded with no linked exception and takes effect immediately. The cap exists to route a large discount *to* him, and there is no one at the other end of that round trip when he is the one giving it. He may give it as a flat rupee amount (stored fixed) or as a percentage of a head (recomputed live, per FR-11.1); either way it flows through the bill, the balance, the advance base and every other reader of the effective discount. The mandatory remark is not waived.
- FR-11.4 **Date-block payment (BR-P1, amended 4 Aug 2026):** venue dates block when a down payment is recorded against an internal receipt number; the confirm screen prompts the Booking Manager to attest that payment was received. The full down payment is **25% of the amount payable** — venue + food + add-ons + rooms + the room GST, whichever band each room falls in (client, 20/25 Jul 2026; FR-11.7a), less discounts. A part payment blocks the dates too and leaves the remainder due (FR-1.7a).
- FR-11.5 **Wedding milestone (BR-P2, amended 4 Aug 2026):** for weddings, the total received must reach **50% of the amount payable** by 30 days before the first function — not the whole remaining 75%, which the hotel asked for and did not collect. Anything above 50% is accepted and never refused; the rest settles at billing. The system notifies the Booking Manager at D-30 and reminds through D-21; if still short from D-20 onward, reminders also go to the Higher Authority, and the reminder states the gap to 50% rather than the whole balance. A wedding already at 50% generates no reminders.
- FR-11.5a **Milestones are floors on the cumulative total received, not instalments.** 25% at confirmation, 50% at D-30 for weddings, 100% at billing. A guest who pays 60% up front has met the wedding milestone and owes nothing at D-30. The event's Billing panel shows each milestone with what is required, what has arrived, and what is short — "so that whenever they reopen the proposal they can get how much is due".
- FR-11.6 Non-wedding events follow the 25% block payment with settlement at billing, unless configured otherwise in masters.
- FR-11.7 **GST is two different things (client's lead, 4 Aug 2026), and only one of them is money.** **Rooms carry GST that is printed and collected**: it is inside the amount payable, inside the 25% advance base, and inside the balance. **Everything else carries 18%** — venue, food, add-ons, maintenance — which is printed on the document and collected from nobody: "at the end we are just showing we are taking 18% gst but we wont be taking it." Every guest-facing and internal money view therefore shows **two** totals, **Total** (with all tax) and **Amount payable**, never one alone. The 18% enters no threshold and no balance; were it inside the balance, no booking could ever reach zero and none could be settled or closed. This supersedes the 20 Jul 2026 instruction that only rooms are taxed, and answers open question 5 — with the caveat recorded in SEED_ASSUMPTIONS §F8.
- FR-11.7a **The room rate is 5% or 18%, by what one night costs (client, 17 Aug 2026):** *"if the room price is greater then 7500 then on it we will take 18% rather then 5% tax but that 18% tax will be added to payable."* Strictly above ₹7,500, so a room at exactly ₹7,500 stays at 5%. **A dormitory is exempt whatever it costs** (same instruction): its rate buys a room of 18–30 beds rather than a bed, so the threshold does not speak to it. That exemption is recognised from the category name, since `room_type` is free text — see SEED_ASSUMPTIONS §F8. **The 18% on a room is collected** and behaves in every way like the 5% it replaces — in the payable, the 25%, the wedding 50% and the balance. It is *not* the shown-and-not-collected 18% of FR-11.7, and the two are never summed: the collected/shown split stays keyed on the charge head, and only the rate is per line. The band is read off the **nightly rate**, never the line total. It applies wherever a room is charged, including extra rooms handed over on the day by the Lodge Manager (FR-4.7). **The bifurcation must be visible**: any document or panel showing room GST states the 5% and the 18% as separate lines with the money each was charged on, and marks the accommodation lines in the higher band.
- FR-11.7b **The document does not explain the shown-not-collected 18% (client, 17 Aug 2026):** *"only officials should be knowing that we are not taking 18% tax, it should not be on paper."* The two totals still print and every instalment is still measured against the payable one, but the notes stating that the 18% is shown for the guest's records and not collected are removed from the proposal. Staff-facing views keep saying it plainly — a counter reading the printed Total instead of the Amount payable is exactly the failure FR-11.7 exists to prevent.

---

## 6. Audit trail

- FR-10.1 Every create/update/delete on event-related data shall append an immutable log entry: entity, field, old value, new value, user, role, timestamp, and (where applicable) linked approval.
- FR-10.2 The Auditor shall view the trail per event as a chronological timeline, filterable by user, module, and date, and export it (CSV/PDF).
- FR-10.3 Trail entries are never editable or deletable, including by Admin.

---

## 7. Reports & dashboards

1. Occupancy report — venue utilisation by month, hall vs lawn.
2. Revenue report — billed revenue by property, venue, event type, and menu tier; taxes summary for GST filing.
3. Pipeline report — enquiries by status, conversion rate, lost-slot analysis.
4. Exceptions report — GM approvals by category and outcome.
5. Maintenance cost report — per event and aggregate.
6. Outstanding report — billed vs collected, ageing of balances.

---

## 8. Non-functional requirements

- NFR-1 Web application, responsive down to tablet; the calendar board and day sheet must be usable on a 10-inch screen at the venue.
- NFR-2 Concurrency-safe confirmation: slot blocking is transactional; simultaneous confirms on the same slot cannot both succeed.
- NFR-3 Role-based access enforced server-side on every API, not only in the UI.
- NFR-4 Daily automated backups; point-in-time recovery for the database.
- NFR-5 All monetary values stored in paise (integer) to avoid rounding drift; GST computed per line and rounded per invoice rules.
- NFR-6 Audit log storage is append-only.
- NFR-7 Reasonable performance: calendar board loads under 2 seconds for a 30-day window across all venues.
- NFR-8 English UI in v1; label architecture ready for Hindi localisation.

---

## 9. Phased delivery

**Phase 1 (MVP):** Roles & permissions, venue/lodging/menu masters, booking wizard, clash engine with 11 AM rule, calendar board, day sheet, menu picker with snapshot, free-increase + GM approval flow, rooms allocation, maintenance entries, lock checklist, consolidated bill draft, audit trail.

**Phase 2:** GST invoice finalisation & payment tracking, reports suite, notifications, stale-enquiry automation, exports.

**Phase 3:** WhatsApp/SMS notifications, guest-facing quotation PDF from the wizard, analytics dashboards, Hindi UI.

---

## 10. Open questions for the client

1. ~~Payment reminders: we have assumed Booking Manager reminders run D-30 to D-21 and Higher Authority is copied from D-20 onward for unpaid wedding balances.~~ **Answered 4 Aug 2026** (client's lead): the schedule stands, but the D-30 ask is a top-up to **50% of the amount payable**, not the whole remaining balance (FR-11.5). The 25% block payment does apply to non-wedding events (FR-11.6).
2. Cancellation: refund/retention rules by notice period? (**Who** may execute one was answered on 4 Aug 2026: the Higher Authority, and a booking short of its down payment is the case that prompted it — FR-1.7a.)
3. Does the 11 AM handover rule ever have exceptions (e.g. lawns with separate mandap teardown timelines), and if so who may grant them — Banquet Manager or GM?
4. ~~Should the GM approval rule also govern pax increases beyond venue capacity, or only menu items?~~ **Answered — moot.** Venue capacity stopped capping pax on 3 Aug 2026 and every remaining pax limit was removed on 4 Aug 2026 ("compleetely remove any pax llimit from everywhere"). There is no capacity to exceed and so no approval to give. `venues.capacity_min/max` remain as descriptive inventory data.
5. ~~Tax treatment confirmation: GST rates to apply per charge head.~~ **Answered 4 Aug 2026** (client's lead), superseding the 20 Jul "only rooms are taxed" ruling: **rooms 5%, everything else 18% — and the 18% is shown on the document, not collected** (FR-11.7). **Still open with the hotel's CA, not with us:** whether a GST line may be printed on a guest-facing document for tax that is not charged. See SEED_ASSUMPTIONS §F8; it is a one-constant change in `lib/tax.ts` if the answer comes back differently.
6. Should Diamond Hall's "usually assigned in package" behaviour be automatic (auto-added free to qualifying wedding packages) or manual?
7. Can Imperial or Kohinoor be booked standalone for a wedding, and at what rate? The 2026 proposal prices them for sangeet/engagement only, and prices weddings as the Imperial + Kohinoor bundle. Until answered, a standalone wedding at either hall has no rate and hits BR-R1.
8. Golden Hall: what is its real capacity, is the Rs. 25,000 for the Diamond+Golden pair together or for each hall, and can either be booked standalone? It appears on the 2026 proposal but in no earlier inventory list. Related: can Saffron Hall and its lawn be booked separately (the card prints 35,000 / 20,000)?
9. Can one venue host two sub-events on the same day (e.g. haldi 11:00–15:00 and sangeet 19:00–23:00 in the same hall)? The slot model allows one main-slot booking per venue-day, so today this is impossible even within a single event.
10. Diamond tier's live counter prints "(ANY FIVE)" but lists only four items — is an item missing, or is the correct pick four?

*(Questions 7–10 raised during M0. The full list of source-document contradictions, invented placeholder data, and what each blocks is in `SEED_ASSUMPTIONS.md`.)*
