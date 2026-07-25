-- ============================================================
-- 0024 · Booking Manager may apply discounts (client, 25 Jul 2026)
-- ============================================================
-- The Booking Manager owns the proposal and now gives per-head discounts on the Payment
-- review at the end of it. Discounts run through requirePermission('billing','create_edit'),
-- so he needs billing at the 'edit' level (view + create_edit). Over the 10% cap still routes
-- to the Higher Authority.
--
-- Scoped strictly to booking_manager; no other role's grants are touched (the matrix is
-- admin-editable at /admin/roles and a migration must not undo a deliberate change made there).
INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, g.module_code, g.action::perm_action
  FROM roles r,
       (VALUES ('billing', 'view'),
               ('billing', 'create_edit')) AS g(module_code, action)
 WHERE r.name = 'booking_manager'
ON CONFLICT (role_id, module_code, action) DO NOTHING;
