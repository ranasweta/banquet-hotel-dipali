-- ============================================================
-- 0006 · Lodge Manager sees only the lodging calendar (client, 20 Jul 2026)
-- ============================================================
-- Brings an already-seeded database in line with the MATRIX in db/masters.ts, which this
-- change also edits. Two things were wrong in the live database:
--
--   · the Lodge Manager had ONLY `calendar: view` — no `rooms` at all, so the lodging
--     calendar was invisible to the one role it was built for, and /rooms/calendar would
--     bounce them (requirePermission('rooms','view') enforces it server-side);
--   · the client wants their sidebar trimmed to the lodging calendar alone.
--
-- Scoped strictly to lodge_manager: no other role's grants are touched, because the
-- permission matrix is admin-editable at runtime (/admin/roles) and a migration must not
-- silently undo a deliberate change someone made there. After this runs, an Admin can of
-- course change it again from that screen. See docs/SEED_ASSUMPTIONS.md §F6.

-- --- 1. Revoke everything that would put a tab in their sidebar --------------
-- `calendar` alone drives three (Calendar, Day sheet, Change requests); `bookings` and
-- `approvals` one each. `billing` is deliberately NOT revoked: it has no nav entry, but
-- it carries the Lodge Manager's lock sign-off, so dropping it would break capability
-- without changing anything they can see.
DELETE FROM role_permissions rp
 USING roles r
 WHERE r.id = rp.role_id
   AND r.name = 'lodge_manager'
   AND rp.module_code IN (
     'bookings', 'calendar', 'approvals',
     'menus', 'menu_master', 'maintenance', 'roles_users', 'audit'
   );

-- --- 2. Restore the grants their job actually needs --------------------------
-- `rooms` is view + create_edit: view for the calendar, create_edit because allocating
-- rooms against an event (FR-4.2) is the Lodge Manager's core task and runs through
-- requirePermission('rooms','create_edit'). `billing` matches the seed matrix.
INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, g.module_code, g.action::perm_action
  FROM roles r,
       (VALUES ('rooms',   'view'),
               ('rooms',   'create_edit'),
               ('billing', 'view'),
               ('billing', 'create_edit')) AS g(module_code, action)
 WHERE r.name = 'lodge_manager'
ON CONFLICT (role_id, module_code, action) DO NOTHING;
