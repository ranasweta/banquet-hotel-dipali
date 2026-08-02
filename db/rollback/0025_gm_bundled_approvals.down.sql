-- ============================================================
-- ROLLBACK for 0025 · GM bundled approvals
-- ============================================================
-- NOT a migration. This file lives outside db/migrations/ deliberately: `migrate` applies
-- every .sql in that directory in lexical order, so a down-script sitting there would be run
-- as a forward step and undo the thing it was written to undo.
--
--   Run:   npx tsx db/rollback.ts db/rollback/0025_gm_bundled_approvals.down.sql
--
-- It reverses the three things 0025 did: the Authority's lock override, the invoice
-- re-issue chain, and the two bundle-lookup indexes. Afterwards `0025` is removed from
-- schema_migrations, so `npm run migrate` will apply it again cleanly.
--
-- ⚠ IT REFUSES TO RUN once a document has actually been re-issued, and the guard below is the
-- most important thing in this file. Rolling back means restoring UNIQUE (event_id) on
-- invoices, which cannot coexist with a superseded version — so completing the rollback would
-- require DELETING an invoice a guest is holding. That is a billing-history decision for a
-- human, never a side effect of a script. If it stops you, either accept that the schema stays
-- forward, or resolve the superseded rows deliberately and re-run.
--
-- No BEGIN/COMMIT here: the runner wraps the file in one transaction (the same way `migrate`
-- does), and postgres.js refuses explicit transaction control inside a simple-protocol batch.

-- --- 0. Guard: no re-issued documents may exist ------------------------------
DO $$
DECLARE n int;
BEGIN
  -- The column may already be gone if this ran before; then there is nothing to check.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'invoices' AND column_name = 'superseded_at') THEN
    EXECUTE 'SELECT count(*) FROM invoices WHERE superseded_at IS NOT NULL' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'Rollback refused: % invoice(s) have been superseded by a re-issue. Restoring '
        'UNIQUE (event_id) would require deleting a document already issued to a guest. '
        'Decide what happens to those rows first — see db/rollback/0025_*.down.sql.', n;
    END IF;
  END IF;
END $$;

-- --- 1. Lock guards: remove the override, restore the originals --------------
-- Byte-for-byte the bodies from db/schema.sql §14 / §14b, minus the GUC check.
CREATE OR REPLACE FUNCTION forbid_locked_event_write() RETURNS trigger AS $$
DECLARE eid uuid; st event_status;
BEGIN
  eid := COALESCE(NEW.event_id, OLD.event_id);
  SELECT status INTO st FROM events WHERE id = eid;
  IF st IN ('locked','billed','closed') THEN
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
  IF st IN ('locked','billed','closed') THEN
    RAISE EXCEPTION 'event % is locked — record is immutable', eid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

-- --- 2. Invoice versioning ---------------------------------------------------
DROP INDEX IF EXISTS invoices_one_live_per_event;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_event_version_key;

-- Safe because the guard above proved at most one invoice per event remains.
-- Conditional because a constraint has no ADD ... IF NOT EXISTS, and a rollback that cannot
-- be run twice is a rollback you hesitate to run once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'invoices'::regclass AND conname = 'invoices_event_id_key') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_event_id_key UNIQUE (event_id);
  END IF;
END $$;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS reissue_reason,
  DROP COLUMN IF EXISTS supersedes_id,
  DROP COLUMN IF EXISTS superseded_at,
  DROP COLUMN IF EXISTS version;

-- --- 3. Bundle lookup indexes ------------------------------------------------
DROP INDEX IF EXISTS exceptions_event_pending;
DROP INDEX IF EXISTS change_requests_event_pending;

-- --- 4. Let 0025 be applied again --------------------------------------------
DELETE FROM schema_migrations WHERE id = '0025_gm_bundled_approvals';
