-- ============================================================
-- 0032 · Room rates freeze at confirmation, like venue rates
-- ============================================================
-- Client, 13 Aug 2026, on being told the lodge master re-prices unbilled bookings: "yes freeze
-- the room rates at confirm like venues".
--
-- Every other priced thing on a booking already snapshots. A menu copies its per-plate rate
-- onto the sub-event at save (BR-M1); a venue copies its rate-card figure into
-- `sub_events.venue_rate_paise` at confirm; a bar line copies the brand's price when the
-- bottles are ordered. Rooms were the exception: `room_requirements` recorded lodge, category,
-- count and dates but no PRICE, and every reader computed
--
--     min(rack_rate_paise) over the live `rooms` table
--
-- which meant re-pricing a category moved every proposal and unissued Draft that used it. A
-- guest quoted 27 deluxe at 4,500 could be billed at 5,200 because the Auditor put the rack
-- rate up in between, and nothing in the booking would show why.
--
-- WHAT THE COLUMN MEANS. `rate_paise` is the nightly rate this line was CONFIRMED at. It is
-- NULL until confirmation, because an enquiry is not a promise: a draft proposal quotes live
-- prices and should keep doing so, exactly as an unconfirmed venue does.
--
-- WHY NULLABLE FOREVER, NOT BACKFILLED. Every reader is written as
--
--     COALESCE(rr.rate_paise, <the live min>)
--
-- so a row with no snapshot behaves precisely as it did before this migration. That covers the
-- enquiries by design, and it also covers the four bookings already confirmed on prod: they
-- were never quoted against a frozen rate, so inventing one now and stamping it on would be
-- writing history that did not happen. They go on reading live until they are billed, which is
-- what they have always done. Backfilling would look tidier and would be a lie.

ALTER TABLE room_requirements ADD COLUMN IF NOT EXISTS rate_paise bigint
  CHECK (rate_paise IS NULL OR rate_paise > 0);

COMMENT ON COLUMN room_requirements.rate_paise IS
  'Nightly rate frozen at confirmation (client, 13 Aug 2026), mirroring sub_events.venue_rate_paise. '
  'NULL while the booking is an enquiry, and on bookings confirmed before this column existed — '
  'every reader is COALESCE(rate_paise, live min), so NULL means "price it live", never "free".';
