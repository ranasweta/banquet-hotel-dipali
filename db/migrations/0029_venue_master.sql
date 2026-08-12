-- ============================================================
-- 0029 · The venue master — and the hall an "Other" booking is not charged for
-- ============================================================
-- Client, 12 Aug 2026. Two things in one message, and they belong together because the second
-- is expressed entirely as data the first lets the Auditor edit.
--
-- 1. AN "OTHER" BOOKING PAYS NO HALL CHARGE. It is charged for the dining and the extras, but
--    not for the room it sits in. The catch, in the client's words: "if they select bundle then
--    thats okay we take that money but if specially a hall is taken for a event then it will
--    be 0". So a STANDALONE venue is written at zero for event_type = 'other'; a BUNDLE keeps
--    its rate. Every other event type is untouched — engagement, mahila_sangeet, birthday and
--    corporate go on paying exactly what they pay today.
--
--    ZERO, NOT ABSENT. A missing rate card is a gate that blocks confirmation until the
--    Authority approves a manual rate (BR-R1) — which is the opposite of what is wanted here.
--    The zero says "decided, and free"; a gap says "nobody has priced this yet". Two different
--    facts, and `venue_rate_cards.rate_paise` already allows 0 (CHECK >= 0), so no column
--    changes and no branch in the pricing code: `priceProposal` reads a 0 rate as a 0 charge
--    and only a NULL as a gate.
--
-- 2. THE VENUE MASTER. A new permission module so the Auditor can keep venues, bundles and
--    their per-event-type rates himself — "we will give whole centre point to set whatever he
--    gets ... to keep all things transparent and configured". Granted like `menu_master`:
--    Auditor full, Higher Authority edit, nobody else. The Chef gets nothing here (he reads
--    menus, not price lists).
--
-- 3. NEW VENUES AND PRICES from the same message. Ashoka Hall and Pool Side Hall are new and
--    sit under Palace (client-confirmed). Diamond and Golden are now sold apart as well as
--    together — their bundle keeps its own 25,000, so the pair costs what one hall costs.
--    Saffron drops to 35,000, superseding the 55,000 the 2026 proposal prints; recorded in
--    SEED_ASSUMPTIONS §F26 because it is the first time client instruction has overridden that
--    PDF on a price.
--
-- Capacities for the two new venues are invented (they appear in no PDF and no PRD table) and
-- are flagged as such in db/masters.ts. They gate nothing (rule 13).

-- --- 1. The venue_master module --------------------------------------------
INSERT INTO modules (code) VALUES ('venue_master') ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'venue_master', a.action::perm_action
FROM roles r
CROSS JOIN (VALUES ('view'), ('create_edit'), ('delete')) AS a(action)
WHERE r.name = 'auditor'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module_code, action)
SELECT r.id, 'venue_master', a.action::perm_action
FROM roles r
CROSS JOIN (VALUES ('view'), ('create_edit')) AS a(action)
WHERE r.name = 'higher_authority'
ON CONFLICT DO NOTHING;

-- --- 2. New venues ----------------------------------------------------------
INSERT INTO venues (property_id, name, kind, capacity_min, capacity_max)
SELECT p.id, v.name, v.kind, v.cmin, v.cmax
FROM properties p
CROSS JOIN (VALUES
  ('Ashoka Hall',    'hall', 1, 75),
  ('Pool Side Hall', 'hall', 1, 50)
) AS v(name, kind, cmin, cmax)
WHERE p.name = 'Palace'
ON CONFLICT (property_id, name) DO NOTHING;

-- --- 3. Rates for venues that had none, and Saffron's new price -------------
-- Written for every event type, then step 4 zeroes the 'other' row. Same effective_from the
-- seed uses, so `pnpm seed` and this migration cannot disagree about which slice they own.
INSERT INTO venue_rate_cards (venue_id, bundle_id, event_type, rate_paise, effective_from)
SELECT v.id, NULL, et.code, r.paise, DATE '2026-01-01'
FROM (VALUES
  ('Diamond Hall',   2500000::bigint),
  ('Golden Hall',    2500000::bigint),
  ('Ashoka Hall',    2500000::bigint),
  ('Pool Side Hall',  500000::bigint)
) AS r(venue, paise)
JOIN venues v ON v.name = r.venue
CROSS JOIN event_types et
WHERE NOT EXISTS (
  SELECT 1 FROM venue_rate_cards rc
   WHERE rc.venue_id = v.id AND rc.event_type = et.code AND rc.effective_from = DATE '2026-01-01'
);

UPDATE venue_rate_cards rc
   SET rate_paise = 3500000
  FROM venues v
 WHERE v.id = rc.venue_id
   AND v.name = 'Saffron Hall & Lawn'
   AND rc.effective_from = DATE '2026-01-01';

-- --- 4. The "Other" booking pays no hall charge -----------------------------
-- Standalone venues only. `bundle_id IS NULL` is the whole of the rule: a bundle row is left
-- exactly as it is, which is what "if they select bundle then thats okay we take that money"
-- means in SQL.
UPDATE venue_rate_cards
   SET rate_paise = 0
 WHERE venue_id IS NOT NULL
   AND event_type = 'other';

COMMENT ON COLUMN venue_rate_cards.rate_paise IS
  'What the venue or bundle costs for this event type. ZERO is a decision (an "Other" booking '
  'pays no standalone hall charge, client 12 Aug 2026); a MISSING row is a gate that blocks '
  'confirmation until the Authority approves a manual rate (BR-R1). They are not the same.';
