-- ============================================================
-- 0015 · The bill is read function by function (client, 21 Jul 2026)
-- ============================================================
-- The client's own summary sheet totals a proposal like this:
--
--   Function 1   venue  ₹—
--                menu   pax × (menu price + chef)
--                room   ₹— + 5% tax
--   Function 2   …
--   Function 3   …
--                            subtotal
--   maintenance              ₹—
--                            TOTAL
--
-- Lines are stored by SECTION (venue / food / rooms / maintenance / adjustment), which is
-- the right shape for tax — GST is per category — but the wrong shape for reading. Adding
-- the function each line belongs to lets the printed bill group the way the hotel counts,
-- while the section still decides the tax rate. Nothing about the arithmetic changes.
--
-- NULLABLE, and that is the honest answer for the lines that genuinely belong to no single
-- function: rooms are booked for the event across dates that span several of them, and
-- maintenance and adjustments are event-level by definition. Those render after the
-- functions rather than being forced under one.

ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS function_label text;

COMMENT ON COLUMN invoice_lines.function_label IS
  'Which function this line belongs to, for grouping the printed bill. NULL for lines that '
  'are event-level: rooms (booked across dates, not per function), maintenance, adjustments.';
