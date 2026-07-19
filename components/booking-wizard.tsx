'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AadhaarCapture } from '@/components/aadhaar-capture'
import { cn } from '@/lib/utils'

type EventType = { code: string; displayName: string; contactNumbers: number; isWedding: boolean }
type Venue = { id: string; name: string; kind: string; propertyName: string; capacityMin: number; capacityMax: number }
type Bundle = { id: string; name: string; members: string }
type Options = {
  eventTypes: EventType[]
  venues: Venue[]
  bundles: Bundle[]
  roomTypes: string[]
  roomRates: { roomType: string; rackRatePaise: number }[]
}
type Tier = { id: string; name: string; baseRatePaise: number }

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

// Dates & event first, then who the guest is (KYC), then the functions with their menus.
const STEPS = ['Date & event', 'KYC', 'Functions & menu', 'Rooms', 'Review & confirm']

export function BookingWizard() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [options, setOptions] = useState<Options | null>(null)
  const [tiers, setTiers] = useState<Tier[]>([])
  const [eventId, setEventId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Step 1 — dates & event
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [eventType, setEventType] = useState('')
  const [guestName, setGuestName] = useState('')

  // Step 2 — KYC
  const [contacts, setContacts] = useState<string[]>([''])
  const [docs, setDocs] = useState<{ aadhaar_front?: boolean; aadhaar_back?: boolean }>({})

  // Step 3 — functions & menu
  const [subEvents, setSubEvents] = useState<SubEvent[]>([])
  const [menuBySub, setMenuBySub] = useState<Record<string, { tierName: string; perPlatePaise: number }>>({})

  // Step 4 — rooms
  const [rooms, setRooms] = useState<RoomReq[]>([])

  // Step 5 — review
  const [quote, setQuote] = useState<Quote | null>(null)

  useEffect(() => {
    api<Options>('/booking-options')
      .then(setOptions)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load options'))
    api<{ tiers: Tier[] }>('/menu/catalog')
      .then((r) => setTiers(r.tiers))
      .catch(() => setTiers([]))
  }, [])

  const selectedType = options?.eventTypes.find((t) => t.code === eventType)
  const requiredContacts = selectedType?.contactNumbers ?? 1

  // Keep the contact fields in step with the event type's required count.
  useEffect(() => {
    if (!selectedType) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContacts((prev) => {
      const next = [...prev]
      while (next.length < selectedType.contactNumbers) next.push('')
      return next.slice(0, Math.max(selectedType.contactNumbers, next.filter(Boolean).length || 1))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType])

  async function refreshFunctions(id: string) {
    const { event } = await api<{ event: { subEvents: SubEvent[] } }>(`/events/${id}`)
    setSubEvents(event.subEvents)
    void loadQuote(id)
  }

  async function loadQuote(id: string) {
    try {
      setQuote(await api<Quote>(`/events/${id}/quote`))
    } catch {
      /* the quote only matters from the review step on */
    }
  }

  // ---- Step 2: create (or update) the proposal from the dates/event + contacts ----
  async function saveGuest() {
    const trimmed = contacts.map((c) => c.trim()).filter(Boolean)
    if (trimmed.length < requiredContacts) {
      return toast.error(`${requiredContacts} contact number${requiredContacts > 1 ? 's are' : ' is'} required for a ${selectedType?.displayName}`)
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
        toast.success('Proposal created — now add the Aadhaar images.')
      } else {
        await api(`/events/${eventId}`, { method: 'PUT', body: JSON.stringify({ guest_name: guestName, contacts: contactsPayload }) })
        toast.success('Contacts saved.')
      }
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
      toast.success(`${kind === 'aadhaar_front' ? 'Front' : 'Back'} saved`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  // ---- Step 3: add / remove a function, with its menu tier ----
  async function addFunction(spec: {
    name: string; eventDate: string; startTime: string; endTime: string; target: string; pax: number; note: string; tierId: string
  }) {
    if (!eventId) return
    const [kind, vid] = spec.target.split(':')
    const { subEvent } = await api<{ subEvent: { id: string } }>(`/events/${eventId}/sub-events`, {
      method: 'POST',
      body: JSON.stringify({
        name: spec.name,
        event_date: spec.eventDate,
        start_time: spec.startTime,
        end_time: spec.endTime,
        [kind === 'bundle' ? 'bundle_id' : 'venue_id']: vid,
        pax: spec.pax,
        pax_override_note: spec.note || undefined,
      }),
    })
    // Tier now, dishes later: saving with no selections keeps the menu incomplete (FR-3.2).
    if (spec.tierId) {
      try {
        await api(`/sub-events/${subEvent.id}/menu`, {
          method: 'PUT',
          body: JSON.stringify({ tier_id: spec.tierId, is_tentative: true, selections: {} }),
        })
        const tier = tiers.find((t) => t.id === spec.tierId)
        if (tier) setMenuBySub((m) => ({ ...m, [subEvent.id]: { tierName: tier.name, perPlatePaise: tier.baseRatePaise } }))
      } catch (e) {
        toast.error(e instanceof Error ? `Function added, but the menu didn't save: ${e.message}` : 'Menu did not save')
      }
    }
    await refreshFunctions(eventId)
  }

  async function removeFunction(id: string) {
    if (!eventId) return
    await api(`/sub-events/${id}`, { method: 'DELETE' }).catch((e) => toast.error(e.message))
    setMenuBySub((m) => {
      const next = { ...m }
      delete next[id]
      return next
    })
    await refreshFunctions(eventId)
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
      if (next === 4) await loadQuote(eventId)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save rooms')
    } finally {
      setBusy(false)
    }
  }

  if (!options) return <p className="text-sm text-muted-foreground">Loading…</p>

  // The proposal only distinguishes Wedding from everything else ("Others" → the `other`
  // type): Wedding drives the 3-contact rule and the silent food surcharge. The event's
  // name never affects price.
  const proposalTypes = (['wedding', 'other'] as const)
    .map((code) => options.eventTypes.find((t) => t.code === code))
    .filter((t): t is EventType => Boolean(t))
    .map((t) => ({ value: t.code, label: t.code === 'other' ? 'Others' : t.displayName }))

  const datesOk = Boolean(fromDate && toDate && toDate >= fromDate)
  const foodTotalPaise = subEvents.reduce((sum, s) => sum + (menuBySub[s.id]?.perPlatePaise ?? 0) * s.pax, 0)

  // Lodging estimate: rooms × nights × the type's rack rate. The exact charge is settled when
  // the Lodge Manager allocates real rooms, but the proposal has to show a number.
  const roomsTotalPaise = rooms.reduce((sum, r) => {
    const rate = options.roomRates?.find((x) => x.roomType === r.room_type)?.rackRatePaise ?? 0
    const nights = nightsBetween(r.check_in, r.check_out)
    return sum + rate * Math.max(0, r.count) * nights
  }, 0)
  const grandTotalPaise = (quote?.totalPaise ?? 0) + foodTotalPaise + roomsTotalPaise

  return (
    <div className="space-y-6">
      <Stepper step={step} />

      {step === 0 && (
        <StepCard title="Date & event">
          <p className="text-sm text-muted-foreground">
            When does the event run, and is it a wedding? Every function you add later must fall
            inside these dates.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From date">
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </Field>
            <Field label="To date">
              <Input type="date" min={fromDate || undefined} value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </Field>
          </div>
          {fromDate && toDate && toDate < fromDate && (
            <p className="text-sm text-destructive">The To date can&apos;t be before the From date.</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Event">
              <Select items={proposalTypes} value={eventType} onValueChange={(v) => setEventType(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Wedding or Others" /></SelectTrigger>
                <SelectContent>
                  {proposalTypes.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Guest name">
              <Input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Any name — it doesn't affect pricing" />
            </Field>
          </div>
          <Nav onNext={() => setStep(1)} busy={busy} nextDisabled={!datesOk || !eventType || !guestName.trim()} />
        </StepCard>
      )}

      {step === 1 && (
        <StepCard title="KYC">
          <div className="space-y-2">
            <Label>Contact numbers{selectedType ? ` (${requiredContacts} required)` : ''}</Label>
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
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setContacts((prev) => [...prev, ''])}>Add contact</Button>
              <Button size="sm" onClick={saveGuest} disabled={busy}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                {eventId ? 'Save contacts' : 'Save & start proposal'}
              </Button>
            </div>
          </div>

          <div>
            <Label className="mb-2 block">Aadhaar — front &amp; back</Label>
            <p className="mb-3 text-sm text-muted-foreground">
              Capture the card live with the camera, or upload an image. Required to confirm
              (FR-1.10); stored encrypted.
              {!eventId && ' Save the contacts first to enable this.'}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <AadhaarCapture label="Aadhaar front" done={Boolean(docs.aadhaar_front)} disabled={!eventId} onFile={(f) => uploadDoc('aadhaar_front', f)} />
              <AadhaarCapture label="Aadhaar back" done={Boolean(docs.aadhaar_back)} disabled={!eventId} onFile={(f) => uploadDoc('aadhaar_back', f)} />
            </div>
          </div>

          <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} busy={busy} nextDisabled={!eventId || !docs.aadhaar_front || !docs.aadhaar_back} />
        </StepCard>
      )}

      {step === 2 && eventId && (
        <StepCard title="Functions & menu">
          <FunctionsEditor
            venues={options.venues}
            tiers={tiers}
            fromDate={fromDate}
            toDate={toDate}
            rows={subEvents.map((s) => ({
              id: s.id,
              name: s.name,
              eventDate: s.eventDate,
              startTime: s.startTime.slice(0, 5),
              endTime: s.endTime.slice(0, 5),
              venueLabel: s.bundleId
                ? options.bundles.find((b) => b.id === s.bundleId)?.name ?? 'Bundle'
                : options.venues.find((v) => v.id === s.venueId)?.name ?? 'Venue',
              pax: s.pax,
              menu: menuBySub[s.id],
            }))}
            onAdd={addFunction}
            onRemove={removeFunction}
          />
          {subEvents.length > 0 && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Venue total</span><span className="tabular-nums">{quote ? formatPaise(quote.totalPaise) : '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Food (pax × per plate)</span><span className="tabular-nums">{formatPaise(foodTotalPaise)}</span></div>
              {roomsTotalPaise > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Rooms (estimate)</span><span className="tabular-nums">{formatPaise(roomsTotalPaise)}</span></div>
              )}
              <div className="mt-1 flex justify-between border-t pt-1 font-medium"><span>Running total</span><span className="tabular-nums">{formatPaise(grandTotalPaise)}</span></div>
            </div>
          )}
          <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} busy={busy} nextDisabled={subEvents.length === 0} />
        </StepCard>
      )}

      {step === 3 && (
        <StepCard title="Room requirements">
          <RoomEditor rooms={rooms} setRooms={setRooms} roomTypes={options.roomTypes} />
          {rooms.length > 0 && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Rooms (rack-rate estimate)</span>
                <span className="tabular-nums">{formatPaise(roomsTotalPaise)}</span>
              </div>
            </div>
          )}
          <Nav onBack={() => setStep(2)} onNext={() => saveRooms(4)} busy={busy} nextLabel="Save & review" />
        </StepCard>
      )}

      {step === 4 && eventId && (
        <ReviewStep
          eventId={eventId}
          quote={quote}
          foodTotalPaise={foodTotalPaise}
          roomsTotalPaise={roomsTotalPaise}
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
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
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

type FunctionRow = {
  id: string
  name: string
  eventDate: string
  startTime: string
  endTime: string
  venueLabel: string
  pax: number
  menu?: { tierName: string; perPlatePaise: number }
}

function FunctionsEditor({
  venues,
  tiers,
  fromDate,
  toDate,
  rows,
  onAdd,
  onRemove,
}: {
  venues: Venue[]
  tiers: Tier[]
  fromDate: string
  toDate: string
  rows: FunctionRow[]
  onAdd: (spec: { name: string; eventDate: string; startTime: string; endTime: string; target: string; pax: number; note: string; tierId: string }) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [target, setTarget] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [pax, setPax] = useState('')
  const [note, setNote] = useState('')
  const [tierId, setTierId] = useState('')
  const [busy, setBusy] = useState(false)
  const [freeVenues, setFreeVenues] = useState<{ value: string; label: string }[] | null>(null)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [checking, setChecking] = useState(false)

  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
  const inRange = Boolean(date && (!fromDate || date >= fromDate) && (!toDate || date <= toDate))
  const windowSet = Boolean(date && inRange && HHMM.test(start) && HHMM.test(end) && start !== end)

  // Date + time decide which venues are on offer — anything booked over an overlapping
  // window is hidden so it can't be picked (BR-C1).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!windowSet) { setFreeVenues(null); setHiddenCount(0); return }
    let active = true
    setChecking(true)
    api<{ venues: { id: string; name: string; propertyName: string; available: boolean }[]; bundles: { id: string; name: string; members: string; available: boolean }[] }>(
      `/availability/venues?date=${date}&start=${start}&end=${end}`,
    )
      .then((r) => {
        if (!active) return
        const items = [
          ...r.venues.filter((v) => v.available).map((v) => ({ value: `venue:${v.id}`, label: `${v.name} (${v.propertyName})` })),
          ...r.bundles.filter((b) => b.available).map((b) => ({ value: `bundle:${b.id}`, label: `${b.name} [bundle]` })),
        ]
        setFreeVenues(items)
        setHiddenCount(r.venues.filter((v) => !v.available).length + r.bundles.filter((b) => !b.available).length)
        setTarget((t) => (items.some((i) => i.value === t) ? t : ''))
      })
      .catch(() => { if (active) { setFreeVenues([]); setHiddenCount(0) } })
      .finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [date, start, end, windowSet])
  /* eslint-enable react-hooks/set-state-in-effect */

  async function add() {
    if (!name || !windowSet || !target || !pax) return toast.error('Set the date, time, a free venue, a name and pax')
    if (!tierId) return toast.error('Choose a menu for this function')
    const [kind, id] = target.split(':')
    if (kind === 'venue') {
      const v = venues.find((x) => x.id === id)
      if (v && (Number(pax) < v.capacityMin || Number(pax) > v.capacityMax) && !note.trim()) {
        return toast.error(`Pax ${pax} is outside ${v.name}'s range (${v.capacityMin}–${v.capacityMax}). Add an override note to proceed.`)
      }
    }
    setBusy(true)
    try {
      await onAdd({ name, eventDate: date, startTime: start, endTime: end, target, pax: Number(pax), note, tierId })
      setName(''); setDate(''); setTarget(''); setStart(''); setEnd(''); setPax(''); setNote(''); setTierId(''); setFreeVenues(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add function')
    } finally {
      setBusy(false)
    }
  }

  const venueItems = freeVenues ?? []
  const tierItems = tiers.map((t) => ({ value: t.id, label: `${t.name} — ${formatPaise(t.baseRatePaise)}/plate` }))

  return (
    <div className="space-y-4">
      {rows.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium">{r.name}</span>{' '}
                <span className="tabular-nums text-muted-foreground">
                  {r.eventDate} · {r.startTime}–{r.endTime} · {r.venueLabel} · {r.pax} pax
                </span>
                <div className="text-xs text-muted-foreground">
                  {r.menu
                    ? `${r.menu.tierName} · ${formatPaise(r.menu.perPlatePaise)}/plate · food ${formatPaise(r.menu.perPlatePaise * r.pax)}`
                    : 'No menu chosen'}
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => onRemove(r.id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" min={fromDate || undefined} max={toDate || undefined} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Start">
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End">
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        {date && !inRange && (
          <p className="mt-2 text-xs text-destructive">That date is outside {fromDate} → {toDate}.</p>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Venue">
            <Select items={venueItems} value={target} onValueChange={(v) => setTarget(v ?? '')}>
              <SelectTrigger disabled={!windowSet || checking || venueItems.length === 0}>
                <SelectValue placeholder={!windowSet ? 'Set date & time first' : checking ? 'Checking…' : venueItems.length ? 'Choose a free venue' : 'No venues free for this slot'} />
              </SelectTrigger>
              <SelectContent>
                {venueItems.map((it) => (
                  <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Function name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sangeet" />
          </Field>
          <Field label="Pax">
            <Input type="number" value={pax} onChange={(e) => setPax(e.target.value)} />
          </Field>
        </div>

        <div className="mt-3">
          <Field label="Menu (per plate)">
            <Select items={tierItems} value={tierId} onValueChange={(v) => setTierId(v ?? '')}>
              <SelectTrigger><SelectValue placeholder="Choose a menu — dishes are picked later" /></SelectTrigger>
              <SelectContent>
                {tierItems.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {windowSet && !checking && (
          <p className="mt-2 text-xs text-muted-foreground">
            {venueItems.length === 0
              ? 'Every venue is booked for this date & time. Pick another slot.'
              : `${venueItems.length} venue${venueItems.length === 1 ? '' : 's'} free for this slot${hiddenCount > 0 ? ` · ${hiddenCount} already booked and hidden` : ''}.`}
          </p>
        )}

        <div className="mt-3">
          <Input placeholder="Pax override note (only if outside venue capacity)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button className="mt-3" onClick={add} disabled={busy || !windowSet || !target || !tierId}>Add function</Button>
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

/** Whole nights between two YYYY-MM-DD dates (0 if either is missing or the range is invalid). */
function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0
  const [ay, am, ad] = checkIn.split('-').map(Number)
  const [by, bm, bd] = checkOut.split('-').map(Number)
  const days = Math.round((new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86_400_000)
  return days > 0 ? days : 0
}

function ReviewStep({
  eventId,
  quote,
  foodTotalPaise,
  roomsTotalPaise,
  onBack,
  onConfirmed,
}: {
  eventId: string
  quote: Quote | null
  foodTotalPaise: number
  roomsTotalPaise: number
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
          advance: { amount_paise: rupeesToPaise(Number(amount)), mode, receipt_no: receipt, received_on: receivedOn },
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
                <tr>
                  <td className="px-3 py-2 text-muted-foreground">Venue total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(quote.totalPaise)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-2 text-muted-foreground">Food (pax × per plate)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(foodTotalPaise)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-2 text-muted-foreground">Rooms (rack-rate estimate)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(roomsTotalPaise)}</td>
                </tr>
                <tr className="font-medium">
                  <td className="px-3 py-2">Proposal total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(quote.totalPaise + foodTotalPaise + roomsTotalPaise)}</td>
                </tr>
                <tr className="text-muted-foreground">
                  <td className="px-3 py-2">Advance required (25% of venue)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(quote.advanceRequiredPaise)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Rooms are a rack-rate estimate until the Lodge Manager allocates them; maintenance is
            added to the final bill once logged.
          </p>

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
        </>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button>
        <Button onClick={confirm} disabled={busy || !quote || quote.missing.length > 0}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
          Confirm proposal
        </Button>
      </div>
    </StepCard>
  )
}
