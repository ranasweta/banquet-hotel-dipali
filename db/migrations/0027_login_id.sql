-- ============================================================
-- 0027 · Staff sign in with an ID, not a mobile number
-- ============================================================
-- Client, 11 Aug 2026. `users.mobile` has been the login identifier since 0001, which forced
-- two unrelated jobs onto one column: how a person signs in, and how the hotel phones them.
-- They now separate.
--
--   login_id   what is typed at sign-in. Chosen by the Admin, unique, matched
--              case-insensitively so 'Admin' and 'admin' are the same account.
--   mobile     contact information only. Nullable and no longer unique — two staff may share
--              a desk phone, and a user may have no number on record at all.
--
-- Uniqueness lives on lower(login_id) rather than on the column, because a login that depends
-- on the caps lock key is a support call every time. The application must match the same way
-- (`lower(login_id) = lower($1)`) or a user could be created that can never sign in.
--
-- The format check is deliberately at the database as well as in Zod: the API is not the only
-- thing that writes users — the seed does too, and so does anyone with psql.

ALTER TABLE users ADD COLUMN login_id text;

-- Everyone keeps working first, and is renamed second. Anyone not in the explicit list below
-- signs in with the number they already use, which is not pretty but is never a lockout —
-- production holds users added through the admin screen that no seed file knows about.
UPDATE users SET login_id = mobile;

-- The seeded 16 (db/masters.ts USERS), by the mobile that identified them until now.
UPDATE users SET login_id = v.login_id
FROM (VALUES
  ('9000000001', 'IAUD5533'),
  ('9000000002', 'HIGHAUTH01'),
  ('9000000003', 'HIGHAUTH02'),
  ('9000000004', 'BANQ.PALACE'),
  ('9000000005', 'BANQ.REGENCY'),
  ('9000000006', 'BANQ.RESIDENCY'),
  ('9000000007', 'Banq.booking01'),
  ('9000000008', 'Banq.booking02'),
  ('9000000009', 'Banq.booking03'),
  ('9000000010', 'Banq.booking04'),
  ('9000000011', 'Banq.booking05'),
  ('9000000012', 'Banq.Ground01'),
  ('9000000013', 'Banq.Ground02'),
  ('9000000014', 'Banq.Ground03'),
  ('9000000015', 'Banq.MaintM'),
  ('9000000016', 'Banq.Chef')
) AS v(mobile, login_id)
WHERE users.mobile = v.mobile;

ALTER TABLE users ALTER COLUMN login_id SET NOT NULL;

ALTER TABLE users ADD CONSTRAINT users_login_id_format
  CHECK (login_id ~ '^[A-Za-z0-9._-]{3,32}$');

CREATE UNIQUE INDEX users_login_id_lower_key ON users (lower(login_id));

-- The mobile stops identifying anyone.
ALTER TABLE users ALTER COLUMN mobile DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT users_mobile_key;
