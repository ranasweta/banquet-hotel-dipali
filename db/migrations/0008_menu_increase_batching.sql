-- ============================================================
-- 0008 · Menu increases batch per proposal (client, 20 Jul 2026)
-- ============================================================
-- Increases used to raise one exception per menu segment, so a wedding with four functions
-- could put five separate rows in the Higher Authority's queue. They are now batched into
-- ONE pending `menu_increase` exception per proposal, whose payload carries every increment
-- labelled by function and segment.
--
-- The payload shape therefore changed:
--
--   was  { subEventId, menuId, categoryName, currentPick, requestedPick, reason }
--   now  { items: [ { subEventId, subEventName, menuId, categoryName,
--                     currentPick, requestedPick, reason }, ... ] }
--
-- Any request already pending was raised in the old shape and the new apply path cannot
-- read it — the Authority would be unable to approve it. This migration rewrites those
-- rows in place. Decided requests (approved/rejected) are left exactly as they are: they
-- are history, nothing re-reads their payload, and rewriting history to suit new code
-- would be worse than leaving it honest.

-- Fold each old single-segment payload into a one-item batch, adding the function name the
-- new summary needs. Guarded on `? 'items'` so re-running is a no-op.
UPDATE exceptions x
   SET payload = jsonb_build_object(
         'items',
         jsonb_build_array(
           jsonb_build_object(
             'subEventId',    x.payload->>'subEventId',
             'subEventName',  COALESCE(se.name, 'Function'),
             'menuId',        x.payload->>'menuId',
             'categoryName',  x.payload->>'categoryName',
             'currentPick',   COALESCE((x.payload->>'currentPick')::int, 0),
             'requestedPick', COALESCE((x.payload->>'requestedPick')::int, 1),
             'reason',        COALESCE(x.payload->>'reason', 'free_increase_already_used')
           )
         )
       )
  FROM sub_events se
 WHERE se.id = (x.payload->>'subEventId')::uuid
   AND x.kind = 'menu_increase'
   AND x.status = 'pending'
   AND NOT (x.payload ? 'items');

-- Same, for any pending row whose sub-event has since been deleted: keep the request
-- readable rather than dropping it silently. The join above would skip these.
UPDATE exceptions
   SET payload = jsonb_build_object(
         'items',
         jsonb_build_array(
           jsonb_build_object(
             'subEventId',    payload->>'subEventId',
             'subEventName',  'Function (removed)',
             'menuId',        payload->>'menuId',
             'categoryName',  payload->>'categoryName',
             'currentPick',   COALESCE((payload->>'currentPick')::int, 0),
             'requestedPick', COALESCE((payload->>'requestedPick')::int, 1),
             'reason',        COALESCE(payload->>'reason', 'free_increase_already_used')
           )
         )
       )
 WHERE kind = 'menu_increase'
   AND status = 'pending'
   AND NOT (payload ? 'items');
