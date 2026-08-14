'use client'

import { useState } from 'react'
import { Loader2, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Contact = { phone: string; label: string | null }

/**
 * Guest name, contact numbers and the proposal's declared run, edited in place on the booking
 * page while it is an enquiry (client, 15 Aug 2026).
 *
 * All three already went through `PUT /events/:id`; the only way to reach them was to reopen
 * the wizard at step 1. The declared run is here because it bounds the room dates (rule 9) —
 * shortening it while the rooms outside it stay put is exactly the sort of thing the guarded
 * save is there to refuse, out loud, rather than let through.
 */
export function BookingBasicsEdit({
  eventId,
  guestName,
  contacts,
  plannedFrom,
  plannedTo,
  onSaved,
  onCancel,
}: {
  eventId: string
  guestName: string
  contacts: Contact[]
  plannedFrom: string | null
  plannedTo: string | null
  onSaved: () => Promise<void> | void
  onCancel: () => void
}) {
  const [name, setName] = useState(guestName)
  const [from, setFrom] = useState(plannedFrom ?? '')
  const [to, setTo] = useState(plannedTo ?? '')
  const [rows, setRows] = useState<Contact[]>(
    contacts.length > 0 ? contacts.map((c) => ({ ...c })) : [{ phone: '', label: null }],
  )
  const [busy, setBusy] = useState(false)

  const setRow = (i: number, patch: Partial<Contact>) =>
    setRows((r) => r.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  async function save() {
    if (!name.trim()) return toast.error('The guest needs a name')
    const contactsPayload = rows
      .map((c) => ({ phone: c.phone.trim(), label: c.label?.trim() || undefined }))
      .filter((c) => c.phone)
    if (contactsPayload.length === 0) return toast.error('At least one contact number')
    if (contactsPayload.some((c) => !/^\d{10}$/.test(c.phone))) {
      return toast.error('Each contact must be a 10-digit mobile number')
    }
    if (from && to && to < from) return toast.error('The To date cannot be before the From date')

    setBusy(true)
    try {
      await api(`/events/${eventId}`, {
        method: 'PUT',
        body: JSON.stringify({
          guest_name: name.trim(),
          contacts: contactsPayload,
          ...(from ? { from_date: from } : {}),
          ...(to ? { to_date: to } : {}),
        }),
      })
      await onSaved()
      toast.success('Booking details updated')
    } catch (e) {
      // The server refuses a contact count below the event type's minimum and a run that no
      // longer covers the rooms; both come back as a sentence worth showing verbatim.
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grow space-y-1">
          <Label className="text-xs" htmlFor="bb-guest">Guest name</Label>
          <Input id="bb-guest" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="bb-from">From</Label>
          <Input id="bb-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="bb-to">To</Label>
          <Input id="bb-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Contact numbers</Label>
        {rows.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              inputMode="numeric"
              placeholder="10-digit mobile"
              className="w-44 tabular-nums"
              value={c.phone}
              onChange={(e) => setRow(i, { phone: e.target.value })}
            />
            <Input
              placeholder="label (father, coordinator…)"
              className="w-56"
              value={c.label ?? ''}
              onChange={(e) => setRow(i, { label: e.target.value })}
            />
            {rows.length > 1 && (
              <Button size="icon-xs" variant="ghost" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
                <Trash2 className="size-3" />
              </Button>
            )}
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRows((r) => [...r, { phone: '', label: null }])}
          disabled={rows.length >= 6}
        >
          <Plus className="size-3.5" /> Add a number
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} Save
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          <X className="size-4" /> Cancel
        </Button>
      </div>
    </div>
  )
}
