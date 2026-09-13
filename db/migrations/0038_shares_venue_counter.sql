-- ============================================================
-- 0038 · A live counter may share a hall with the booking's own functions
-- ============================================================
-- Client, 13 Sep 2026, on two bookings that could not be confirmed (E-1093 Gitesh Agrawal,
-- E-1128 Sanjay Jadiya): "only want that Hi-tea 15k for 12 hour vala menu item pr hi allow
-- kro kyunki chai din bhr chalti hai and same hall me ho skti hai but baki menues nhi ho
-- skte".
--
-- WHAT WAS HAPPENING. Both bookings carry a tea counter — `Hi-Tea Live Counter-15k for 12
-- Hours.`, a flat Rs. 15,000 for the day against 1 pax — entered as a function of its own in
-- the same hall as the breakfast it runs beside. Two functions, one venue, overlapping
-- windows: the GiST exclusion on `venue_bookings` refused the second insert at confirm, and
-- `confirmEvent` reported every exclusion violation as "another confirmed booking just took
-- this slot". No other booking was involved — the booking was colliding with itself, and the
-- message sent the manager looking for a clash that did not exist.
--
-- THE RULE (BR-C1, amended). A venue may not hold two overlapping windows — unchanged for
-- everything the hotel sells by the sitting. The single exception is a menu tier MARKED as
-- sharing: the tea/coffee counter runs all day beside whatever else is in the hall, so it may
-- overlap the OTHER FUNCTIONS OF ITS OWN BOOKING. It may not overlap anybody else's: two
-- parties in one hall is exactly what the exclusion exists to prevent, and the client's "same
-- hall" is the same guest's hall.
--
-- WHY A FLAG ON THE TIER and not a name test in code: `lib/tax.ts` keys the dormitory
-- carve-out on a name because `room_type` is free text with no row to hang a flag on. A menu
-- tier is a row, the Auditor owns it in the menu master, and the next such counter must not
-- need a developer. So it is data (venue master precedent, migration 0029) and the master
-- screen shows the flag beside the tier.
--
-- HOW IT IS ENFORCED. `venue_bookings` carries the flag as a snapshot (`shares_venue`),
-- because an exclusion constraint can only read the two rows it compares, and the old single
-- constraint is replaced by two that together say the rule exactly:
--
--   * `venue_bookings_other_event_excl` — same venue, DIFFERENT event, overlapping windows is
--     refused, sharing or not. This is the guarantee that matters under concurrency and it is
--     unweakened: two racing confirms on one hall still end with exactly one winner.
--   * `venue_bookings_same_event_excl` — the partial index holds only NON-sharing rows, so
--     within one booking two ordinary functions still cannot overlap, while a sharing counter
--     is compared against nothing and may sit inside any of them.
--
-- The flag is set by a BEFORE INSERT trigger rather than by each caller: four places insert
-- venue holds (confirm, post-confirm, an approved change request, the demo seed) and a fifth
-- will arrive. One of them forgetting would silently mis-apply the rule.
--
-- KNOWN LIMIT, deliberately not coded around: the flag is snapshotted when the hold is
-- written, so re-tiering a menu AFTER confirmation does not move it. Adding a counter to an
-- already-confirmed booking therefore means adding it at a free window, saving its Hi-Tea
-- menu, then moving it onto the function it accompanies — the move re-inserts the hold and
-- picks the flag up. An enquiry, which is where counters are actually typed, holds nothing
-- until confirm and is unaffected.

ALTER TABLE menu_tiers
  ADD COLUMN IF NOT EXISTS shares_venue boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN menu_tiers.shares_venue IS
  'A function on this tier may overlap other functions of the SAME booking in one venue '
  '(the all-day live counter). Never another booking''s — BR-C1.';

-- The counter the client named. Matched on the name because that is all that identifies it
-- today; from here the Auditor ticks the box in the menu master.
UPDATE menu_tiers SET shares_venue = true WHERE name ILIKE '%hi-tea live counter%';

ALTER TABLE venue_bookings
  ADD COLUMN IF NOT EXISTS shares_venue boolean NOT NULL DEFAULT false;

-- Holds already written for a counter (there are none that overlap — the old constraint saw
-- to that — but the flag must still describe them, or a later move would be judged wrongly).
UPDATE venue_bookings vb
   SET shares_venue = true
  FROM sub_event_menus m
  JOIN menu_tiers t ON t.id = m.tier_id
 WHERE m.sub_event_id = vb.sub_event_id
   AND t.shares_venue
   AND NOT vb.shares_venue;

CREATE OR REPLACE FUNCTION venue_booking_shares_venue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.shares_venue := COALESCE(
    (SELECT t.shares_venue
       FROM sub_event_menus m
       JOIN menu_tiers t ON t.id = m.tier_id
      WHERE m.sub_event_id = NEW.sub_event_id),
    false);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS venue_bookings_shares_venue ON venue_bookings;
CREATE TRIGGER venue_bookings_shares_venue
  BEFORE INSERT ON venue_bookings
  FOR EACH ROW EXECUTE FUNCTION venue_booking_shares_venue();

ALTER TABLE venue_bookings DROP CONSTRAINT IF EXISTS venue_bookings_venue_id_occupancy_excl;

ALTER TABLE venue_bookings
  ADD CONSTRAINT venue_bookings_other_event_excl
  EXCLUDE USING gist (venue_id WITH =, event_id WITH <>, occupancy WITH &&);

ALTER TABLE venue_bookings
  ADD CONSTRAINT venue_bookings_same_event_excl
  EXCLUDE USING gist (venue_id WITH =, occupancy WITH &&) WHERE (NOT shares_venue);
