-- ============================================================
-- 0016 · The Banquet Manager is the 15-day board, and named by lodge (client, 22 Jul 2026)
-- ============================================================
-- "for banquet manager only keep next 15 days and dashboard, that's it, nothing more.
--  also name each banquet manager with their respective lodge."
--
-- Two changes, both bringing an already-seeded database in line with db/masters.ts, which
-- this same commit edits.
--
--   1. Every read grant that only ever gave the Banquet Manager a tab is revoked, so those
--      pages bounce him rather than merely hiding from the sidebar. `calendar` STAYS, because
--      the 15-day board (/day-sheet, GET /calendar/horizon) reads it; `billing` STAYS,
--      because it carries his lock sign-off and has no tab of its own. The sidebar itself is
--      trimmed in components/app-nav.tsx — calendar drives three tabs and permission alone
--      cannot show one without the others.
--
--   2. The three managers are renamed by lodge, the way the Lodge Managers already are. This
--      is a LABEL: the role is not scoped to a lodge here. Functions live at venues across
--      four properties and there are three lodges, so a strict scoping would orphan Dipali
--      Grand's venues — a separate decision, not made in this migration.
--
-- Scoped to banquet_manager so a deliberate edit made in /admin/roles is left alone.

-- --- 1. Trim to calendar + billing ------------------------------------------
DELETE FROM role_permissions rp
 USING roles r
 WHERE r.id = rp.role_id
   AND r.name = 'banquet_manager'
   AND rp.module_code IN ('bookings', 'menus', 'menu_master', 'rooms', 'maintenance', 'approvals');

-- --- 2. Name each manager after a lodge -------------------------------------
-- Matched on the seeded mobile numbers, so a live database that still carries the old
-- "Banquet Manager 1/2/3" names is corrected, and one already renamed by hand is not
-- clobbered (the WHERE only fires on the exact old value).
UPDATE users SET full_name = 'Banquet Manager — Palace'
 WHERE mobile = '9000000012' AND full_name = 'Banquet Manager 1';
UPDATE users SET full_name = 'Banquet Manager — Regency'
 WHERE mobile = '9000000013' AND full_name = 'Banquet Manager 2';
UPDATE users SET full_name = 'Banquet Manager — Residency'
 WHERE mobile = '9000000014' AND full_name = 'Banquet Manager 3';
