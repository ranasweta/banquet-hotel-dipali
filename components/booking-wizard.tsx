'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

type EventType = { code: string; displayName: string; contactNumbers: number; isWedding: boolean }
type Venue = { id: string; name: string; kind: string; propertyName: string; capacityMin: number; capacityMax: number }
type Bundle = { id: string; name: string; members: string }
type Options = { eventTypes: EventType[]; venues: Venue[]; bundles: Bundle[]; roomTypes: string[] }

type SubEvent = {
  id: string
  name: string
  eventDate: string
  startTime: string
  endTime: string
  venueId: string | null
  bundleId: string | null
  pax: number
}
type RoomReq = { room_type: string; count: number; check_in: string; check_out: string }
type Quote = {
  totalPaise: number
  advanceRequiredPaise: number
  lines: { subEventId: string; name: string; ratePaise: number | null }[]
  missing: { subEventId: string; name: string }[]
}

const STEPS = ['Guest & event', 'KYC', 'Functions', 'Rooms', 'Review & confirm']

export function BookingWizard() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [options, setOptions] = useState<Options | null>(null)
  const [eventId, setEventId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Step 1
  const [eventType, setEventType] = useState('')
  const [guestName, setGuestName] = useState('')
  const [contacts, setContacts] = useState<string[]>([''])

  // Step 2
  const [docs, setDocs] = useState<{ aadhaar_front?: boolean; aadhaar_back?: boolean }>({})

  // Step 3
  const [subEvents, setSubEvents] = useState<SubEvent[]>([])

  // Step 4
  const [rooms, setRooms] = useState<RoomReq[]>([])

  // Step 5
  const [quote, setQuote] = useState<Quote | null>(null)

  useEffect(() => {
    api<Options>('/booking-options')
      .then(setOptions)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load options'))
  }, [])

  const selectedType = options?.eventTypes.find((t) => t.code === eventType)

  // Keep the contact fields in step with the event type's required count.
  useEffect(() => {
    if (!selectedType) return
    // Sync the number of contact fields to the event type's required count.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContacts((prev) => {
      const next = [...prev]
      while (next.length < selectedType.contactNumbers) next.push('')
      return next.slice(0, Math.max(selectedType.contactNumbers, next.filter(Boolean).length || 1))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType])

  const lawnWedding = useMemo(
    () =>
      selectedType?.isWedding &&
      subEvents.some((s) => {
        const v = options?.venues.find((x) => x.id === s.venueId)
        return v?.kind === 'lawn'
      }),
    [selectedType, subEvents, options],
  )

  async function refreshSubEvents(id: string) {
    const { event } = await api<{ event: { subEvents: SubEvent[] } }>(`/events/${id}`)
    setSubEvents(event.subEvents)
  }

  // ---- Step 1: create or update the enquiry ----
  async function submitStep1() {
    const trimmed = contacts.map((c) => c.trim()).filter(Boolean)
    if (!eventType) return toast.error('Choose an event type')
    if (!guestName.trim()) return toast.error('Enter the guest name')
    if (trimmed.length < (selectedType?.contactNumbers ?? 1)) {
      return toast.error(`${selectedType?.contactNumbers} contact number(s) required for a ${selectedType?.displayName}`)
    }
    setBusy(true)
    try {
      const contactsPayload = trimmed.map((phone, i) => ({ phone, label: i === 0 ? 'primary' : undefined }))
      if (!eventId) {
        const { event } = await api<{ event: { id: string } }>('/events', {
          method: 'POST',
          body: JSON.stringify({ guest_name: guestName, event_type: eventType, contacts: contactsPayload }),
        })
        setEventId(event.id)
      } else {
        await api(`/events/${eventId}`, {
          method: 'PUT',
          body: JSON.stringify({ guest_name: guestName, contacts: contactsPayload }),
        })
      }
      setStep(1)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  async function uploadDoc(kind: 'aadhaar_front' | 'aadhaar_back', file: File) {
    if (!eventId) return
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('kind', kind)
      fd.append('file', file)
      const res = await fetch(`/api/v1/events/${eventId}/documents`, { method: 'POST', body: fd })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message ?? 'Upload failed')
      }
      setDocs((d) => ({ ...d, [kind]: true }))
      toast.success(`${kind === 'aadhaar_front' ? 'Front' : 'Back'} uploaded`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function saveRooms(next: number) {
    if (!eventId) return
    setBusy(true)
    try {
      await api(`/events/${eventId}/room-requirements`, {
        method: 'POST',
        body: JSON.stringify({ requirements: rooms.filter((r) => r.room_type && r.count > 0) }),
      })
      setStep(next)
      if (next === 4) await loadQuote()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save rooms')
    } finally {
      setBusy(false)
    }
  }

  async function loadQuote() {
    if (!eventId) return
    try {
      setQuote(await api<Quote>(`/events/${eventId}/quote`))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not price the proposal')
    }
  }

  if (!options) return <p className="text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="space-y-6">
      <Stepper step={step} />

      {step === 0 && (
        <StepCard title="Guest & event">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Event type">
              <Select items={options.eventTypes.map((t) => ({ value: t.code, label: t.displayName }))} value={eventType} onValueChange={(v) => setEventType(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {options.eventTypes.map((t) => (
                    <SelectItem key={t.code} value={t.code}>{t.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Guest name">
              <Input value={guestName} onChange={(e) => setGuestName(e.target.value)} />
            </Field>
          </div>
          <div className="space-y-2">
            <Label>
              Contact numbers{selectedType ? ` (${selectedType.contactNumbers} required)` : ''}
            </Label>
            {contacts.map((c, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={c}
                  placeholder={i === 0 ? 'Primary contact' : `Contact ${i + 1}`}
                  onChange={(e) => setContacts((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                />
                {contacts.length > 1 && (
                  <Button variant="ghost" size="icon" onClick={() => setContacts((prev) => prev.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setContacts((prev) => [...prev, ''])}>
              Add contact
            </Button>
          </div>
          <Nav onNext={submitStep1} busy={busy} nextLabel={eventId ? 'Save & continue' : 'Create enquiry'} />
        </StepCard>
      )}

      {step === 1 && (
        <StepCard title="KYC — Aadhaar images">
          <p className="text-sm text-muted-foreground">
            Front and back are required to confirm (FR-1.10). Stored encrypted; visible only to
            staff with Bookings access.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(['aadhaar_front', 'aadhaar_back'] as const).map((kind) => (
              <div key={kind} className="rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  {docs[kind] && <Check className="size-4 text-emerald-600" />}
                  {kind === 'aadhaar_front' ? 'Aadhaar front' : 'Aadhaar back'}
                </div>
                <Input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => e.target.files?.[0] && uploadDoc(kind, e.target.files[0])}
                />
              </div>
            ))}
          </div>
          <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} busy={busy} nextDisabled={!docs.aadhaar_front || !docs.aadhaar_back} />
        </StepCard>
      )}

      {step === 2 && eventId && (
        <StepCard title="Functions">
          <SubEventEditor
            eventId={eventId}
            options={options}
            subEvents={subEvents}
            onChange={() => refreshSubEvents(eventId)}
          />
          <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} busy={busy} nextDisabled={subEvents.length === 0} />
        </StepCard>
      )}

      {step === 3 && (
        <StepCard title="Room requirements">
          {lawnWedding && (
            <p className="rounded-md border bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              Lawn wedding — Palace is the preferred lodging unit (BR-L1). The Lodge Manager
              allocates specific rooms later.
            </p>
          )}
          <RoomEditor rooms={rooms} setRooms={setRooms} roomTypes={options.roomTypes} />
          <Nav onBack={() => setStep(2)} onNext={() => saveRooms(4)} busy={busy} nextLabel="Save & review" />
        </StepCard>
      )}

      {step === 4 && eventId && (
        <ReviewStep
          eventId={eventId}
          quote={quote}
          onBack={() => setStep(3)}
          onConfirmed={(code) => {
            toast.success(`Confirmed — ${code}`)
            router.push('/calendar')
          }}
        />
      )}
    </div>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex flex-wrap gap-2">
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={cn(
            'flex items-center gap-2 rounded-full border px-3 py-1 text-sm',
            i === step && 'border-primary bg-primary text-primary-foreground',
            i < step && 'border-emerald-300 text-emerald-700 dark:text-emerald-300',
          )}
        >
          <span className="tabular-nums">{i < step ? '✓' : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  )
}

function StepCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function Nav({
  onBack,
  onNext,
  busy,
  nextLabel = 'Continue',
  nextDisabled,
}: {
  onBack?: () => void
  onNext: () => void
  busy?: boolean
  nextLabel?: string
  nextDisabled?: boolean
}) {
  return (
    <div className="flex justify-between pt-2">
      {onBack ? <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button> : <span />}
      <Button onClick={onNext} disabled={busy || nextDisabled}>
        {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
        {nextLabel}
      </Button>
    </div>
  )
}

function SubEventEditor({
  eventId,
  options,
  subEvents,
  onChange,
}: {
  eventId: string
  options: Options
  subEvents: SubEvent[]
  onChange: () => void
}) {
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [target, setTarget] = useState('') // venue:<id> or bundle:<id>
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [pax, setPax] = useState('')
  const [note, setNote] = useState('')
  const [avail, setAvail] = useState<{ available: boolean; conflicts: { subEventName: string; eventCode: string }[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const venueName = (s: SubEvent) =>
    s.bundleId
      ? options.bundles.find((b) => b.id === s.bundleId)?.name ?? 'Bundle'
      : options.venues.find((v) => v.id === s.venueId)?.name ?? 'Venue'

  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
  const canCheck = date && HHMM.test(start) && HHMM.test(end) && start !== end && target

  async function checkAvailability() {
    if (!canCheck) return
    const [kind, id] = target.split(':')
    const p = new URLSearchParams({ date, start, end, [kind === 'bundle' ? 'bundle_id' : 'venue_id']: id })
    try {
      setAvail(await api(`/availability?${p.toString()}`))
    } catch {
      setAvail(null)
    }
  }

  async function add() {
    const [kind, id] = target.split(':')
    if (!name || !canCheck || !pax) return toast.error('Fill in all fields')
    setBusy(true)
    try {
      await api(`/events/${eventId}/sub-events`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          event_date: date,
          start_time: start,
          end_time: end,
          [kind === 'bundle' ? 'bundle_id' : 'venue_id']: id,
          pax: Number(pax),
          pax_override_note: note || undefined,
        }),
      })
      setName(''); setDate(''); setTarget(''); setStart(''); setEnd(''); setPax(''); setNote(''); setAvail(null)
      onChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add function')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    await api(`/sub-events/${id}`, { method: 'DELETE' }).catch((e) => toast.error(e.message))
    onChange()
  }

  const targetItems = [
    ...options.venues.map((v) => ({ value: `venue:${v.id}`, label: `${v.name} (${v.propertyName})` })),
    ...options.bundles.map((b) => ({ value: `bundle:${b.id}`, label: `${b.name} [bundle]` })),
  ]

  return (
    <div className="space-y-4">
      {subEvents.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {subEvents.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{s.name}</span>{' '}
                <span className="text-muted-foreground tabular-nums">
                  {s.eventDate} · {s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)} · {venueName(s)} · {s.pax} pax
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => remove(s.id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Function name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sangeet" />
          </Field>
          <Field label="Venue / bundle">
            <Select items={targetItems} value={target} onValueChange={(v) => { setTarget(v ?? ''); setAvail(null) }}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {targetItems.map((it) => (
                  <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Pax">
            <Input type="number" value={pax} onChange={(e) => setPax(e.target.value)} />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setAvail(null) }} />
          </Field>
          <Field label="Start">
            <Input type="time" value={start} onChange={(e) => { setStart(e.target.value); setAvail(null) }} />
          </Field>
          <Field label="End">
            <Input type="time" value={end} onChange={(e) => { setEnd(e.target.value); setAvail(null) }} />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={checkAvailability} disabled={!canCheck}>
            Check availability
          </Button>
          {avail && (
            avail.available ? (
              <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">Available</Badge>
            ) : (
              <span className="text-sm text-destructive">
                Clashes with {avail.conflicts.map((c) => `${c.subEventName} (${c.eventCode})`).join(', ')}
              </span>
            )
          )}
        </div>
        {avail && !avail.available && (
          <p className="mt-2 text-xs text-muted-foreground">
            You can still add it, but confirmation will fail until the clash is cleared.
          </p>
        )}
        <div className="mt-3">
          <Input placeholder="Pax override note (only if outside venue capacity)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button className="mt-3" onClick={add} disabled={busy}>Add function</Button>
      </div>
    </div>
  )
}

function RoomEditor({
  rooms,
  setRooms,
  roomTypes,
}: {
  rooms: RoomReq[]
  setRooms: (r: RoomReq[]) => void
  roomTypes: string[]
}) {
  const add = () => setRooms([...rooms, { room_type: roomTypes[0] ?? 'deluxe', count: 1, check_in: '', check_out: '' }])
  const update = (i: number, patch: Partial<RoomReq>) => setRooms(rooms.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => setRooms(rooms.filter((_, j) => j !== i))
  return (
    <div className="space-y-3">
      {rooms.length === 0 && <p className="text-sm text-muted-foreground">No rooms required. Add a line if the guest needs lodging.</p>}
      {rooms.map((r, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-5">
          <Select items={roomTypes.map((t) => ({ value: t, label: t }))} value={r.room_type} onValueChange={(v) => update(i, { room_type: v ?? '' })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{roomTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="number" min={1} value={r.count} onChange={(e) => update(i, { count: Number(e.target.value) })} placeholder="Count" />
          <Input type="date" value={r.check_in} onChange={(e) => update(i, { check_in: e.target.value })} />
          <Input type="date" value={r.check_out} onChange={(e) => update(i, { check_out: e.target.value })} />
          <Button variant="ghost" size="icon" onClick={() => remove(i)}><Trash2 className="size-4" /></Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={add}>Add room requirement</Button>
    </div>
  )
}

function ReviewStep({
  eventId,
  quote,
  onBack,
  onConfirmed,
}: {
  eventId: string
  quote: Quote | null
  onBack: () => void
  onConfirmed: (code: string) => void
}) {
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('upi')
  const [receipt, setReceipt] = useState('')
  const [receivedOn, setReceivedOn] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (quote && !amount) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAmount(String(quote.advanceRequiredPaise / 100))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote])

  async function confirm() {
    if (!receipt.trim() || !receivedOn) return toast.error('Enter the receipt number and date')
    setBusy(true)
    try {
      const { event } = await api<{ event: { code: string } }>(`/events/${eventId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          advance: {
            amount_paise: rupeesToPaise(Number(amount)),
            mode,
            receipt_no: receipt,
            received_on: receivedOn,
          },
        }),
      })
      onConfirmed(event.code)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Confirmation failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <StepCard title="Review & confirm">
      {!quote ? (
        <p className="text-sm text-muted-foreground">Pricing…</p>
      ) : (
        <>
          {quote.missing.length > 0 && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              No rate is defined for: {quote.missing.map((m) => m.name).join(', ')}. An
              Authority-approved manual rate is needed before this can be confirmed (BR-R1).
            </p>
          )}
          <div className="rounded-lg border">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {quote.lines.map((l) => (
                  <tr key={l.subEventId}>
                    <td className="px-3 py-2">{l.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.ratePaise == null ? <span className="text-destructive">no rate</span> : formatPaise(l.ratePaise)}
                    </td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className="px-3 py-2">Proposal total (venue)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(quote.totalPaise)}</td>
                </tr>
                <tr className="text-muted-foreground">
                  <td className="px-3 py-2">Advance required (25%)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(quote.advanceRequiredPaise)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Advance received (₹)">
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Mode">
              <Select items={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }, { value: 'cheque', label: 'Cheque' }]} value={mode} onValueChange={(v) => setMode(v ?? 'upi')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['cash', 'upi', 'bank', 'cheque'].map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Receipt no.">
              <Input value={receipt} onChange={(e) => setReceipt(e.target.value)} />
            </Field>
            <Field label="Received on">
              <Input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Confirming records the advance and blocks every venue slot atomically. If a slot was
            taken since you last checked, confirmation fails and nothing is booked.
          </p>
        </>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button>
        <Button onClick={confirm} disabled={busy || !quote || quote.missing.length > 0}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
          Confirm booking
        </Button>
      </div>
    </StepCard>
  )
}
