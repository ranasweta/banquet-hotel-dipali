-- ============================================================
-- 0021 · Residency bifurcation confirmed (client, 25 Jul 2026)
-- ============================================================
-- Residency's breakdown was an assumption until now (20 deluxe @ Rs. 7,000 + 8 presidential
-- suite @ Rs. 11,000, carried from the Grand's rates — see SEED_ASSUMPTIONS §F1). The client
-- has confirmed it: 27 Deluxe at Rs. 5,000 and 2 Suite at Rs. 8,000 — 29 rooms, two
-- categories. This replaces the assumption and retires the presidential-suite line.
--
-- Old rooms are DEACTIVATED, never deleted: room_allocations still carries a foreign key to
-- them, and tidying inventory must not destroy booking history. The reused numbers (R101–R120,
-- R201–R202) are reactivated and repriced by the upsert; the retired presidential rows
-- R203–R208 stay inactive, so they are invisible without being lost. Inactive rooms are
-- excluded from every read.

-- --- 1. Retire the old Residency inventory ------------------------------------
UPDATE rooms SET is_active = false
 WHERE unit_id = (SELECT id FROM lodging_units WHERE name = 'Residency');

-- --- 2. Residency: 27 Deluxe (Rs. 5,000) + 2 Suite (Rs. 8,000) = 29 rooms -----
INSERT INTO rooms (unit_id, block, room_no, room_type, beds, rack_rate_paise)
SELECT u.id, spec.block, spec.room_no, spec.room_type, spec.beds, spec.rate
  FROM lodging_units u,
       LATERAL (
         SELECT NULL::text AS block, 'R' || (100 + g) AS room_no, 'deluxe' AS room_type, 2 AS beds, 500000 AS rate
           FROM generate_series(1, 27) g
         UNION ALL
         SELECT NULL, 'R' || (200 + g), 'suite', 2, 800000 FROM generate_series(1, 2) g
       ) spec
 WHERE u.name = 'Residency'
ON CONFLICT (unit_id, room_no) DO UPDATE
   SET room_type = EXCLUDED.room_type,
       beds = EXCLUDED.beds,
       rack_rate_paise = EXCLUDED.rack_rate_paise,
       block = EXCLUDED.block,
       is_active = true;
