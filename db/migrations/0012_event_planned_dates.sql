-- ============================================================
-- 0012 · The proposal's declared run window (client, 22 Jul 2026)
-- ============================================================
-- The From/To dates picked when a proposal is started ARE the event's stated window, and
-- rooms are bounded by IT — not by the functions' dates. A guest may stay the whole event
-- even when a function isn't scheduled on every day: a 25-27 Jul wedding with its only
-- function on the 25th still lets a room run 25 → 28 (checkout the morning after the 27th).
--
-- Kept separate from first_date/last_date, which cache the FUNCTIONS' span for the calendar
-- and are (re)written at confirm. These planned dates are the outer window the functions and
-- the rooms both sit inside, and confirm never touches them.
--
-- Nullable: a proposal made before this column existed has no declared window, and both the
-- room-date clamp and the room-window helper fall back to the functions' span — exactly the
-- old behaviour.
ALTER TABLE events ADD COLUMN planned_from date;
ALTER TABLE events ADD COLUMN planned_to   date;
