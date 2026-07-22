'use client'

import { useEffect, useState } from 'react'
import { CalendarClock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TimePicker12 } from '@/components/ui/time-picker-12'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type Venue = { id: string; name: string; propertyName: string }
type SubEvent = { id: string; eventDate: string; startTime: string; endTime: string; venueName: string | null }

/** Files a date/time/venue change request for a confirmed sub-event (applied on approval). */
export function RequestChange({ sub }: { sub: SubEvent }) {
  const [open, setOpen] = useState(false)
  const [venues, setVenues] = useState<Venue[]>([])
  const [date, setDate] = useState(sub.eventDate)
  const [start, setStart] = useState(sub.startTime.slice(0, 5))
  const [end, setEnd] = useState(sub.endTime.slice(0, 5))
  const [venueId, setVenueId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open && venues.length === 0) {
      // Only priceable venues: a bundle-only venue picked here would be approved and
      // then dead-end on the missing-rate gate (BR-R1).
      api<{ venues: (Venue & { priceable?: boolean })[] }>('/booking-options')
        .then((r) => setVenues(r.venues.filter((v) => v.priceable !== false)))
        .catch(() => {})
    }
  }, [open, venues.length])

  async function submit() {
    const payload: Record<string, string> = {}
    if (date !== sub.eventDate) payload.event_date = date
    if (start !== sub.startTime.slice(0, 5)) payload.start_time = start
    if (end !== sub.endTime.slice(0, 5)) payload.end_time = end
    if (venueId) payload.venue_id = venueId
    if (Object.keys(payload).length === 0) { toast.error('Change at least one of date, time or venue'); return }
    setBusy(true)
    try {
      await api('/change-requests', { method: 'POST', body: JSON.stringify({ sub_event_id: sub.id, reason: reason.trim() || undefined, payload }) })
      toast.success('Change requested — the Banquet Manager will decide.')
      setOpen(false); setReason(''); setVenueId('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not request change')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)}>
        <CalendarClock className="size-3" /> Request change
      </Button>
    )
  }

  return (
    <div className="mt-2 rounded-md border border-dashed p-3">
      <div className="mb-2 text-xs text-muted-foreground">
        Request a date / time / venue change. Applies only after the Banquet Manager approves (the slot is re-checked then).
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label className="text-xs">Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" /></div>
        <div className="space-y-1"><Label className="text-xs">Start</Label><TimePicker12 value={start} onChange={setStart} /></div>
        <div className="space-y-1"><Label className="text-xs">End</Label><TimePicker12 value={end} onChange={setEnd} /></div>
        <div className="w-48 space-y-1">
          <Label className="text-xs">Venue (optional)</Label>
          <Select value={venueId} onValueChange={(v) => { if (v) setVenueId(v) }} items={venues.map((x) => ({ value: x.id, label: x.name }))}>
            <SelectTrigger><SelectValue placeholder={`Keep ${sub.venueName ?? 'current'}`} /></SelectTrigger>
            <SelectContent>
              {venues.map((x) => (<SelectItem key={x.id} value={x.id}>{x.name} · {x.propertyName}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div className="grow space-y-1"><Label className="text-xs">Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={submit} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />} Submit request</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  )
}
