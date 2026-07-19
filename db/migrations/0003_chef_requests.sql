-- Chef delicacy requests (client, 19 Jul 2026).
--
-- The second kind of menu "increase": instead of one more pick from the printed list, the
-- guest asks for something off-menu ("sushi"). The Booking Manager writes it free-text; only
-- the Chef sets the rupee charge, and that charge is PER PLATE — it joins the tier rate and
-- the wedding surcharge, so the food line is pax x (tier + surcharge + priced delicacies).
--
-- Kept out of `exceptions` deliberately: an exception is approved/rejected by the Higher
-- Authority, whereas this is priced by the Chef and carries an amount, not a verdict.
CREATE TABLE IF NOT EXISTS chef_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_event_id  uuid NOT NULL REFERENCES sub_events(id) ON DELETE CASCADE,
  description   text NOT NULL,                    -- "sushi counter", in the guest's words
  status        text NOT NULL DEFAULT 'pending',  -- pending | priced | declined
  charge_paise  bigint,                           -- per-plate addition, set by the Chef
  remark        text,
  requested_by  uuid NOT NULL REFERENCES users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  priced_by     uuid REFERENCES users(id),
  priced_at     timestamptz,
  CONSTRAINT chef_requests_status_chk CHECK (status IN ('pending', 'priced', 'declined')),
  -- A priced request must carry a non-negative amount; anything else must not.
  CONSTRAINT chef_requests_charge_chk CHECK (
    (status = 'priced' AND charge_paise IS NOT NULL AND charge_paise >= 0)
    OR (status <> 'priced' AND charge_paise IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS chef_requests_sub_event_idx ON chef_requests (sub_event_id);
CREATE INDEX IF NOT EXISTS chef_requests_pending_idx ON chef_requests (status) WHERE status = 'pending';
