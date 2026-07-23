-- ============================================================
-- 0019 · Approvals is deciders-only, Roles is Auditor-only, Authority can propose
-- ============================================================
-- Three permission changes from the 23 Jul 2026 tester round, each bringing an already-seeded
-- database in line with the MATRIX in db/masters.ts (edited in this same commit):
--
--   3. Approvals becomes a deciders-only screen — only the Higher Authority and the Auditor.
--      The Booking and Lodge Managers lose the approvals queue (they still raise exceptions
--      through their own flows and hear outcomes via notifications and the event audit trail).
--   6. Roles & Permissions (module `roles_users`, which also carries the Users screen) is the
--      Auditor's alone; the Higher Authority no longer sees it.
--   7. The Higher Authority may now create and continue proposals — `bookings` view → edit,
--      i.e. gain create_edit (view already present).
--
-- Each statement is scoped by role name so a deliberate change made in /admin/roles is left
-- alone, matching migrations 0006 / 0014 / 0016.

-- --- 3. Approvals: revoke from Booking + Lodge Managers ----------------------
DELETE FROM role_permissions rp
 USING roles r
 WHERE r.id = rp.role_id
   AND r.name IN ('booking_manager', 'lodge_manager')
   AND rp.module_code = 'approvals';

-- --- 6. Roles & Permissions: revoke from Higher Authority --------------------
DELETE FROM role_permissions rp
 USING roles r
 WHERE r.id = rp.role_id
   AND r.name = 'higher_authority'
   AND rp.module_code = 'roles_users';

-- --- 7. Bookings: let the Higher Authority create/edit proposals -------------
-- view already exists from the seed; add create_edit only.
INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'bookings', 'create_edit'::perm_action
  FROM roles r
 WHERE r.name = 'higher_authority'
ON CONFLICT (role_id, module_code, action) DO NOTHING;
