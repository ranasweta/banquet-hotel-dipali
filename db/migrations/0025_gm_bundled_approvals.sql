-- ============================================================
-- 0025 · Bundled GM approvals, the Authority's lock override, and invoice re-issue
-- ============================================================
-- Client (lead), 1 Aug 2026. Three changes, all of them consequences of one complaint: the
-- approvals queue drip-fed the General Manager one decision at a time, with no sight of the
-- proposal it belonged to.
--
--   1. The GM decides a whole PROPOSAL, not a request. Nothing about how exceptions are raised
--      changes — the grouping is by event_id and needs only an index. What does change is that
--      the GM edits the proposal while deciding it, and his edits must land on any event.
--   2. `locked means locked` gains exactly one exception: the Higher Authority. The guard is a
--      trigger and a trigger cannot see who the actor is, so the service announces itself with
--      a transaction-local GUC that only lib/gm-authority.ts sets. `SET LOCAL` dies with the
--      transaction, so an override can never leak into the next statement on a pooled
--      connection — which is why it is a GUC and not a table flag.
--   3. Editing a BILLED event invalidates a number the guest has already been given, so the
--      invoice is superseded and re-issued rather than mutated. `invoices.event_id` was UNIQUE,
--      which made a second version impossible to store; it becomes UNIQUE (event_id, version)
--      and reads take the live one.
--
-- See CLAUDE.md rules 3 and 6, and docs/PRD.md §4.1/BR-D2, amended in this same commit.

-- --- 1. Bundle lookup --------------------------------------------------------
-- The queue now groups by event, so both feeder tables are read by (event_id, status).
CREATE INDEX IF NOT EXISTS exceptions_event_pending
  ON exceptions (event_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS change_requests_event_pending
  ON change_requests (event_id) WHERE status = 'pending';

-- --- 2. The Higher Authority's lock override ---------------------------------
-- Both guards gain the same escape hatch and nothing else. `current_setting(..., true)`
-- returns NULL rather than raising when the GUC was never set, so every ordinary write —
-- every role, every route that does not opt in — takes the identical path it took before.
CREATE OR REPLACE FUNCTION forbid_locked_event_write() RETURNS trigger AS $$
DECLARE eid uuid; st event_status;
BEGIN
  eid := COALESCE(NEW.event_id, OLD.event_id);
  SELECT status INTO st FROM events WHERE id = eid;
  IF st IN ('locked','billed','closed')
     AND COALESCE(current_setting('app.gm_override', true), '') <> 'on' THEN
    RAISE EXCEPTION 'event % is locked — record is immutable', eid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_locked_menu_write() RETURNS trigger AS $$
DECLARE eid uuid; st event_status; rec jsonb;
BEGIN
  rec := to_jsonb(COALESCE(NEW, OLD));
  IF rec ? 'sub_event_id' THEN
    SELECT se.event_id INTO eid FROM sub_events se
      WHERE se.id = (rec->>'sub_event_id')::uuid;
  ELSE
    SELECT se.event_id INTO eid
      FROM sub_event_menus m JOIN sub_events se ON se.id = m.sub_event_id
      WHERE m.id = (rec->>'menu_id')::uuid;
  END IF;
  SELECT status INTO st FROM events WHERE id = eid;
  IF st IN ('locked','billed','closed')
     AND COALESCE(current_setting('app.gm_override', true), '') <> 'on' THEN
    RAISE EXCEPTION 'event % is locked — record is immutable', eid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

-- The audit log stays absolutely immutable. An override lets the Authority change the
-- BOOKING; it has never let anyone change the record of who changed what, and the
-- audit_log guard is deliberately untouched here.

-- --- 3. Invoice versioning ---------------------------------------------------
-- One event held at most one invoice row. Re-issuing needs a second, so the constraint moves
-- from the event to the (event, version) pair. Existing rows are version 1 and live.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS version       int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES invoices(id),
  -- Why this version exists at all: "GM revised rooms after billing". Null on version 1.
  ADD COLUMN IF NOT EXISTS reissue_reason text;

DO $$
DECLARE cname text;
BEGIN
  -- Drop whatever name the UNIQUE(event_id) constraint was created under (the DDL declared it
  -- inline, so it is invoices_event_id_key on a fresh build but may differ on an introspected
  -- database). Scoped to single-column unique constraints on event_id so nothing else is hit.
  SELECT c.conname INTO cname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'invoices'::regclass
     AND c.contype = 'u'
     AND array_length(c.conkey, 1) = 1
     AND a.attname = 'event_id';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_event_version_key UNIQUE (event_id, version);

-- The live invoice for an event is the one not yet superseded, and there is at most one.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_live_per_event
  ON invoices (event_id) WHERE superseded_at IS NULL;
