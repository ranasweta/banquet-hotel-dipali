-- ============================================================
-- 0005 · Lodging model per the client's instruction of 20 Jul 2026
-- ============================================================
-- The seed code (db/masters.ts, db/rooms.regency.seed.json) already describes the new
-- shape; this migration brings an ALREADY-SEEDED database to the same place without a
-- reset, so existing events and allocations survive. See docs/SEED_ASSUMPTIONS.md §F1-F3.
--
--   · the third lodge is Residency, not "Grand / Regency A-block" (§F1)
--   · Palace is 38 rooms and holds no dormitory (§F1/F2)
--   · both dormitory blocks live in Regency (§F2)
--   · semi-suite is retired into suite (§F3)
--
-- Purely transformational: every statement is guarded so that on a fresh database (empty
-- tables, seed not yet run) it does nothing at all. Seeding stays the seed's job.
-- Re-running is a no-op.

-- --- 1. "Grand / Regency A-block" becomes Residency -------------------------
-- The unit carried PRD §3.3's Executive Deluxe / Presidential Suite rates but no rooms.
-- Renaming rather than dropping keeps its id, so nothing referencing it breaks.
UPDATE lodging_units
   SET name = 'Residency'
 WHERE name = 'Grand / Regency A-block'
   AND NOT EXISTS (SELECT 1 FROM lodging_units WHERE name = 'Residency');

-- Residency's 28 rooms. Rates are the Grand's, carried over on the reading that the unit
-- the client calls Residency is the one the PRD called the Grand — the 20/8 split and the
-- room numbers are invented (§F1). Executive Deluxe folds into `deluxe` (§F3), which is
-- why Residency deluxe is Rs. 7,000 against Palace's Rs. 5,000.
INSERT INTO rooms (unit_id, block, room_no, room_type, beds, rack_rate_paise)
SELECT u.id, NULL, 'R' || g, 'deluxe', 2, 700000
  FROM lodging_units u, generate_series(101, 120) AS g
 WHERE u.name = 'Residency'
ON CONFLICT (unit_id, room_no) DO NOTHING;

INSERT INTO rooms (unit_id, block, room_no, room_type, beds, rack_rate_paise)
SELECT u.id, NULL, 'R' || g, 'presidential_suite', 2, 1100000
  FROM lodging_units u, generate_series(201, 208) AS g
 WHERE u.name = 'Residency'
ON CONFLICT (unit_id, room_no) DO NOTHING;

-- --- 2. Semi-suite is retired into suite ------------------------------------
-- The client's categories are deluxe / suite / presidential / dormitory. The 11 Regency
-- semi-suites are repriced Rs. 6,000 -> Rs. 7,000, so PRD §3.3's semi-suite rate is no
-- longer represented anywhere. This also widens their BR-D1 per-room discount cap from
-- Rs. 500 to Rs. 1,000, because that cap keys off the category name (§F3).
UPDATE rooms
   SET room_type = 'suite', rack_rate_paise = 700000
 WHERE room_type = 'semi_suite';

-- --- 3. Both dormitory blocks move to Regency -------------------------------
-- Contradicts PRD §3.3, which puts blocks A and B in Palace and a single 30-bed block in
-- Regency. Recorded as an override, not applied silently (§F2).

-- Regency's own 30-bed block becomes block A.
UPDATE rooms
   SET room_no = 'DORM-A', block = 'A'
 WHERE room_no = 'DORM-1'
   AND unit_id = (SELECT id FROM lodging_units WHERE name = 'Regency');

-- Palace's 18-bed block B moves across as Regency's block B.
UPDATE rooms
   SET unit_id = (SELECT id FROM lodging_units WHERE name = 'Regency'), block = 'B'
 WHERE room_no = 'DORM-B'
   AND unit_id = (SELECT id FROM lodging_units WHERE name = 'Palace');

-- Palace's second 18-bed block is dropped, since the client described exactly two blocks.
-- Deactivated rather than deleted: a DELETE would fail against room_allocations' foreign
-- key if anyone had ever booked it, and losing that history to a data migration would be
-- worse than carrying an inactive row. Every read filters on is_active.
UPDATE rooms
   SET is_active = false
 WHERE room_no = 'DORM-A'
   AND unit_id = (SELECT id FROM lodging_units WHERE name = 'Palace');

-- --- 4. Palace reaches the client's 38 rooms --------------------------------
-- PRD §3.3 gives 36 (33 deluxe + 3 suite); the client says 38 and the dormitories have
-- just left, so the earlier "36 rooms + 2 dorms" reading no longer explains it. The two
-- extra deluxe are invented to reach the stated count — see §F1, still an open question.
INSERT INTO rooms (unit_id, block, room_no, room_type, beds, rack_rate_paise)
SELECT u.id, NULL, 'P' || g, 'deluxe', 2, 500000
  FROM lodging_units u, generate_series(134, 135) AS g
 WHERE u.name = 'Palace'
ON CONFLICT (unit_id, room_no) DO NOTHING;
