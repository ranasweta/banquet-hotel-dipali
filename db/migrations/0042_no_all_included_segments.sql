-- ============================================================
-- 0042 · No "all included" segments — every dish is selected
-- ============================================================
-- Client, 16 Oct 2026, after 0041 made the two breakfasts tickable: "all included should not be
-- there, just you have to select items." So EVERY segment without a count — breads, salad bar,
-- accompaniments, high tea, the lot — becomes free choice: ticked, any number, nought allowed,
-- always complete, never an extra. A segment is now either "any N" (pick_count N) or free
-- choice (pick_count NULL); the third kind, all-included, is gone.
--
-- Made a CHECK rather than left to the screens, so no code path — the menu master, the seed, a
-- hand-run statement — can bring an all-included segment back. Booked menus are converted the
-- same way: their dishes were all copied in when they were all-included, so every one of them
-- stays exactly as it is, now tickable.

UPDATE menu_categories SET free_choice = true WHERE pick_count IS NULL AND NOT free_choice;
UPDATE sub_event_menu_categories SET free_choice = true WHERE base_pick IS NULL AND NOT free_choice;

ALTER TABLE menu_categories
  DROP CONSTRAINT menu_categories_free_choice_no_count,
  ADD CONSTRAINT menu_categories_free_choice_iff_no_count CHECK (free_choice = (pick_count IS NULL));

ALTER TABLE sub_event_menu_categories
  DROP CONSTRAINT semc_free_choice_no_count,
  ADD CONSTRAINT semc_free_choice_iff_no_count CHECK (free_choice = (base_pick IS NULL));
