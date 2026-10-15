-- ============================================================
-- 0040 · Extra plates — the photograph is optional
-- ============================================================
-- Client, 15 Oct 2026: "in the plates one remove the required field that is the image one".
--
-- 0035 made `file_key` NOT NULL on the reasoning that the photo IS the entry: a plate count is
-- the one charge with no booking, rate card or signature behind it. That is now the client's
-- call to give up, and it is recorded as such in docs/SEED_ASSUMPTIONS.md §F31. A photo can
-- still be attached and is still encrypted and permission-checked exactly as before (rule 7);
-- an entry without one is simply an entry without one, and the panel says so on its row.
--
-- In practice nothing could be saved at all: the live site stores files nowhere (no
-- GCS_BUCKET on Vercel, so `storeEncrypted` refuses), and with the photo mandatory every plate
-- entry failed. Not one exists in production.

ALTER TABLE extra_plate_entries ALTER COLUMN file_key DROP NOT NULL;
