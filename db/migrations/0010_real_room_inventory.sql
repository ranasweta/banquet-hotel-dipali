-- ============================================================
-- 0010 · The hotel's real room inventory (client, 21 Jul 2026)
-- ============================================================
-- Counts and categories confirmed directly by the client; rates taken from the 2026 venue
-- proposal's three room-tariff blocks, with three points the client answered because the
-- proposal does not:
--
--   · Semi-deluxe is not on the Regency page. It is priced as Executive Deluxe, Rs. 7,000.
--   · Palace's rooms take the PALACE page (Deluxe 5,000 / Suite 8,000), NOT the proposal's
--     separate "Executive Deluxe 7,000" — asked explicitly, answered explicitly.
--   · Presidential Suite Rs. 11,000, printed under "Grand + Regency A-block", belongs to
--     Regency: that A block is Regency's own.
--
--   Regency  49 rooms  27 deluxe · 11 semi-deluxe · 6 semi-suite · 2 suite · 3 presidential
--                      + ONE dormitory (Rs. 50,000, booked whole — beds never selectable)
--   Palace   36 rooms  33 deluxe · 3 suite + FOUR 18-bed dormitories at Rs. 35,000 each
--   Residency          unchanged; still the assumption, the client has not supplied it
--
-- This replaces the invented splits that stood in until now, and corrects Palace from the
-- earlier "38" to the 36 the client and PRD §3.3 both give.
--
-- Existing rooms are DEACTIVATED rather than deleted. `room_allocations` still has a
-- foreign key to them, and although allocations are retired (rooms are booked in bulk on
-- the proposal now), deleting the rows would destroy booking history to tidy up inventory.
-- Inactive rooms are excluded from every read, so they are invisible without being lost.

-- --- 1. Retire the old inventory for the two units being rebuilt --------------
UPDATE rooms SET is_active = false
 WHERE unit_id IN (SELECT id FROM lodging_units WHERE name IN ('Palace', 'Regency'));

-- --- 2. Regency: 49 guest rooms + one dormitory -------------------------------
INSERT INTO rooms (unit_id, block, room_no, room_type, beds, rack_rate_paise)
SELECT u.id, spec.block, spec.room_no, spec.room_type, spec.beds, spec.rate
  FROM lodging_units u,
       LATERAL (
         SELECT 'A' AS block, 'A' || (100 + g) AS room_no, 'deluxe' AS room_type, 2 AS beds, 450000 AS rate
           FROM generate_series(1, 12) g
         UNION ALL
         SELECT 'A', 'A' || (200 + g), 'semi_deluxe', 2, 700000 FROM generate_series(1, 11) g
         UNION ALL
         SELECT 'A', 'A' || (300 + g), 'presidential_suite', 2, 1100000 FROM generate_series(1, 3) g
         UNION ALL
         SELECT 'B', 'B' || (100 + g), 'deluxe', 2, 450000 FROM generate_series(1, 15) g
         UNION ALL
         SELECT 'B', 'B' || (200 + g), 'semi_suite', 2, 600000 FROM generate_series(1, 6) g
         UNION ALL
         SELECT 'C', 'C' || (100 + g), 'suite', 2, 700000 FROM generate_series(1, 2) g
         UNION ALL
         SELECT 'A', 'DORM-1', 'dormitory', 24, 5000000
       ) spec
 WHERE u.name = 'Regency'
ON CONFLICT (unit_id, room_no) DO UPDATE
   SET room_type = EXCLUDED.room_type,
       beds = EXCLUDED.beds,
       rack_rate_paise = EXCLUDED.rack_rate_paise,
       block = EXCLUDED.block,
       is_active = true;

-- --- 3. Palace: 36 guest rooms + four 18-bed dormitories ----------------------
INSERT INTO rooms (unit_id, block, room_no, room_type, beds, rack_rate_paise)
SELECT u.id, spec.block, spec.room_no, spec.room_type, spec.beds, spec.rate
  FROM lodging_units u,
       LATERAL (
         SELECT NULL::text AS block, 'P' || (100 + g) AS room_no, 'deluxe' AS room_type, 2 AS beds, 500000 AS rate
           FROM generate_series(1, 33) g
         UNION ALL
         SELECT NULL, 'P' || (200 + g), 'suite', 2, 800000 FROM generate_series(1, 3) g
         UNION ALL
         SELECT chr(64 + g), 'DORM-' || chr(64 + g), 'dormitory', 18, 3500000 FROM generate_series(1, 4) g
       ) spec
 WHERE u.name = 'Palace'
ON CONFLICT (unit_id, room_no) DO UPDATE
   SET room_type = EXCLUDED.room_type,
       beds = EXCLUDED.beds,
       rack_rate_paise = EXCLUDED.rack_rate_paise,
       block = EXCLUDED.block,
       is_active = true;
