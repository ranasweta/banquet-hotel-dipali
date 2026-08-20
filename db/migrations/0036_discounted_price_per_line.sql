-- ============================================================
-- 0036 · The discounted price, per line
-- ============================================================
-- Client, 20 Aug 2026, after the staff used it in the field. A discount stopped being MONEY
-- TAKEN OFF and became THE PRICE WE ARE ACTUALLY CHARGING.
--
-- What the staff hit: the old panel asked for a head (Venue / Menu / Rooms / Overall) and a
-- rupee figure, and that figure was subtracted from the bill at the very end. The line prices
-- on the screen never moved. So the person at the counter, looking at "Venue — Imperial
-- ₹75,000" and wanting to give it for ₹60,000, had to do the subtraction in their head, type
-- ₹15,000 into a box somewhere else, and trust the total. They asked for the obvious thing
-- instead: a second column beside the real one, prefilled with the real price, that they
-- overwrite with what the guest is actually paying.
--
-- So every priced line now carries two figures — the ACTUAL, which never moves, and the
-- DISCOUNTED, which is what is collected. Nothing is subtracted anywhere on screen or on the
-- document. The guest sees both columns and can read what they were given.
--
-- WHAT IS STORED IS THE GAP, NOT THE TYPED PRICE, and that is the client's instruction of
-- 20 Aug: "the Billing figure always follows the live feeding of pax, menu, everything as it
-- is." A booking is re-priced constantly — pax moves, a menu is swapped, a rate card is
-- re-dated — and a frozen rupee figure sitting in the Discounted column would stop tracking
-- the moment it did. Storing the gap keeps the column live:
--
--     Food, 250 pax x Rs.700 = Rs.1,75,000 actual.  Typed: Rs.1,50,000  ->  gap Rs.25,000.
--     Pax later becomes 300  ->  actual Rs.2,10,000, Discounted now reads Rs.1,85,000.
--
-- A flat gap, not a per-plate one (client, asked and answered): what is typed is what the
-- guest gets, which is the same rule the 4 Aug 2026 amendment settled for the old amounts.
-- The gap is clamped at the line — `GREATEST(0, actual - gap)` — so a line that shrinks below
-- what was given never turns into a credit.
--
-- WHY line_key AND NOT ref_id. `ref_id` is a uuid and two of the three lines have no stable
-- one to point at. Saving room requirements DELETES AND RE-INSERTS every row (rule 9), so a
-- room discount keyed on `room_requirements.id` would be orphaned the next time anybody
-- touched the rooms. The key is therefore the line's natural identity, as text:
--
--     venue:<sub_event_id>
--     food:<sub_event_id>
--     room:<unit_id|->:<room_type>:<check_in>:<check_out>
--
-- which survives the re-insert, and which the same three readers -- lib/payment-schedule.ts,
-- lib/invoice.ts and lib/proposal.ts -- can each rebuild in SQL without a join back to a row
-- that may not exist any more. Changing a room's dates orphans its discount, deliberately:
-- that is a different line and it is priced afresh.
--
-- line_key IS NULL is the OLD lump discount, and those rows keep working exactly as they did
-- (client, 20 Aug: "keep what we've already recorded as promised to our guests"). They are
-- subtracted at the end of the bill and, having no line to attach to, move no tax. Nothing new
-- writes one.
--
-- TAX FOLLOWS THE MONEY (client, 20 Aug: "the money we will be collecting is what will be
-- taxed"). This is the change that reaches furthest. Until now the 5%/18% on rooms was charged
-- on the full room price and the discount came off afterwards, so a room discount cut the
-- charge and not the tax. Now the tax base is the DISCOUNTED line, and the band is re-read off
-- the DISCOUNTED nightly rate: an Rs.11,000 suite given for Rs.7,000 a night is a 5% room,
-- because Rs.7,000 is what the hotel collects on it. The shown-and-never-collected 18% on
-- venue and food follows the same figure, so the printed Total agrees with the columns above it.
--
-- THE REMARK IS NO LONGER MANDATORY (client, 20 Aug: "one per save, but not mandatory"), which
-- reverses FR-11.1 and the last line of rule 3. It is one remark per save now, covering every
-- cell that moved in it, and an empty one is stored as ''. Nothing becomes untraceable: the
-- audit row still names who moved which line from what to what, which is where a query would
-- look anyway. See docs/SEED_ASSUMPTIONS.md F26.
--
-- The 10% cap (BR-D2) is UNTOUCHED. It is measured on the same combined figure it always was --
-- the sum of every gap plus any surviving lump -- and a save that crosses it still goes to the
-- Higher Authority as ONE pending exception carrying every cell in that save, rather than one
-- request per cell. The Authority is still uncapped, and his cells take effect at once.

ALTER TABLE discounts ADD COLUMN line_key text;

COMMENT ON COLUMN discounts.line_key IS
  'The line this discount prices: venue:<sub_event_id>, food:<sub_event_id>, or '
  'room:<unit|->:<type>:<in>:<out>. NULL = a pre-20-Aug-2026 lump discount, subtracted at the '
  'end of the bill and moving no tax. amount_paise is the GAP below the actual, never the '
  'typed price — see the migration header.';

-- One line, one discounted price. A save REPLACES the line's row (pending or effective), so a
-- second price for the same line can never be sitting behind the first waiting for approval.
CREATE UNIQUE INDEX discounts_event_line_uniq
  ON discounts (event_id, line_key) WHERE line_key IS NOT NULL;

-- The remark stops being required (client, 20 Aug). Kept NOT NULL with '' rather than made
-- nullable: every reader already treats it as a string, and '' says "none given" without
-- teaching the whole codebase a third state.
ALTER TABLE discounts ALTER COLUMN remark SET DEFAULT '';

-- The document prints BOTH columns (client, 20 Aug: "you can add the discounted column while
-- also keeping the actual column to show the client we have given them discount"), so an issued
-- bill has to remember what the line would have cost. `amount_paise` stays what it has always
-- been — what is charged — and this is the figure beside it. NULL on every line written before
-- today and on every line that was never discounted, read as "the same".
ALTER TABLE invoice_lines ADD COLUMN gross_amount_paise bigint;

COMMENT ON COLUMN invoice_lines.gross_amount_paise IS
  'The undiscounted price of this line, printed in the Actual column. NULL = never discounted, '
  'read as equal to amount_paise. amount_paise remains what is charged and what tax_paise is '
  'computed on.';
