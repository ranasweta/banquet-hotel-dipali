-- ============================================================
-- 0041 · Breakfast menus — tick what you like (free choice)
-- ============================================================
-- Client, 15 Oct 2026: Breakfast Gold and Breakfast Platinum "should be tickable … no need to
-- just keep all the items selected", and the guest may tick "as much as they want, can be 0 too".
--
-- Until now a segment was one of two things: "any N" (pick_count N — a ceiling, complete once N
-- are in, Increase for more) or "all included" (pick_count NULL — read-only, every dish copied
-- onto the booking). A breakfast is neither: there is no count to reach and no ceiling to hit.
-- So a third kind, FREE CHOICE: pick_count stays NULL (there is no count), free_choice says the
-- dishes are ticked rather than copied, any number is allowed, nought included, and the segment
-- always counts as complete. Nothing in it is ever an extra, so it never reaches the Authority.
--
-- The flag is snapshotted onto the booking like the pick count is (rule 4), so a later change in
-- the menu master cannot turn a booked breakfast back into an all-included one.

ALTER TABLE menu_categories
  ADD COLUMN free_choice boolean NOT NULL DEFAULT false,
  -- A free-choice segment has no count. A count would be a ceiling, which is the other kind.
  ADD CONSTRAINT menu_categories_free_choice_no_count CHECK (NOT (free_choice AND pick_count IS NOT NULL));

ALTER TABLE sub_event_menu_categories
  ADD COLUMN free_choice boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT semc_free_choice_no_count CHECK (NOT (free_choice AND base_pick IS NOT NULL));

UPDATE menu_categories c
   SET free_choice = true
  FROM menu_tiers t
 WHERE t.id = c.tier_id
   AND t.name IN ('Breakfast Gold', 'Breakfast Platinum')
   AND c.pick_count IS NULL;

-- Breakfasts already booked carry every dish, copied in when they were all-included. Marking
-- their snapshot free-choice keeps every one of those dishes exactly as it is — nothing is
-- unticked here — and lets the manager untick what the guest does not want.
UPDATE sub_event_menu_categories smc
   SET free_choice = true
  FROM sub_event_menus m
 WHERE m.id = smc.menu_id
   AND m.tier_name IN ('Breakfast Gold', 'Breakfast Platinum')
   AND smc.base_pick IS NULL;
