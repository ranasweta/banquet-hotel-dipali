-- ============================================================
-- 0014 · The Banquet Manager reads; the Authority decides (client, 21 Jul 2026)
-- ============================================================
-- "the banquet manager does not need to approve anything he will just see which event
--  when how many people and what is the menu with all description and changes"
--
-- So two grants move, and they move together:
--
--   · banquet_manager loses calendar:create_edit — that grant existed to let him decide
--     venue/date/time change requests, which is now the Authority's call
--     (lib/change-requests.ts DECIDER_ROLES).
--   · banquet_manager loses approvals:create_edit, keeping view so he still sees outcomes.
--   · higher_authority GAINS calendar:create_edit, because somebody has to hold the
--     permission the change-request decision route checks.
--
-- Deliberately NOT revoked: billing:create_edit. It carries his day-sheet sign-off, which
-- is an attestation that he has read the sheet, not an approval of anything — and it is a
-- blocking lock item, so dropping it would stop every event from locking. Flagged in
-- docs/SEED_ASSUMPTIONS.md rather than assumed either way.
--
-- Scoped to these three grants so a deliberate edit made in /admin/roles survives.

-- --- 1. The Banquet Manager stops deciding ----------------------------------
DELETE FROM role_permissions rp
 USING roles r
 WHERE r.id = rp.role_id
   AND r.name = 'banquet_manager'
   AND rp.action = 'create_edit'
   AND rp.module_code IN ('calendar', 'approvals');

-- --- 2. The Authority picks up the calendar ---------------------------------
INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'calendar', 'create_edit'::perm_action
  FROM roles r
 WHERE r.name = 'higher_authority'
ON CONFLICT (role_id, module_code, action) DO NOTHING;
