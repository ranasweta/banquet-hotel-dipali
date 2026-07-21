-- ============================================================
-- 0007 · `lodging_calendar` becomes its own module (client, 20 Jul 2026)
-- ============================================================
-- Two changes, both driven by the client:
--
--   1. The lodging calendar is for Lodge Managers. It previously shared the `rooms`
--      module with the room-by-room board, which made that impossible to express: one
--      grant drove both screens, so no permission could show the calendar alone. A
--      separate module makes it grantable on its own — and keeps the system a utility,
--      since an Admin can hand it to any role from /admin/roles afterwards.
--
--   2. `approvals: view` is restored to the Lodge Manager. Migration 0006 revoked it,
--      which left them able to raise a 35+ room exception (BR-L2) but unable to see the
--      decision. `view` not `edit` — deciding is the Higher Authority's call.
--
-- Idempotent; scoped to the new module plus the one approvals grant, so no other role's
-- deliberately-edited permissions are disturbed.

-- --- 1. Register the module -------------------------------------------------
-- role_permissions.module_code has a foreign key to modules(code), so this must land
-- before any grant referencing it.
INSERT INTO modules (code) VALUES ('lodging_calendar')
ON CONFLICT (code) DO NOTHING;

-- --- 2. Default audience: Lodge Managers, plus the Auditor ------------------
-- The Auditor is `full` on every module because that role IS the permission utility — it
-- grants and revokes for everyone, so locking it out would leave the module ungovernable.
-- Every other role starts with nothing and can be granted this from /admin/roles.
INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'lodging_calendar', g.action::perm_action
  FROM roles r,
       (VALUES ('view')) AS g(action)
 WHERE r.name = 'lodge_manager'
ON CONFLICT (role_id, module_code, action) DO NOTHING;

INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'lodging_calendar', g.action::perm_action
  FROM roles r,
       (VALUES ('view'), ('create_edit'), ('delete')) AS g(action)
 WHERE r.name = 'auditor'
ON CONFLICT (role_id, module_code, action) DO NOTHING;

-- --- 3. Give the Lodge Manager sight of their own approvals ------------------
INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'approvals', 'view'::perm_action
  FROM roles r
 WHERE r.name = 'lodge_manager'
ON CONFLICT (role_id, module_code, action) DO NOTHING;
