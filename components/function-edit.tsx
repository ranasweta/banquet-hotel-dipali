'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type EditableFunction = {
  id: string
  name: string
  eventDate: string
  startTime: string
  endTime: string
  venueId: string | null
  bundleId: string | null
  pax: number
}

type VenueAvailability = {
  venues: { id: string; name: string; propertyName: string; available: boolean }[]
  bundles: { id: string; name: string; members: string; available: boolean }[]
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Edit a function in place on the booking page — name, date, time, venue and pax (client,
 * 15 Aug 2026: "if someone wants to change the no. of pax or venue or date or timing").
 *
 * ENQUIRY ONLY, and the server agrees (`PUT /sub-events/:id`). An enquiry holds no
 * `venue_bookings` — those are written at confirm — so moving a date or a venue here moves
 * nothing and can clash with nothing. A confirmed booking's function is a held slot and belongs
 * to the change-request flow.
 *
 * Until now the only way to change a venue was to DELETE the function and add it again, which
 * threw the menu away with it. The route to edit one has existed since M3; nothing ever called
 * it.
 *
 * Availability is checked live once date + time are set, and only free venues are offered —
 * the same rule the wizard's add-a-function form follows (BR-C1). It is a courtesy, not the
 * guard: the venue exclusion constraint is what actually refuses a clash, at confirm.
 */
export function FunctionEdit({
  fn,
  onSaved,
  onCancel,
}: {
  fn: EditableFunction
  onSaved: () => Promise<void> | void
  onCancel: () => void
}) {
  const [name, setName] = useState(fn.name)
  const [date, setDate] = useState(fn.eventDate)
  const [start, setStart] = useState(fn.startTime.slice(0, 5))
  const [end, setEnd] = useState(fn.endTime.slice(0, 5))
  const [pax, setPax] = useState(String(fn.pax))
  const [target, setTarget] = useState(fn.bundleId ? `bundle:${fn.bundleId}` : fn.venueId ? `venue:${fn.venueId}` : '')
  const [avail, setAvail] = useState<VenueAvailability | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)

  const windowSet = Boolean(date) && HHMM.test(start) && HHMM.test(end) && start !== end

  const check = useCallback(async () => {
    if (!windowSet) return
    setChecking(true)
    try {
      setAvail(await api<VenueAvailability>(`/availability/venues?date=${date}&start=${start}&end=${end}`))
    } catch {
      setAvail(null)
    } finally {
      setChecking(false)
    }
  }, [date, start, end, windowSet])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check()
  }, [check])

  // The venue this function already has stays selectable even if the check calls it booked —
  // on an enquiry nothing is held, so a "booked" flag against the current pick can only mean
  // somebody else's confirmed hold, which the warning below names.
  const current = fn.bundleId ? `bundle:${fn.bundleId}` : fn.venueId ? `venue:${fn.venueId}` : ''
  const items = avail
    ? [
        ...avail.venues
          .filter((v) => v.available || `venue:${v.id}` === current)
          .map((v) => ({ value: `venue:${v.id}`, label: `${v.name} (${v.propertyName})` })),
        ...avail.bundles
          .filter((b) => b.available || `bundle:${b.id}` === current)
          .map((b) => ({ value: `bundle:${b.id}`, label: `${b.name} [bundle]` })),
      ]
    : []
  const takenCount = avail
    ? avail.venues.filter((v) => !v.available).length + avail.bundles.filter((b) => !b.available).length
    : 0
  const chosenIsTaken =
    Boolean(target) &&
    avail !== null &&
    [...avail.venues.map((v) => ({ k: `venue:${v.id}`, a: v.available })), ...avail.bundles.map((b) => ({ k: `bundle:${b.id}`, a: b.available }))]
      .some((x) => x.k === target && !x.a)

  async function save() {
    const n = Number(pax)
    if (!name.trim()) return toast.error('Give the function a name')
    if (!windowSet) return toast.error('Set a date and a start and end time')
    if (!target) return toast.error('Pick a venue')
    if (!Number.isInteger(n) || n < 1) return toast.error('Pax must be a whole number, at least one')

    const [kind, id] = target.split(':')
    setBusy(true)
    try {
      await api(`/sub-events/${fn.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: name.trim(),
          event_date: date,
          start_time: start,
          end_time: end,
          pax: n,
          ...(kind === 'bundle' ? { bundle_id: id } : { venue_id: id }),
        }),
      })
      await onSaved()
      toast.success('Function updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Pencil className="size-4 text-muted-foreground" aria-hidden /> Edit function
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="grow space-y-1">
          <Label className="text-xs" htmlFor={`fe-name-${fn.id}`}>Name</Label>
          <Input id={`fe-name-${fn.id}`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`fe-date-${fn.id}`}>Date</Label>
          <Input id={`fe-date-${fn.id}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="w-24 space-y-1">
          <Label className="text-xs" htmlFor={`fe-start-${fn.id}`}>From</Label>
          <Input id={`fe-start-${fn.id}`} type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="w-24 space-y-1">
          <Label className="text-xs" htmlFor={`fe-end-${fn.id}`}>To</Label>
          <Input id={`fe-end-${fn.id}`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div className="w-24 space-y-1">
          <Label className="text-xs" htmlFor={`fe-pax-${fn.id}`}>Pax</Label>
          <Input id={`fe-pax-${fn.id}`} inputMode="numeric" value={pax} onChange={(e) => setPax(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="grow space-y-1">
          <Label className="text-xs">Venue</Label>
          <Select
            items={items}
            value={target}
            onValueChange={(v) => setTarget(v ?? '')}
            disabled={!windowSet || checking}
          >
            <SelectTrigger className="min-w-56">
              <SelectValue placeholder={windowSet ? 'Choose a free venue' : 'Set the date and time first'} />
            </SelectTrigger>
            <SelectContent>
              {items.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} Save
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          <X className="size-4" /> Cancel
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {!windowSet ? (
          'Set a date and a start and end time to see which venues are free.'
        ) : checking ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Checking availability…
          </span>
        ) : chosenIsTaken ? (
          <span className="text-amber-600">
            This venue is already held over that window by a confirmed booking. You can save it —
            an enquiry holds nothing — but confirming will be refused until one of them moves.
          </span>
        ) : takenCount > 0 ? (
          `${takenCount} venue${takenCount === 1 ? '' : 's'} hidden — already held over this window.`
        ) : (
          'Every venue is free over this window.'
        )}
      </p>
    </div>
  )
}
