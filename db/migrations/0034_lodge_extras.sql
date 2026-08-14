-- ============================================================
-- 0034 · The Lodge Manager's extras — rooms given during the event, and in-room dining
-- ============================================================
-- Client, 15 Aug 2026. Two charges the desk has been carrying on paper because the system had
-- nowhere to put them:
--
--   EXTRA ROOMS. A wedding party arrives larger than it was booked and the Lodge Manager gives
--   them rooms out of whatever is free — four more Deluxe for two nights. The booking's
--   `room_requirements` are what was SOLD at proposal time and must not be edited to cover it:
--   those lines are frozen at their confirmed rate (migration 0032) and are the base of the 25%
--   advance and the wedding 50%, both of which fell due months before anybody walked in.
--   Rewriting them would move a threshold backwards and make a met milestone retrospectively
--   short — the exact failure CLAUDE.md rule 12 describes for maintenance.
--
--   IN-ROOM DINING. A guest orders food to the room. The hotel does not want it itemised here;
--   the kitchen's own docket is the itemisation. One rupee figure for the whole stay is what
--   the desk has, so one rupee figure is what this stores (client's wording: "nothing just
--   total amount in the box").
--
-- SO THEY BEHAVE LIKE MAINTENANCE, NOT LIKE A BOOKING. Logged during and after the event,
-- charged on the bill, and counted ONLY in the settlement and the balance — never in the 25%,
-- the wedding 50% or the 10% discount cap. `lib/payment-schedule.ts` already splits the base in
-- two for exactly this reason; these join maintenance on the far side of that split.
--
-- WHY `nights` AND NOT check_in/check_out. The Lodge Manager fills this in after the fact, from
-- what the desk actually gave out, and asked for a count of nights rather than a calendar range
-- (client, 15 Aug 2026). It also keeps these rooms out of the availability arithmetic, which is
-- right: `getRoomAvailability` answers "what can I still SELL", and a room already handed over
-- is not a room being sold. The hard inventory cap (rule 9) governs the booking; this records
-- what happened. A count of nights cannot express a stay, so nothing here reaches the rooms
-- board or the lodging calendar, and that is deliberate.
--
-- THE RATE IS SNAPSHOTTED (rule 4). `rate_paise` is the lodge's rate for that category at the
-- moment the line was entered, copied in like a venue's or a booked room's. Re-pricing a
-- category in the lodge master tomorrow must not move a figure the guest has already been shown
-- at checkout. There is no live fallback and no COALESCE anywhere downstream: unlike
-- `room_requirements`, one of these lines has no "still an enquiry" phase to price live for —
-- it is a record of something that has already happened, so it is priced once, at entry.
--
-- A CATEGORY WITH NO RATE IS REFUSED, NOT ZEROED (SEED_ASSUMPTIONS' standing rule). The service
-- layer looks the rate up and throws if the lodge has no active room of that category; the
-- CHECK below is the second line of that defence. Zero would silently give the rooms away.

CREATE TABLE IF NOT EXISTS additional_rooms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- Nullable to match `room_requirements.unit_id`, and for the same reason: a lodge can be
  -- retired long after the bill was printed and the line must still read back. The service
  -- requires one — the rate is per lodge (Regency Deluxe is Rs 4,500 where Palace Deluxe is
  -- Rs 5,000), so "some Deluxe somewhere" has no price.
  unit_id      uuid REFERENCES lodging_units(id),
  room_type    text NOT NULL,
  count        int NOT NULL CHECK (count > 0),
  nights       int NOT NULL CHECK (nights > 0),
  rate_paise   bigint NOT NULL CHECK (rate_paise > 0),
  -- count × nights × rate, stored rather than derived so the bill and the audit trail read the
  -- same figure the Lodge Manager was shown when they pressed Add. Same reason
  -- `maintenance_entries` stores `amount_paise` beside qty and rate.
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  remarks      text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS additional_rooms_event ON additional_rooms (event_id);

-- One row per event: the dining box, and the close that lets both kinds of extra reach the bill.
--
-- WHY THE CLOSE IS A ROW HERE AND NOT A `lock_signoffs` DESIGNATION. Maintenance closes by
-- writing `lock_signoffs (event_id, 'maintenance')` — its close IS that designation's sign-off.
-- The Lodge Manager already holds a designation sign-off, `lodge_manager`, and it means
-- something else: rooms reconciled, and it BLOCKS the lock. Overloading it would have a manager
-- who reconciled his rooms early accidentally freeze his extras, and inventing a
-- 'lodge_extras' member of `signoff_role` would put a thing that is not a designation into an
-- enum of designations. A timestamp on the extras themselves says who closed them and when,
-- with no second meaning to trip over.
--
-- WHY CLOSED-ONLY REACHES THE MONEY. Identical to maintenance (FR-5.2/5.3): an open log is
-- still being typed, and a balance that moves under the guest is worse than a late one. It is
-- read as one fact for both kinds — `closed_at IS NOT NULL` — rather than a per-row flag,
-- because the close is a single act over the whole log and two copies of one fact can drift.
CREATE TABLE IF NOT EXISTS lodge_extras (
  event_id             uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  in_room_dining_paise bigint NOT NULL DEFAULT 0 CHECK (in_room_dining_paise >= 0),
  closed_at            timestamptz,
  closed_by            uuid REFERENCES users(id),
  updated_by           uuid NOT NULL REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Locked means locked (rule 6). Both tables carry `event_id`, so the original guard applies
-- unchanged and honours the Higher Authority's `app.gm_override` GUC exactly as the other
-- event-child tables do.
DROP TRIGGER IF EXISTS additional_rooms_lock_guard ON additional_rooms;
CREATE TRIGGER additional_rooms_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON additional_rooms
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_event_write();

DROP TRIGGER IF EXISTS lodge_extras_lock_guard ON lodge_extras;
CREATE TRIGGER lodge_extras_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON lodge_extras
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_event_write();

COMMENT ON TABLE additional_rooms IS
  'Rooms given to a guest during the event beyond what was booked (client, 15 Aug 2026). '
  'Category + count + nights, priced from the lodge rate snapshotted at entry. Charged on the '
  'bill as a rooms line (5%, collected) once lodge_extras.closed_at is set; outside the 25% '
  'advance, the wedding 50% and the 10% discount cap, exactly like closed maintenance.';

COMMENT ON COLUMN lodge_extras.in_room_dining_paise IS
  'One total for the whole stay (client, 15 Aug 2026) — the kitchen dockets are the itemisation. '
  'Bills as a food line: 18% shown on the document and collected from nobody (rule 11).';
