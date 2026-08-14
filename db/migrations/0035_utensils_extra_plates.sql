-- ============================================================
-- 0035 · The Utensil Manager, and the plates issued on the day
-- ============================================================
-- Client, 15 Aug 2026. On the day of a wedding more guests turn up than the function was
-- catered for and the kitchen issues extra plates. Nobody owned that number: it was counted at
-- the pass, remembered, and argued about at billing.
--
-- A NEW ROLE, not a corner of Maintenance. The work is shaped identically — logged during and
-- after the event, closed by its own owner, charged only once closed — but the evidence is not:
-- every entry here carries a PHOTO of the plates, and that photo exists because this is the one
-- charge in the system a member of staff can simply invent. The Auditor and the Higher
-- Authority read it; the Maintenance team has no business in it. Separate module, separate
-- screen, separate log.
--
-- THE PRICE IS THE FUNCTION'S OWN PER-PLATE RATE, and that is why an entry names a FUNCTION and
-- not just a booking. A wedding's Sangeet is Silver and its Reception is Gold; charging a
-- Sangeet plate at the Reception's rate is a made-up number wearing a real one's clothes. The
-- rate copied in is exactly what `computeBillLines` and `payableRows` charge a booked plate:
--
--     base_rate_paise + surcharge_paise + priced chef delicacies
--
-- so an extra plate and a catered plate at the same function cost the same to the paisa. It is
-- SNAPSHOTTED at entry (rule 4): re-pricing the tier tomorrow must not move a plate already
-- served and photographed. A function with no saved menu has no rate and is REFUSED, never
-- priced at zero — a missing rate is a gate (docs/SEED_ASSUMPTIONS.md).
--
-- TAX. Plates are food: 18%, printed on the Total and collected from nobody (rule 11). So these
-- are `food` lines and lib/tax.ts needs no new section.
--
-- WHERE IT SITS IN THE MONEY. With closed maintenance and the lodge's closed extras, on the far
-- side of rule 12's split: in the settlement and the balance, and in neither the 25% advance,
-- the wedding 50%, nor the 10% discount cap. Plates are issued on the night; the advance fell
-- due months before, and a threshold that moves backwards makes a met milestone short.

-- --- 1. The module ----------------------------------------------------------
-- role_permissions.module_code references modules(code), so this lands before any grant.
INSERT INTO modules (code) VALUES ('utensils')
ON CONFLICT (code) DO NOTHING;

-- --- 2. The role ------------------------------------------------------------
INSERT INTO roles (name, is_system) VALUES ('utensil_manager', true)
ON CONFLICT (name) DO UPDATE SET is_system = true;

-- --- 3. Grants --------------------------------------------------------------
-- The Utensil Manager logs and closes his own; the Authority and the Auditor can look, which
-- is the whole point of the photo. Nobody else is given it by default — an Admin can hand it
-- to any role from /admin/roles afterwards, which is what makes this a utility.
INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'utensils', g.action::perm_action
  FROM roles r, (VALUES ('view'), ('create_edit')) AS g(action)
 WHERE r.name = 'utensil_manager'
ON CONFLICT (role_id, module_code, action) DO NOTHING;

INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'utensils', 'view'::perm_action
  FROM roles r WHERE r.name = 'higher_authority'
ON CONFLICT (role_id, module_code, action) DO NOTHING;

-- The Auditor is `full` on every module because that role IS the permission utility — it
-- grants and revokes for everyone, so locking it out would leave the module ungovernable.
INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'utensils', g.action::perm_action
  FROM roles r, (VALUES ('view'), ('create_edit'), ('delete')) AS g(action)
 WHERE r.name = 'auditor'
ON CONFLICT (role_id, module_code, action) DO NOTHING;

-- --- 4. The user ------------------------------------------------------------
-- Client's wording: "create new user UT ... keep any easy password our auditor will update it
-- afterwards". The hash below is bcrypt('utensil123'). It is a STARTER credential and is meant
-- to be replaced from /admin/users on first use.
--
-- `Banq.UT` rather than the bare "UT" asked for: `users_login_id_format` (migration 0027)
-- requires 3-32 characters, and the prefix is what the other single-post staff already use
-- (Banq.MaintM, Banq.Chef). The Auditor can rename it from /admin/users.
--
-- ON CONFLICT deliberately leaves password_hash alone, matching db/seed.ts: re-running this
-- must never reset a password somebody has already changed.
INSERT INTO users (full_name, login_id, mobile, password_hash, role_id)
SELECT 'Utensil Manager', 'Banq.UT', '9000000017',
       '$2b$10$dkSzqAaK4LBtbKXLQY.mquSFsk6qEJsjKBFmNZmCaDx1jN0owEW6e',
       r.id
  FROM roles r WHERE r.name = 'utensil_manager'
ON CONFLICT ((lower(login_id))) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  role_id   = EXCLUDED.role_id;

-- --- 5. The log -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extra_plate_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Both keys, not just the function's. event_id carries the locked-event guard below and is
  -- what every money reader groups by; sub_event_id is what the price came from.
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sub_event_id uuid NOT NULL REFERENCES sub_events(id) ON DELETE CASCADE,
  plates       int NOT NULL CHECK (plates > 0),
  -- Per plate, snapshotted from the function's menu at entry. See the header note.
  rate_paise   bigint NOT NULL CHECK (rate_paise > 0),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  remarks      text,
  -- NOT NULL, and that is the feature (client, 15 Aug 2026). The photo is the only thing
  -- standing between this table and an invented charge, so an entry without one cannot exist —
  -- not "exists and is flagged". Encrypted at rest and served only behind a permission check,
  -- like every other stored image (rule 7).
  file_key     text NOT NULL,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS extra_plate_entries_event ON extra_plate_entries (event_id);

-- One row per event: the close, and nothing else. Same shape and the same reasoning as
-- `lodge_extras` (migration 0034) — the close is one act over the whole log, so it is one fact
-- in one place rather than a flag per row that can drift. Not a `lock_signoffs` designation:
-- that enum holds the four designations whose sign-off gates the lock, and this is not one.
CREATE TABLE IF NOT EXISTS utensil_extras (
  event_id   uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  closed_at  timestamptz,
  closed_by  uuid REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Locked means locked (rule 6). Both carry event_id, so the original guard applies unchanged
-- and honours the Higher Authority's app.gm_override GUC exactly as the other children do.
DROP TRIGGER IF EXISTS extra_plate_entries_lock_guard ON extra_plate_entries;
CREATE TRIGGER extra_plate_entries_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON extra_plate_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_event_write();

DROP TRIGGER IF EXISTS utensil_extras_lock_guard ON utensil_extras;
CREATE TRIGGER utensil_extras_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON utensil_extras
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_event_write();

COMMENT ON COLUMN extra_plate_entries.file_key IS
  'Photo of the plates, mandatory (client, 15 Aug 2026). Encrypted at rest via lib/storage.ts '
  'and readable only with utensils:view — the Auditor and the Higher Authority — because this '
  'is the charge a member of staff could otherwise invent.';
