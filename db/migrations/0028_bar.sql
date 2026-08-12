-- ============================================================
-- 0028 · The bar — priced brands, ordered by the bottle, per function
-- ============================================================
-- Client, 12 Aug 2026. A booking may take alcohol; the Auditor keeps a list of brands and what
-- a bottle costs, and whoever builds the proposal picks a brand and a number of bottles on the
-- function that wants it. It reaches the bill from there without anybody re-typing a price.
--
-- WHY A SECOND TABLE AND NOT `sub_event_addons`. An add-on is free text and a typed-in rate,
-- which is exactly what this is meant to stop: "Blenders Pride" priced from memory, differently
-- on every booking. A bar line has to name a catalogue brand, so the two tables are not the
-- same shape however similar the arithmetic looks. They bill identically all the same — see
-- lib/invoice.ts, where both land in the `food` section.
--
-- WHY IT HANGS OFF THE FUNCTION, not the event (client's choice, 12 Aug 2026). A wedding takes
-- alcohol at the reception and none at the mehndi, and the bill already groups charges under
-- the function they were ordered for. An event-level Alcohol button just opens the list of
-- functions; nothing is lost and the bill can say which night it was.
--
-- TAX. The client's instruction is that alcohol is taxed like food: 18%, printed on the Total
-- and collected from nobody (CLAUDE.md rule 11). So a bar line is a `food` section line and
-- needs no new rate, no new column, and no change to lib/tax.ts.
--   NOTE FOR THE HOTEL'S CA, recorded in SEED_ASSUMPTIONS §F24 rather than decided here:
--   alcohol for human consumption sits OUTSIDE GST in India — state excise applies instead —
--   so an 18% GST line against a bottle may be the wrong label even though the money is right
--   (it is shown, never collected). Implemented as instructed; it is a one-line change in
--   lib/invoice.ts if the CA says otherwise.
--
-- PRICE CHANGES NEVER REACH A BOOKED EVENT. `bar_brands.price_per_bottle_paise` is the price
-- TODAY; `sub_event_bar_items` copies the name and the price onto the line when it is added
-- (CLAUDE.md rule 4). Re-pricing the bar therefore moves nothing that is already on a
-- proposal — same guarantee menus get from their snapshot, by the same means.

CREATE TABLE IF NOT EXISTS bar_brands (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  price_per_bottle_paise bigint NOT NULL CHECK (price_per_bottle_paise > 0),
  -- Retired, never deleted: a brand the hotel stops stocking must still explain the lines on
  -- last month's bills, and those read the snapshot rather than this row.
  is_active              boolean NOT NULL DEFAULT true
);

-- Case-insensitive, so "Blenders Pride" cannot be added a second time as "blenders pride" and
-- show up twice in the dropdown the picker searches.
CREATE UNIQUE INDEX IF NOT EXISTS bar_brands_name_key ON bar_brands (lower(name));

CREATE TABLE IF NOT EXISTS sub_event_bar_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_event_id uuid NOT NULL REFERENCES sub_events(id) ON DELETE CASCADE,
  -- The catalogue row it came from, kept for reporting ("how much Blenders Pride did we sell
  -- this quarter"). RESTRICT, not CASCADE: deleting a brand must not silently delete the
  -- bottles somebody has already been quoted for. Brands retire, they do not vanish.
  brand_id     uuid NOT NULL REFERENCES bar_brands(id) ON DELETE RESTRICT,
  -- Snapshots (rule 4). The bill reads THESE, never bar_brands.
  brand_name   text NOT NULL,
  rate_paise   bigint NOT NULL CHECK (rate_paise > 0),
  bottles      int NOT NULL CHECK (bottles > 0),
  -- One line per brand per function: ordering more is a bigger `bottles`, not a second row.
  -- Without this, "3 bottles" and "2 bottles" of the same thing sit on the bill as two lines
  -- that nobody can reconcile against the order.
  UNIQUE (sub_event_id, brand_id)
);

CREATE INDEX IF NOT EXISTS sub_event_bar_items_sub_event ON sub_event_bar_items (sub_event_id);

-- Locked means locked (rule 6). The guard is the same trigger the menu tables carry, and it
-- honours the Higher Authority's `app.gm_override` GUC exactly as they do — so the Authority
-- can still correct a bar line on a locked booking, with a reason, and nobody else can.
DROP TRIGGER IF EXISTS sub_event_bar_items_lock_guard ON sub_event_bar_items;
CREATE TRIGGER sub_event_bar_items_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sub_event_bar_items
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_menu_write();
