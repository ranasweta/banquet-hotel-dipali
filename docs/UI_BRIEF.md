# UI brief — context pack for a design tool (Stitch et al.)

Hand this to the design tool alongside screenshots. It describes every screen, the words the
product is allowed to use, and the parts of the interface that carry meaning and therefore
must not be redesigned away.

**Written 20 July 2026.** If a screen changes, update it here.

---

## 1. What may change, and what may not

**Free to change:** colour, typography, spacing, radii, shadows, iconography, empty states,
the shell/navigation chrome, and the visual treatment of any card, table or form.

**Must survive any redesign** — these are behaviour, not decoration:

| Constraint | Why |
|---|---|
| Every screen is permission-gated server-side | Hiding a control is cosmetic; the route re-checks. A design that "merges" two screens can break a permission boundary. |
| Money renders to 2 decimals, never rounded for display | Stored as integer paise. A design that abbreviates "₹3.7L" loses paise the guest is billed for. |
| Status colour is never the only signal | Every coloured chip also carries text. Keep that pairing. |
| Tables scroll horizontally inside their own container | The page body must never scroll sideways. |
| The Draft / Draft 2 print view must print | It has a diagonal watermark that survives print colour-stripping. |

---

## 2. Vocabulary — house terminology, enforced

The client has fixed words. A design that relabels these is wrong even if it reads better.

- **Never "invoice".** Never **"final"**, anywhere, in any form.
- The two money documents are **Draft** (tentative, amounts still move, no number) and
  **Draft 2** (the amount payable, issued once, then locked).
- The screen that shows the money breakdown is **Payment review**.
- A booking is a **proposal**; the things inside it are **functions** (not "sub-events" in
  front of a user, though that is the internal name).
- Room categories: **deluxe, suite, presidential suite, dormitory**. Nothing else.
- Roles as shown to users: Booking Manager, Banquet Manager, Lodge Manager, Maintenance,
  Higher Authority, Auditor, Chef.

---

## 3. Colour that carries meaning

These are semantic, not brand. A new palette must keep them distinguishable from each other
and from the brand colour, in light and dark.

| Meaning | Where | Currently |
|---|---|---|
| Locked / settled | Lodging calendar, badges | red |
| Confirmed, not yet locked / pending approval | Lodging calendar, approvals | amber |
| Vacant / available / done | Lodging calendar, checklists | green |
| Carryover (a booking running past midnight) | Venue calendar | amber + "↳" glyph |
| Destructive | Delete, over-cap warnings | red |

The venue calendar additionally tints by event status (confirmed / in progress / completed /
locked). Those five need to stay separable at a glance.

---

## 4. Screens

The shell is a fixed left sidebar (240px) + scrollable main. Nav entries are filtered by
permission, so **no user sees all of these**.

### Entry
1. **`/login`** — mobile number + password. Single centred card.

### Home
2. **`/` Dashboard** — role-specific. Seven variants (booking, banquet, lodge, maintenance,
   authority, auditor, chef) built from a shared tile/list kit. KPI tiles + "needs attention"
   lists. Shown to every signed-in user regardless of module permissions.

### Bookings
3. **`/bookings`** — proposal list; status, guest, dates, value.
4. **`/bookings/new`** — the 5-step wizard. Steps: **Date & event → KYC → Functions & menu →
   Rooms → Payment review**. A stepper across the top. Step 3 holds a list of added functions
   plus an "Add function *n*" form with one-tap name chips (Mehndi, Haldi, Sangeet…). Step 3
   deliberately shows **no money**. Step 5 shows the fully itemised breakdown.
5. **`/bookings/[id]`** — event detail. Tabbed/sectioned: functions & menus, rooms, discounts,
   payments, maintenance, audit trail, and lock + payment review.
6. **`/bookings/[id]/proforma`** — printable **Draft**.
7. **`/bookings/[id]/invoice`** — printable **Draft 2**. (Route names are internal; the words
   never appear on screen.)

### Calendars
8. **`/calendar`** — venue × dates board. Sticky first column, one column per day, booking
   chips in cells. Operational roles see a rolling 15 days.
9. **`/day-sheet`** — one date's consolidated kitchen/ops order. Printable.
10. **`/rooms/calendar`** — **Lodging calendar**. 30-day month-style grid, 7 columns, each day
    cell carrying an occupancy bar + "N/total booked". Clicking a date opens a per-unit,
    per-category table: booked / vacant / held by whom. Lodge Manager's main screen.
11. **`/rooms`** — room-by-room board for one lodging unit. Reached from the lodging calendar,
    not the sidebar.

### Queues
12. **`/approvals`** — Higher Authority queue (menu increases, 35+ rooms, over-cap discounts,
    overdue balances). Approve / reject with remark.
13. **`/change-requests`** — date/time/venue change requests for the Banquet Manager.
14. **`/chef`** — off-menu "delicacy" requests awaiting a per-plate price from the Chef.
15. **`/maintenance`** — event-linked extra costs; receipt/photo upload.

### Admin
16. **`/reports`** — revenue and audit reporting.
17. **`/admin/roles`** — the permission matrix: roles × modules × (view / create-edit / delete).
    A dense grid of checkboxes. This one is genuinely hard to make pretty; prioritise scanning.
18. **`/admin/users`** — user list, role assignment.

---

## 5. Component inventory

Built on **shadcn/ui**. Only these primitives exist today: `badge, button, card, checkbox,
input, label, select, separator, sonner (toasts), table`. A design needing dialogs, tabs,
tooltips, popovers or sheets means adding primitives — flag it rather than assuming.

Feature components: `app-nav`, `booking-wizard` (+ `menu-picker`, `aadhaar-capture`),
`calendar-board`, `lodging-calendar`, `rooms-board`, `event-detail` (+ `event-rooms`,
`event-billing`, `event-maintenance`, `event-lock-invoice`, `event-trail`, `request-change`),
`invoice-print`, `approvals-queue`, `change-requests-queue`, `chef-queue`, `maintenance-log`,
`day-sheet-view`, `reports-view`, `roles-matrix`, `users-admin`, `bookings-list`,
`notification-bell`, and seven `dashboard-*` variants over `dashboard-shared`.

---

## 6. How to apply a new theme (the graceful path)

**Colour lives in one file: `app/globals.css`.** It defines shadcn's semantic tokens as
OKLCH custom properties under `:root` and `.dark` — `--background`, `--foreground`, `--card`,
`--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`,
`--ring`, `--sidebar-*`, `--chart-1..5`, plus `--radius`.

Today every one of them has **chroma 0** — the product is greyscale and has no brand colour
at all. So a palette change is roughly 25 values in one file, and no component has to be
touched. That is the whole reason a redesign here is low-risk.

Two caveats:

1. **Status colours are hardcoded Tailwind palette classes** (`bg-rose-500`, `text-emerald-600`,
   `bg-amber-50` …) in the calendars and badges, because they mean something fixed rather than
   "brand". They will not follow a token change and must be re-checked for contrast against
   the new background — in **both** light and dark.
2. **A generated design will usually assume components the project doesn't have.** Prefer
   restyling an existing primitive over introducing a new dependency.

Ask the design tool for **tokens, not screenshots of components**: a light and dark palette
expressed as the variable names above. That drops straight in.
