-- ============================================================
-- 0037 · The 35+ room approval is withdrawn — a booking may take any number of rooms
-- ============================================================
-- Client, 12 Sep 2026: "wherever the 35+ room trigger is just remove it, anyone can have any
-- number of rooms, no 35 room warning or anything should be there". BR-L2 / FR-4.7 is retired.
--
-- WHAT IS GONE is only the APPROVAL. The hard inventory cap (CLAUDE.md rule 9) is untouched:
-- a party still cannot be given more rooms of a category than the lodge physically has free on
-- the tightest night of the stay, because that is a promise the hotel cannot keep. 40 rooms
-- when 27 exist is still refused; 40 rooms when 40 exist is now simply a booking.
--
-- TWO THINGS THIS FILE DOES.
--
--   1. SETTLES ANY PENDING REQUEST. A proposal that crossed 35 before today is sitting with a
--      `room_allocation_35plus` exception marked pending, and a pending exception is a blocking
--      line on the lock checklist (`lib/lock.ts`) and a card in the Authority's queue. Left
--      alone, those bookings could never be locked and the queue would keep asking for a
--      decision on a rule that no longer exists. They are marked approved, which is what the
--      withdrawal means: the rooms were always SAVED when they were asked for — the request
--      gated confirm and the lock, it never held the rooms back — so approving one releases
--      nothing and changes no money. `decided_by` stays NULL because no person decided it; the
--      remark says so, and the row keeps its raiser, its payload and its timestamps.
--
--   2. DROPS THE THRESHOLD SETTING. `large_allocation_rooms` has no reader left.
--
-- WHAT DELIBERATELY STAYS.
--
--   The `room_allocation_35plus` value in the `exception_kind` enum. Decided rows reference it
--   and still render on the approvals history and inside a bundle's settled list; dropping an
--   enum value would orphan them, and Postgres cannot remove one from a type in use anyway.
--   Nothing raises a new one — `lib/rooms.ts` no longer inserts any.
--
--   Every audit_log row about a past request. Append-only by construction (rule 5), and the
--   record of what was asked and who asked it remains true.

-- `exceptions` carries the locked-event lock guard (schema.sql §14, migration 0025), which
-- refuses any write against a locked/billed/closed event. The lock checklist blocks on a
-- pending exception, so a locked booking should not hold one — but "should not" is not a
-- guarantee to hang a deploy on, and a single such row would abort the whole migration. This
-- announces itself with the same transaction-local GUC the Higher Authority's own module uses
-- (CLAUDE.md rule 6); SET LOCAL dies with the transaction, so it cannot leak.
SET LOCAL app.gm_override = 'on';

UPDATE exceptions
   SET status    = 'approved',
       decided_at = now(),
       remark    = COALESCE(remark || ' · ', '')
                   || 'Auto-settled: the 35+ room approval was withdrawn (client, 12 Sep 2026).'
                   || ' A booking may take any number of rooms the lodge has free.'
 WHERE kind = 'room_allocation_35plus'
   AND status = 'pending';

DELETE FROM settings WHERE key = 'large_allocation_rooms';
