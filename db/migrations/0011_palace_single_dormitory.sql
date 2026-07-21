-- ============================================================
-- 0011 · Palace has ONE dormitory, not four (client, 21 Jul 2026)
-- ============================================================
-- Migration 0010 read the client's "18 beds dormitory (4 dorm)" as four blocks. It is one
-- dormitory of 18 beds at Rs. 35,000. Palace's 36 guest rooms are unchanged.
--
-- Deactivated rather than deleted, for the same reason as 0010: rooms carry a foreign key
-- from room_allocations, and inventory tidying must not destroy booking history. Inactive
-- rooms are excluded from every read.
UPDATE rooms
   SET is_active = false
 WHERE room_type = 'dormitory'
   AND room_no <> 'DORM-A'
   AND unit_id = (SELECT id FROM lodging_units WHERE name = 'Palace');
