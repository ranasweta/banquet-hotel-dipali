-- ============================================================
-- 0009 · Rooms are booked in bulk on the proposal (client, 21 Jul 2026)
-- ============================================================
-- The model changes shape. Rooms are no longer assigned room-by-room by a Lodge Manager
-- after confirmation; the proposal states **which lodge, which category, how many, which
-- dates**, and that is the booking. Room numbers are the reception desk's business and are
-- deliberately outside this system.
--
-- `room_requirements` already carried category + count + dates, but not the unit, so it
-- could not say whether "3 deluxe" meant Palace or Regency — which the lodging calendar is
-- organised by. This adds it.
--
-- NULLABLE on purpose. Rows captured before today have no unit and there is no honest way
-- to infer one: a deluxe room exists in all three lodges at three different rates, so any
-- backfill would be a guess written into billing data. They are left NULL and the read path
-- reports them separately rather than silently attributing them to a lodge.

ALTER TABLE room_requirements
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES lodging_units(id);

COMMENT ON COLUMN room_requirements.unit_id IS
  'Which lodge the rooms are taken from. NULL only for rows captured before 21 Jul 2026, '
  'when the proposal did not ask — never inferred.';

-- The lodging calendar sums these per unit, per category, per night, so the read is always
-- "which requirements overlap this date" for a given unit.
CREATE INDEX IF NOT EXISTS room_requirements_unit_dates
  ON room_requirements (unit_id, check_in, check_out);
