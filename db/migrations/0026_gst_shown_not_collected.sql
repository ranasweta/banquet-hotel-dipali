-- ============================================================
-- 0026 · 18% GST on everything but rooms — shown on the document, collected from nobody
-- ============================================================
-- Client (lead), 4 Aug 2026, amending the 20 Jul instruction recorded in SEED_ASSUMPTIONS §F8
-- ("only rooms are taxed"). Two separate things were decided in one sentence and they behave
-- differently, so the schema has to hold them apart:
--
--   rooms                 5%, printed AND collected. It sits inside the payable amount, inside
--                         the 25% advance base, and inside the balance — exactly as before.
--   venue / food /        18%, printed and nothing else. "at the end we are just showing we are
--   maintenance           taking 18% gst but we wont be taking it."
--
-- If the 18% were folded into `net_paise` the way `tax_paise` is, then `balance_paise`
-- (net − advances) would never reach zero however much the guest paid, and no booking could
-- ever be settled or closed. So `tax_paise` keeps its existing meaning — tax that is part of
-- what is owed, i.e. the 5% on rooms — and the 18% lands in a new column that participates in
-- no total except the one the document prints.
--
--   tax_paise        collected tax.  net = gross − discount + tax.  balance = net − advances.
--   shown_tax_paise  display only.   the document's "Total" = net + shown_tax.
--
-- Line-level tax is untouched: `invoice_lines.gst_rate_bp` and `tax_paise` record what each
-- line actually carries (18% on a venue line, 5% on a room line), so the printed break-up is
-- honest line by line. It is only the ROLL-UP that splits, by section — rooms collected,
-- everything else shown. See lib/tax.ts, which owns that test now.
--
-- Existing rows need no backfill: every invoice drafted before today was computed with 0% on
-- every head but rooms, so its shown tax genuinely is zero. Finalised documents keep the lines
-- and totals they were issued with — a superseded document is history, not a mistake to erase.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS shown_tax_paise bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN invoices.tax_paise IS
  'Tax that is COLLECTED — the 5% on rooms. Included in net_paise and therefore in balance_paise.';
COMMENT ON COLUMN invoices.shown_tax_paise IS
  'Tax that is SHOWN and not collected — the 18% on venue/food/maintenance (client, 4 Aug 2026). '
  'Enters no total but the document''s printed "Total"; never net_paise, never balance_paise, '
  'never a payment threshold.';
