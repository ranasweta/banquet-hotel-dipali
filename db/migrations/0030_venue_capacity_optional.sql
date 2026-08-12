-- ============================================================
-- 0030 · A venue's capacity becomes optional
-- ============================================================
-- Client, 13 Aug 2026, on being shown the new-venue form: "why are u taking seats?"
--
-- Fair question. `capacity_min`/`capacity_max` gate NOTHING — rule 13 removed the last capacity
-- check on 3 Aug 2026 and CLAUDE.md has carried them as "descriptive inventory ... dead weight
-- to be removed only on the client's word" ever since. They are also displayed nowhere: the
-- booking wizard's Venue type carries the two fields and never renders them. So the form was
-- asking the Auditor for two numbers that do nothing at all.
--
-- The columns are NOT dropped. The seeded values are real — Kohinoor genuinely seats 150–250,
-- from the hotel's own proposal — and a salesperson may well want them on a screen one day.
-- Dropping them would throw that away to save nothing.
--
-- What changes is that they stop being COMPULSORY, so a venue added from the venue master can
-- record no capacity rather than a made-up one. NULL and 0 are different claims and the
-- difference matters here exactly as it does for rate cards (migration 0029): 0 says "seats
-- nobody", NULL says "nobody wrote it down". Defaulting the form to 1–100 was inventing seed
-- data through the back door, which is the one thing SEED_ASSUMPTIONS.md exists to prevent.
--
-- The CHECK on capacity_max >= capacity_min survives untouched: in Postgres a comparison with
-- NULL is NULL, and a CHECK passes unless it evaluates to FALSE, so a NULL capacity satisfies
-- it without weakening the constraint for the rows that do carry numbers.

ALTER TABLE venues ALTER COLUMN capacity_min DROP NOT NULL;
ALTER TABLE venues ALTER COLUMN capacity_max DROP NOT NULL;

COMMENT ON COLUMN venues.capacity_min IS
  'Descriptive only — gates nothing (rule 13, 4 Aug 2026). NULL means nobody recorded it; '
  'it does not mean zero.';
COMMENT ON COLUMN venues.capacity_max IS
  'Descriptive only — gates nothing (rule 13, 4 Aug 2026). NULL means nobody recorded it; '
  'it does not mean zero.';
