-- ============================================================
-- 0027 · Web push subscriptions for the installed app (11 Aug 2026)
-- ============================================================
-- The app is installable now, and a phone that only shows its queue when someone opens it is
-- a phone nobody opens. This holds the browser's push endpoint per device.
--
-- ONE ROW PER DEVICE, NOT PER USER. Staff share a counter machine and carry their own phones,
-- so the same user legitimately has several subscriptions and the same device can pass to a
-- different user. `endpoint` is the browser's own opaque URL and is unique across the world,
-- which makes it the natural key; re-subscribing on a device the user has used before simply
-- re-points the existing row at whoever is signed in now.
--
-- CASCADE on the user: a deleted user's endpoints are not history, they are a live delivery
-- address, and continuing to push to them after the account is gone is the one behaviour
-- nobody would expect. This is also why the Users screen can delete an account that has never
-- acted without tripping over this table.
--
-- The keys are the browser's public encryption material (p256dh) and auth secret. They are
-- not credentials for anything but pushing to that one endpoint, and they are useless without
-- the VAPID private key held in the server's environment.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Bumped every time the device is seen; a dead endpoint is pruned when a push is refused,
  -- so this is only for telling a stale row from a live one when reading the table by hand.
  last_seen  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

COMMENT ON TABLE push_subscriptions IS
  'Web push endpoints, one per device. Keyed by the browser''s endpoint URL so re-subscribing '
  'on the same device re-points the row rather than duplicating it.';
