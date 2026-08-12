-- ============================================================
-- 0031 · The lodge master
-- ============================================================
-- Client, 13 Aug 2026: "create a lodge master same as this in which auditor can set the
-- category wise room and their pricing and update or anything may add delete update whatever".
--
-- The venue master's counterpart for rooms. Granted exactly as `venue_master` and
-- `menu_master` are — Auditor full, Higher Authority edit, nobody else. Distinct from `rooms`
-- (which is the booking-side module: who is staying where) and from `lodging_calendar`, so a
-- Lodge Manager can go on running the day sheet without being able to re-price the hotel.
--
-- NO TABLE CHANGES. `rooms` already holds one row per physical room with its own rack rate,
-- and that is the right shape: the hard inventory cap counts real rooms (rule 9). The screen
-- presents a CATEGORY — count and nightly rate — and does the row bookkeeping underneath,
-- because every room of a category already shares one rate and the pricing code reads
-- min(rack_rate_paise) per category anyway.

INSERT INTO modules (code) VALUES ('lodge_master') ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'lodge_master', a.action::perm_action
FROM roles r
CROSS JOIN (VALUES ('view'), ('create_edit'), ('delete')) AS a(action)
WHERE r.name = 'auditor'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'lodge_master', a.action::perm_action
FROM roles r
CROSS JOIN (VALUES ('view'), ('create_edit')) AS a(action)
WHERE r.name = 'higher_authority'
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN rooms.rack_rate_paise IS
  'Nightly rate. Read LIVE by billing and the payable (min per lodge+category) — it is '
  'snapshotted nowhere, so re-pricing a category moves every unbilled booking of it. Issued '
  'invoices keep the lines they were issued with.';
