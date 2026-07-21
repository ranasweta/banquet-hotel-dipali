-- ============================================================
-- 0012 · Menu increases apply now, reach the GM at lock (client, 21 Jul 2026)
-- ============================================================
-- The old flow raised a request the instant someone pressed increase, and withheld the
-- pick until it was approved. Both halves were wrong. A wedding is decided over days: the
-- manager adds dishes to Haldi, comes back for Sangeet, the guest changes their mind. None
-- of that is the Authority's business until the proposal is finished.
--
-- So: an increase applies immediately, and the ones beyond the free allowance are simply
-- remembered. At lock they go out together, as one request per proposal, itemised by
-- function and segment — the client's analogy is a chef delicacy request: raised when the
-- work is done, carrying everything needed to decide.
--
-- `approved_extra_picks` is what makes "remembered" possible. It tracks how many of a
-- segment's extra picks the Authority has actually sanctioned:
--
--   extra_picks - approved_extra_picks  = awaiting approval
--
-- The free allowance counts as approved on the spot, so it never reaches the queue.
-- A partial approval lowers `extra_picks` back to the approved figure, and the selections
-- above the new limit are rolled out with it.

ALTER TABLE sub_event_menu_categories
  ADD COLUMN IF NOT EXISTS approved_extra_picks int NOT NULL DEFAULT 0;

COMMENT ON COLUMN sub_event_menu_categories.approved_extra_picks IS
  'How many of extra_picks the Higher Authority has sanctioned. The difference against '
  'extra_picks is what is still awaiting a decision at lock. Free increases count as '
  'approved immediately.';

-- Rows that predate this column were only ever incremented through the old exception path,
-- which withheld the pick until approval — so anything already applied WAS approved. Treat
-- it as such rather than re-asking the Authority for decisions it has already made.
UPDATE sub_event_menu_categories
   SET approved_extra_picks = extra_picks
 WHERE approved_extra_picks = 0 AND extra_picks > 0;

ALTER TABLE sub_event_menu_categories
  ADD CONSTRAINT sub_event_menu_categories_approved_chk
  CHECK (approved_extra_picks >= 0 AND approved_extra_picks <= extra_picks);
