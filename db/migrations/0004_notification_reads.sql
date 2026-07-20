-- Dismissed notifications (client, 20 Jul 2026: "remove it when touched").
--
-- The feed itself stays derived from live data — an item disappears on its own once the
-- underlying thing is resolved (see lib/notifications.ts). This table records only that a user
-- has already dealt with a given item, so it stops following them around after they've clicked
-- it. The id is the feed's own derived key ("exc:<uuid>", "cr:<uuid>", ...), which is stable
-- for as long as the underlying row exists, so no foreign key is possible or wanted here.
CREATE TABLE IF NOT EXISTS notification_reads (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id text NOT NULL,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);
