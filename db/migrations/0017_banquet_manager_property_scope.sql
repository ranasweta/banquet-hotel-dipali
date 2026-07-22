-- ============================================================
-- 0017 · Each Banquet Manager sees only their own venues (client, 22 Jul 2026)
-- ============================================================
-- "only their lodge — regency is the dipali grand."
--
-- A Banquet Manager's 15-day board is scoped to the venues they are responsible for. The
-- link lives on `properties`, not on the user, because one manager can own several: the
-- Regency manager covers Dipali Grand as well ("regency is the dipali grand"). A column on
-- the user could not express that.
--
-- The three banquet properties are Palace, Regency and Dipali Grand — there is NO Residency
-- property (Residency is lodging only, rooms with no venues). So the Residency manager owns
-- nothing here and their board is empty until a Residency venue exists. That is a data fact,
-- flagged rather than hidden: the mechanism is right, the inventory simply has no venues for
-- them yet.
--
-- NULLABLE: a property with no banquet manager set is visible to nobody's scoped board,
-- which is the safe default — better an empty board than someone else's functions.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS banquet_manager_id uuid REFERENCES users(id);

COMMENT ON COLUMN properties.banquet_manager_id IS
  'The Banquet Manager responsible for this property''s venues. One manager may own several '
  '(Regency covers Dipali Grand). NULL means no scoped board shows it.';

CREATE INDEX IF NOT EXISTS properties_banquet_manager ON properties (banquet_manager_id)
  WHERE banquet_manager_id IS NOT NULL;

-- Assign by the manager's name, which migration 0016 set by lodge. Guarded on the current
-- value being NULL so a deliberate reassignment is not undone on re-run.
UPDATE properties p
   SET banquet_manager_id = u.id
  FROM users u JOIN roles r ON r.id = u.role_id
 WHERE r.name = 'banquet_manager'
   AND p.banquet_manager_id IS NULL
   AND (
     -- Palace -> Palace manager, Regency -> Regency manager.
     (p.name = 'Palace'   AND u.full_name = 'Banquet Manager — Palace') OR
     (p.name = 'Regency'  AND u.full_name = 'Banquet Manager — Regency') OR
     -- Dipali Grand is Regency's (client, 22 Jul 2026).
     (p.name = 'Dipali Grand' AND u.full_name = 'Banquet Manager — Regency')
   );
