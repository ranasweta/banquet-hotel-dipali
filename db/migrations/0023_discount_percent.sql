-- ============================================================
-- 0023 · Percentage discounts per head (client, 25 Jul 2026)
-- ============================================================
-- Discounts may now be given as a percentage of a head's subtotal (menu / venue / room /
-- overall) — "30% on menu, 20% on venue" — recomputed live from the current bill rather than
-- frozen as a rupee. A row carries percent_bp (basis points of its head) alongside the rupee
-- value it worked out to at save time; percent_bp NULL means a plain fixed-rupee discount.
--
-- The combined effective discount must stay <= 10% of the TOTAL bill (venue + food + rooms,
-- pre-tax) — amends BR-D2, which measured venue+food only. That base is computed in the service.
ALTER TABLE discounts
  ADD COLUMN IF NOT EXISTS percent_bp int
  CHECK (percent_bp IS NULL OR (percent_bp > 0 AND percent_bp <= 10000));
