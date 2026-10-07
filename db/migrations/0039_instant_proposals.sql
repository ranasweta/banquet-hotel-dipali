-- ============================================================
-- 0039 · Instant proposals — the demo proposal, saved
-- ============================================================
-- Client, 7 Oct 2026. The demo proposal (1 Oct) held everything in the page and lost it on
-- reload, so a guest who came back the next week was walked through it all again. It is now an
-- INSTANT proposal: saved, listed on its own "Instant" tab of Past proposals, reopened and
-- changed at any time, and converted into a real proposal when the guest commits.
--
-- WHY A TABLE OF ITS OWN AND NOT AN `events` ROW. Only the name is required. An instant may have
-- no event type, no dates, no contact and functions with no venue or time — and `events`,
-- `sub_events` and `event_contacts` rightly refuse every one of those. It also holds nothing:
-- no venue_bookings, no rooms, no money, so it can never clash, lock or need cancelling. The
-- proposal itself is one JSON document (`draft`), validated by Zod on every write
-- (lib/instant-proposals.ts), because nothing in it is read by any other part of the system.
--
-- CONVERSION creates a real enquiry through the ordinary routes (so every rule a proposal obeys
-- still applies) and records it here. A converted instant is read-only; the booking is the
-- thing to edit from then on.

CREATE TABLE instant_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  draft              jsonb NOT NULL DEFAULT '{}'::jsonb,
  converted_event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  converted_at       timestamptz,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instant_proposals_recent ON instant_proposals(updated_at DESC);
