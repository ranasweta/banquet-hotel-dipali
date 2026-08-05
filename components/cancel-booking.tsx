'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Cancelling a booking (PRD §4.1). The service and its route have existed since 2 Aug 2026 with
 * 217 lines of tests behind them, and nothing in the app could reach them — every "Cancel" in
 * the UI dismissed a dialog. That gap mattered more than it looked: the escalation path for a
 * part-paid booking (client's lead, 4 Aug 2026) is the Booking Manager seeing **Downpayment
 * due** on the calendar and ringing the Higher Authority, "who has the authority to cancel".
 * There was no button for him to do it with.
 *
 * Three things it is careful about:
 *
 *  - **Only before the lock.** PRD §4.1 allows cancelled from enquiry, confirmed, in_progress
 *    and completed, and refuses it from locked onward. The button is hidden past that rather
 *    than offered and rejected — `transitionEvent` still enforces it server-side either way.
 *  - **A reason, typed.** The route requires one and it lands in `events.cancel_reason` and the
 *    audit trail. It is also the confirmation step: there is no separate "are you sure", because
 *    having to say WHY is a better guard than having to click twice.
 *  - **It says what it frees.** Cancelling deletes the venue holds outright (a GiST exclusion
 *    cannot read event status, so the rows must go) and drops the rooms from every availability
 *    query. Payments, discounts and documents are deliberately kept — an advance may need
 *    refunding, and cancelling is not a way to erase a booking.
 */

const CANCELLABLE = new Set(['enquiry', 'confirmed', 'in_progress', 'completed'])

export function CancelBooking({
  eventId,
  code,
  status,
  canCancel,
}: {
  eventId: string
  code: string
  status: string
  canCancel: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  if (!canCancel || !CANCELLABLE.has(status)) return null

  async function cancel() {
    if (!reason.trim()) {
      toast.error('A reason is required to cancel.')
      return
    }
    setBusy(true)
    try {
      await api(`/events/${eventId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      })
      toast.success(`${code} cancelled — its venues and rooms are free again.`)
      setOpen(false)
      setReason('')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not cancel this booking')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-muted-foreground underline-offset-4 hover:text-destructive hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Cancel booking
      </button>
    )
  }

  return (
    <div className="w-full max-w-sm space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-left">
      <p className="text-sm font-medium text-destructive">Cancel {code}?</p>
      {/* Said plainly, because the venue holds are deleted and a second guest can take the
          date the moment this goes through. */}
      <p className="text-xs text-muted-foreground">
        {status === 'enquiry'
          ? 'This enquiry holds no dates, so nothing is released — it simply closes.'
          : 'The venue windows are released immediately and the rooms stop counting against the lodge. Payments, discounts and documents are kept; an advance may still need refunding.'}
      </p>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`cancel-reason-${eventId}`}>
          Reason (required — it is audited)
        </Label>
        <Input
          id={`cancel-reason-${eventId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. guest postponed; advance not completed"
          autoFocus
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="destructive" onClick={cancel} disabled={busy || !reason.trim()}>
          {busy && <Loader2 className="size-4 animate-spin" />} Cancel booking
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setOpen(false); setReason('') }}
          disabled={busy}
        >
          Keep it
        </Button>
      </div>
    </div>
  )
}
