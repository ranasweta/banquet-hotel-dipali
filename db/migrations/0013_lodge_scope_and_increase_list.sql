-- ============================================================
-- 0013 · Lodge Managers see one lodge; menu increases go out per function
-- ============================================================
-- Two changes from the client's walkthrough of 21 Jul 2026.
--
-- 1. A Lodge Manager belongs to a lodge. Palace's manager sees Palace and nothing else.
--    The three seeded managers were distinguished only by their display names — the data
--    carried no link at all, so every one of them saw all three lodges. The inventory
--    itself stays single and shared; only the read is filtered.
--
--    NULLABLE, and deliberately so: it is meaningless for every other role, and a Lodge
--    Manager with no lodge set is a configuration mistake that should surface as "no rooms
--    visible" rather than silently widen to all of them.
--
-- 2. Menu increases stop waiting for the lock, and stop being a counter.
--
--    Pressing Increase on a segment UNLOCKS it: from then on the manager may take as many
--    dishes from that segment as the guest wants. Picks made after the press are extras,
--    they render in their own colour, and they are remembered individually — by dish, not
--    as a number. That is what `is_extra` on a selection carries.
--
--    Knowing WHICH dishes are extra is what lets the per-function submit button arrive at
--    the Authority pre-filled with the items actually ticked, and it retires the old
--    partial-approval behaviour of dropping dishes in alphabetical order because the
--    snapshot could not say which ones were the additions.
--
--    `submitted_extra_picks` is the third counter alongside extra_picks and
--    approved_extra_picks:
--
--      extra_picks           - extras the guest has actually taken
--      submitted_extra_picks - how many of those have been sent to the Authority
--      approved_extra_picks  - how many have come back sanctioned
--
--    approved <= submitted <= extra. The free allowance is TWO PER FUNCTION (not per
--    segment, which would hand a four-function wedding forty free dishes) and is derived
--    at read time as min(2, total extras on the sub-event) rather than stored, so removing
--    an extra hands the allowance back automatically.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS lodging_unit_id uuid REFERENCES lodging_units(id);

COMMENT ON COLUMN users.lodging_unit_id IS
  'Which lodge a Lodge Manager is responsible for. NULL for every other role; a Lodge '
  'Manager with NULL sees no rooms, which is louder than silently showing all of them.';

CREATE INDEX IF NOT EXISTS users_lodging_unit ON users (lodging_unit_id)
  WHERE lodging_unit_id IS NOT NULL;

-- Attach the three seeded managers to the lodge named in their title. Guarded on the name
-- so it is a no-op on a database where someone has already assigned them by hand.
UPDATE users u
   SET lodging_unit_id = lu.id
  FROM lodging_units lu, roles r
 WHERE r.id = u.role_id
   AND r.name = 'lodge_manager'
   AND u.lodging_unit_id IS NULL
   AND u.full_name LIKE '%' || lu.name || '%';

-- --- 2. Per-function increase submission ------------------------------------
ALTER TABLE sub_event_menu_categories
  ADD COLUMN IF NOT EXISTS submitted_extra_picks int NOT NULL DEFAULT 0;

-- Increase pressed on this segment: picking is unbounded from here on.
ALTER TABLE sub_event_menu_categories
  ADD COLUMN IF NOT EXISTS increase_unlocked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sub_event_menu_categories.increase_unlocked IS
  'Increase has been pressed on this segment, so the manager may take any number of dishes '
  'from it. Everything above base_pick is an extra.';

-- Any segment that already carries extras was unlocked by definition.
UPDATE sub_event_menu_categories
   SET increase_unlocked = true
 WHERE extra_picks > 0 AND NOT increase_unlocked;

-- Which dish is an extra, as opposed to one of the base picks. Drives the colour in the
-- picker and the itemised list the Authority receives.
ALTER TABLE sub_event_menu_selections
  ADD COLUMN IF NOT EXISTS is_extra boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sub_event_menu_selections.is_extra IS
  'Chosen after Increase was pressed on its segment. Rendered apart in the picker and '
  'listed by name when the function submits its increases.';

COMMENT ON COLUMN sub_event_menu_categories.submitted_extra_picks IS
  'How many of extra_picks have been sent to the Authority. extra_picks minus this is what '
  'the function''s submit button will carry next time it is pressed.';

-- Anything already approved was, by definition, already submitted. Rows that predate this
-- column were governed by the lock-time batch, which submitted everything unsanctioned at
-- once — so treating approved as the submitted floor is the honest reading.
UPDATE sub_event_menu_categories
   SET submitted_extra_picks = approved_extra_picks
 WHERE submitted_extra_picks = 0 AND approved_extra_picks > 0;

ALTER TABLE sub_event_menu_categories
  ADD CONSTRAINT sub_event_menu_categories_submitted_chk
  CHECK (submitted_extra_picks >= approved_extra_picks
     AND submitted_extra_picks <= extra_picks);
