-- ============================================================
-- 0033 · Three dishes that were one dish under two names
-- ============================================================
-- Client, 13 Aug 2026: "if you see they are duplicates then remove them make them same in all".
--
-- These were the last three near-duplicates surviving `dedupeMenuNames` in the pooled Swap
-- list, and the test that settled each was: DOES ANY SINGLE TIER CARRY BOTH SPELLINGS? None
-- did. Two dishes that are genuinely different turn up together on at least one card — "Puri"
-- and "Masala Puri" sit side by side on Diamond and Crown, which is exactly why those two are
-- left alone here.
--
-- Two of the three turned out not to be spelling variants at all, but lines the splitter left
-- whole. Both are added to EXPLICIT_SPLITS in db/menu-split.ts so a fresh seed produces the
-- right dishes; this migration repairs the database that is already seeded.
--
--   1. PLATINUM, Assorted Indian Bread: "Puri Two Types"
--      "Two Types" is the count, not a dish. Diamond and Crown write the same line out as
--      "Missi Roti, Puri, Masala Puri", so Platinum's shorthand is those same two puris.
--      Becomes "Puri" + "Masala Puri", and Platinum's card now matches the others.
--
--   2. GOLD, Live Counter: "Aloo Tikki / Papdi Chaat"
--      Shares its trailing noun, like the koftas already in EXPLICIT_SPLITS. Every other tier
--      lists "Aloo Tikki Chaat", and Gold lists "Papdi Chaat" separately in the same breath —
--      so the split wanted was "Aloo Tikki Chaat" + "Papdi Chaat", not a bare "Aloo Tikki".
--      Papdi Chaat is already there, so only the rename is needed.
--
--   3. CROWN, Accompaniments: "Green Chilly Fried with Lemon"
--      A genuine spelling variant — the other four tiers say "Green Chilly Fried". Normalised
--      to match. NOTE FOR THE HOTEL: if the lemon is a real difference in what Crown serves
--      rather than a fuller way of writing the same thing, this is the one to put back — a
--      rename in the menu master, no migration needed.
--
-- Booked menus are untouched. `sub_event_menu_selections` copies dishes BY NAME at save
-- (BR-M1), so an event that chose "Aloo Tikki" keeps saying "Aloo Tikki" on its bill and its
-- printed card. This changes the catalogue, which is what the guest is offered NEXT.

-- 1. Platinum's puri line becomes the two puris it always meant.
UPDATE menu_items i SET name = 'Puri'
  FROM menu_categories c, menu_tiers t
 WHERE c.id = i.category_id AND t.id = c.tier_id
   AND t.name = 'Platinum' AND c.name = 'Assorted Indian Bread'
   AND i.name = 'Puri Two Types';

INSERT INTO menu_items (category_id, name)
SELECT c.id, 'Masala Puri'
  FROM menu_categories c JOIN menu_tiers t ON t.id = c.tier_id
 WHERE t.name = 'Platinum' AND c.name = 'Assorted Indian Bread'
ON CONFLICT (category_id, name) DO NOTHING;

-- 2. Gold's live counter loses the half-name.
UPDATE menu_items i SET name = 'Aloo Tikki Chaat'
  FROM menu_categories c, menu_tiers t
 WHERE c.id = i.category_id AND t.id = c.tier_id
   AND t.name = 'Gold' AND c.name = 'Live Counter'
   AND i.name = 'Aloo Tikki'
   AND NOT EXISTS (
     SELECT 1 FROM menu_items x WHERE x.category_id = i.category_id AND x.name = 'Aloo Tikki Chaat'
   );

-- 3. Crown's accompaniment is spelled like everybody else's.
UPDATE menu_items i SET name = 'Green Chilly Fried'
  FROM menu_categories c, menu_tiers t
 WHERE c.id = i.category_id AND t.id = c.tier_id
   AND t.name = 'Crown' AND c.name = 'Accompaniments'
   AND i.name = 'Green Chilly Fried with Lemon'
   AND NOT EXISTS (
     SELECT 1 FROM menu_items x WHERE x.category_id = i.category_id AND x.name = 'Green Chilly Fried'
   );
