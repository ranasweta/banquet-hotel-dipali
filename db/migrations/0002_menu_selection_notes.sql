-- Per-item preference notes on a chosen dish: "dal spicy", "rasgulla less sugary".
--
-- Free text and never priced (client, 19 Jul 2026): an add-on note is a kitchen preference,
-- not a charge. Only a chef-delicacy request or a pick increase can move the per-plate rate.
-- Nullable and additive, so existing snapshots are untouched.
ALTER TABLE sub_event_menu_selections ADD COLUMN IF NOT EXISTS note text;
