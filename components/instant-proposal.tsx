'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CalendarSearch, Check, Pencil, Printer, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { BOOKABLE_EVENT_TYPES, eventTypeLabel } from '@/lib/event-types'
import { formatPaise } from '@/lib/money'
import { formatTimeRange } from '@/lib/time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TimePicker12 } from '@/components/ui/time-picker-12'
import { Field, Nav, StepCard, Stepper } from '@/components/booking-wizard'
import { VenueDayCheck } from '@/components/venue-tape-chart'
import type { DemoQuote } from '@/lib/demo-quote'
import type { CatalogTier } from '@/components/menu-picker'
import { cn } from '@/lib/utils'
import styles from './instant-summary.module.css'

/**
 * The instant proposal (client, 7 Oct 2026) — the demo proposal of 1 Oct, saved. The New-proposal
 * steps with nothing mandatory but the name: dates, event type, venues, times, menus and pax may
 * all be blank and changed at any time, because an instant holds nothing — no venue, no room,
 * no money. It saves itself as it is typed and is listed on the "Instants" tab of Past proposals.
 * "Convert to a real proposal" opens New proposal filled in from it; the manager completes what
 * is missing there, under every rule a proposal obeys. Prices are the real ones, from /demo-quote.
 */

type Options = {
  eventTypes: { code: string; displayName: string; contactNumbers: number }[]
  venues: { id: string; name: string; propertyName: string; priceable: boolean }[]
  bundles: { id: string; name: string }[]
  roomRates: { unitId: string; roomType: string; rackRatePaise: number }[]
  lodgingUnits?: { id: string; name: string }[]
}
type Tier = CatalogTier
/** Blank strings and `pax: 0` mean "not decided yet". `dishes` maps a category to its picks. */
type Fn = {
  name: string
  eventDate: string
  startTime: string
  endTime: string
  target: string
  pax: number
  tierId: string
  dishes: Record<string, string[]>
}
/** `checkIn` blank or missing means the From date — the night conversion has always assumed. */
type Room = { unitId: string; roomType: string; count: number; nights: number; checkIn?: string }
type Draft = { fromDate: string; toDate: string; eventType: string; phone: string; functions: Fn[]; rooms: Room[] }
type Saved = {
  id: string
  name: string
  draft: Draft
  convertedEventId: string | null
  convertedCode: string | null
}
type VenueItem = { value: string; label: string }

const STEPS = ['Date & event', 'Guest', 'Functions & menu', 'Rooms', 'Summary']
const BLANK_FN: Fn = { name: '', eventDate: '', startTime: '', endTime: '', target: '', pax: 0, tierId: '', dishes: {} }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const byWhen = (a: Fn, b: Fn) =>
  ((a.eventDate || '9999') + a.startTime).localeCompare((b.eventDate || '9999') + b.startTime)

export function InstantProposal({ id: initialId, canSeeAvailability }: { id?: string; canSeeAvailability: boolean }) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [options, setOptions] = useState<Options | null>(null)
  const [tiers, setTiers] = useState<Tier[]>([])
  const [loaded, setLoaded] = useState(!initialId)
  const [converted, setConverted] = useState<{ eventId: string; code: string | null } | null>(null)

  const [name, setName] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [eventType, setEventType] = useState('')
  const [phone, setPhone] = useState('')
  const [fns, setFns] = useState<Fn[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [showTape, setShowTape] = useState(false)

  const [quote, setQuote] = useState<DemoQuote | null>(null)
  const [pricing, setPricing] = useState(false)

  useEffect(() => {
    api<Options>('/booking-options')
      .then(setOptions)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load options'))
    api<{ tiers: Tier[] }>('/menu/catalog')
      .then((r) => setTiers(r.tiers))
      .catch(() => setTiers([]))
  }, [])

  // ---- Load + autosave ----------------------------------------------------------------------
  const idRef = useRef<string | null>(initialId ?? null)
  const lastSaved = useRef('')
  const queue = useRef<Promise<void>>(Promise.resolve())
  const [saveState, setSaveState] = useState<'new' | 'saved' | 'dirty' | 'saving' | 'error'>(initialId ? 'saved' : 'new')

  const draft: Draft = { fromDate, toDate, eventType, phone, functions: fns, rooms }
  const snapshot = JSON.stringify({ name: name.trim(), draft })
  /** What the page holds now, for the save queue to read when its turn comes. */
  const latest = useRef(snapshot)
  useEffect(() => {
    latest.current = snapshot
  }, [snapshot])

  useEffect(() => {
    if (!initialId) return
    api<{ instant: Saved }>(`/instant-proposals/${initialId}`)
      .then(({ instant }) => {
        const d = instant.draft
        setName(instant.name)
        setFromDate(d.fromDate)
        setToDate(d.toDate)
        setEventType(d.eventType)
        setPhone(d.phone)
        setFns(d.functions)
        setRooms(d.rooms)
        if (instant.convertedEventId) setConverted({ eventId: instant.convertedEventId, code: instant.convertedCode })
        lastSaved.current = JSON.stringify({ name: instant.name.trim(), draft: d })
        setLoaded(true)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not open the instant proposal'))
  }, [initialId])

  /** Saves whatever the page holds now. Queued, so a create is never sent twice. */
  const save = useCallback(() => {
    queue.current = queue.current.then(async () => {
      const body = latest.current
      if (body === lastSaved.current || !JSON.parse(body).name) return
      setSaveState('saving')
      try {
        if (idRef.current) {
          await api(`/instant-proposals/${idRef.current}`, { method: 'PUT', body })
        } else {
          const r = await api<{ id: string }>('/instant-proposals', { method: 'POST', body })
          idRef.current = r.id
          // The address becomes the saved instant's without remounting the page being typed in.
          window.history.replaceState(null, '', `/bookings/instant/${r.id}`)
        }
        lastSaved.current = body
        setSaveState(latest.current === body ? 'saved' : 'dirty')
      } catch (e) {
        setSaveState('error')
        toast.error(e instanceof Error ? e.message : 'Could not save')
      }
    })
    return queue.current
  }, [])

  useEffect(() => {
    if (!loaded || converted || snapshot === lastSaved.current || !name.trim()) return
    setSaveState('dirty')
    const t = setTimeout(save, 1200)
    return () => clearTimeout(t)
  }, [snapshot, loaded, converted, name, save])

  // ---- Pricing for the summary ---------------------------------------------------------------
  const priceIt = useCallback(async () => {
    setPricing(true)
    try {
      const r = await api<{ quote: DemoQuote }>('/demo-quote', {
        method: 'POST',
        body: JSON.stringify({
          event_type: eventType || null,
          functions: fns.map((f) => ({
            name: f.name,
            event_date: f.eventDate || null,
            start_time: f.startTime || null,
            end_time: f.endTime || null,
            venue_id: f.target.startsWith('venue:') ? f.target.slice(6) : null,
            bundle_id: f.target.startsWith('bundle:') ? f.target.slice(7) : null,
            pax: f.pax || null,
            tier_id: f.tierId || null,
          })),
          rooms: rooms.map((r) => ({ unit_id: r.unitId, room_type: r.roomType, count: r.count, nights: r.nights })),
        }),
      })
      setQuote(r.quote)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not price the proposal')
    } finally {
      setPricing(false)
    }
  }, [eventType, fns, rooms])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (step === 4 || converted) void priceIt()
  }, [step, converted, priceIt])

  if (!options || !loaded) return <p className="text-sm text-muted-foreground">Loading…</p>

  const types = BOOKABLE_EVENT_TYPES.map((code) => options.eventTypes.find((t) => t.code === code))
    .filter((t): t is Options['eventTypes'][number] => Boolean(t))
    .map((t) => ({ value: t.code, label: eventTypeLabel(t.code, t.displayName) }))
  const venueItems: VenueItem[] = [
    ...options.venues.filter((v) => v.priceable).map((v) => ({ value: `venue:${v.id}`, label: `${v.name} (${v.propertyName})` })),
    ...options.bundles.map((b) => ({ value: `bundle:${b.id}`, label: `${b.name} [bundle]` })),
  ]
  const eventLabel = types.find((t) => t.value === eventType)?.label ?? ''
  const hasName = Boolean(name.trim())

  const summary = quote && (
    <>
      <SummaryNotes quote={quote} fns={fns} eventType={eventType} rooms={rooms} fromDate={fromDate} />
      {/* On a phone the A4 sheet scrolls sideways inside its own box, never the page. */}
      <div className="overflow-x-auto print:overflow-visible">
        <InstantSummary
          quote={quote}
          rooms={rooms}
          guestName={name}
          eventLabel={eventLabel}
          fromDate={fromDate}
          toDate={toDate}
        />
      </div>
    </>
  )

  // A converted instant is the real proposal's history now: shown, printed, never edited.
  if (converted) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3 text-sm print:hidden">
          <span>
            Converted into a real proposal{converted.code ? ` — ${converted.code}` : ''}. Changes are made there now.
          </span>
          <div className="flex gap-2">
            <Link href={`/bookings/${converted.eventId}`} className="font-medium text-primary hover:underline">
              Open the proposal →
            </Link>
          </div>
        </div>
        {quote && (
          <div className="flex justify-end print:hidden">
            <Button variant="outline" onClick={() => window.print()}>
              <Printer className="mr-2 size-4" /> Print / Save as PDF
            </Button>
          </div>
        )}
        {summary ?? <p className="text-sm text-muted-foreground">Pricing…</p>}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3 print:hidden">
        <Stepper steps={STEPS} step={step} onStep={setStep} canStep={() => hasName} />
        <p className="text-right text-xs text-muted-foreground" aria-live="polite">
          {!hasName
            ? 'Give it a name to save it'
            : saveState === 'saving'
              ? 'Saving…'
              : saveState === 'dirty'
                ? 'Unsaved changes'
                : saveState === 'error'
                  ? 'Not saved — check your connection'
                  : saveState === 'saved'
                    ? 'Saved'
                    : ''}
        </p>
      </div>

      {step === 0 && (
        <StepCard title="Date & event">
          <p className="text-sm text-muted-foreground">
            Only the name is needed. Everything else can be filled in — or changed — whenever you like.
          </p>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Guest or family name" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="From date">
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </Field>
            <Field label="To date">
              <Input type="date" min={fromDate || undefined} value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </Field>
            <Field label="Event">
              <Select items={types} value={eventType} onValueChange={(v) => setEventType(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Not decided" /></SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {canSeeAvailability && (
            <div className="space-y-3">
              <Button variant="outline" onClick={() => setShowTape((s) => !s)} aria-expanded={showTape}>
                <CalendarSearch className="mr-2 size-4" />
                {showTape ? 'Hide availability' : 'Check availability'}
              </Button>
              {showTape && (
                <div className="rounded-lg border p-3">
                  <p className="mb-3 text-sm text-muted-foreground">
                    When each hall, lawn and bundle is free that day — to settle on a venue, or another date.
                  </p>
                  <VenueDayCheck initialDate={fromDate || undefined} />
                </div>
              )}
            </div>
          )}
          <Nav onNext={() => setStep(1)} nextDisabled={!hasName} />
        </StepCard>
      )}

      {step === 1 && (
        <StepCard title="Guest">
          <Field label="Contact number (optional)">
            <Input
              value={phone}
              inputMode="numeric"
              maxLength={10}
              placeholder="10-digit mobile"
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            />
          </Field>
          <p className="text-sm text-muted-foreground">
            The guest&apos;s Aadhaar is captured once this becomes a real proposal. An instant needs none.
          </p>
          <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} />
        </StepCard>
      )}

      {step === 2 && (
        <StepCard title="Functions & menu">
          <InstantFunctions venueItems={venueItems} tiers={tiers} fromDate={fromDate} fns={fns} setFns={setFns} />
          <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} />
        </StepCard>
      )}

      {step === 3 && (
        <StepCard title="Rooms">
          <InstantRooms options={options} rooms={rooms} setRooms={setRooms} fromDate={fromDate} />
          <Nav onBack={() => setStep(2)} onNext={() => setStep(4)} nextLabel="Show summary" />
        </StepCard>
      )}

      {step === 4 && (
        <>
          <div className="flex flex-wrap justify-between gap-2 print:hidden">
            <Button variant="outline" onClick={() => setStep(3)}>Back</Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => window.print()} disabled={!quote || pricing}>
                <Printer className="mr-2 size-4" /> Print / Save as PDF
              </Button>
              <Button
                onClick={async () => {
                  await save()
                  if (idRef.current) router.push(`/bookings/new?instant=${idRef.current}`)
                }}
              >
                Convert to a real proposal
              </Button>
            </div>
          </div>
          {pricing && !quote ? <p className="text-sm text-muted-foreground">Pricing…</p> : summary}
        </>
      )}

    </div>
  )
}

function SummaryNotes({
  quote,
  fns,
  eventType,
  rooms,
  fromDate,
}: {
  quote: DemoQuote
  fns: Fn[]
  eventType: string
  rooms: Room[]
  fromDate: string
}) {
  // Room lines that ask for more than the lodge has free, re-checked here so an impossible
  // count cannot reach a printout unnoticed (the Rooms step flags the same lines).
  const query = rooms.flatMap((r) => {
    const from = r.checkIn || fromDate
    return from ? [{ unit_id: r.unitId, room_type: r.roomType, count: r.count, check_in: from, check_out: addDaysISO(from, r.nights) }] : []
  })
  const queryKey = JSON.stringify(query)
  const [short, setShort] = useState<{ key: string; lines: string[] } | null>(null)
  useEffect(() => {
    if (query.length === 0) return
    api<{ lines: { available: number; total: number }[] }>('/rooms/availability', { method: 'POST', body: JSON.stringify({ lines: query }) })
      .then((res) =>
        setShort({
          key: queryKey,
          lines: query.flatMap((q, i) =>
            res.lines[i] && q.count > res.lines[i]!.available
              ? [`${q.count} × ${roomLabel(q.room_type)} (only ${res.lines[i]!.available} free)`]
              : [],
          ),
        }),
      )
      .catch(() => setShort(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])
  const notes: string[] = []
  if (short?.key === queryKey && short.lines.length) {
    notes.push(`More rooms than are free: ${short.lines.join(', ')}. Reduce them on the Rooms step before sending this.`)
  }
  // What the quote ASSUMED, said out loud (lib/demo-quote.ts) — a price on an assumption is fine
  // on an estimate only while the counter can see which assumption it rests on.
  if (!eventType) notes.push('No event type picked yet — priced as a wedding (hall rates and the wedding plate rate).')
  const untimed = fns.filter((f) => f.target && f.eventDate && !f.startTime).map((f) => f.name || 'Untitled function')
  if (untimed.length) {
    notes.push(`No start time yet for ${untimed.join(', ')} — the hall is priced as that date’s hire. A function before 8 AM belongs to the day before.`)
  }
  const undated = fns.filter((f) => f.target && !f.eventDate).map((f) => f.name || 'Untitled function')
  if (undated.length) notes.push(`Set the date to price the hall for: ${undated.join(', ')}.`)
  if (quote.missingVenueRates.length > 0) {
    notes.push(`No hall rate for this event type at: ${quote.missingVenueRates.join(', ')}. The hall is left out of those functions.`)
  }
  const unpricedFood = fns.filter((f) => !f.tierId || !f.pax).map((f) => f.name || 'Untitled function')
  if (unpricedFood.length) notes.push(`No menu or pax yet, so no food is priced for: ${unpricedFood.join(', ')}.`)
  if (!notes.length) return null
  return (
    <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-400 print:hidden">
      {notes.map((n) => <li key={n}>{n}</li>)}
    </ul>
  )
}

/**
 * Date, time, venue, name, pax and menu for one function — every one optional.
 * Once a date and a time window are set it says whether the venue is free then (BR-C1's inline
 * feedback); a taken venue can still be picked, since an instant holds nothing.
 */
function FunctionFields({
  value,
  onChange,
  venueItems,
  tiers,
}: {
  value: Fn
  onChange: (f: Fn) => void
  venueItems: VenueItem[]
  tiers: Tier[]
}) {
  const [taken, setTaken] = useState<Set<string> | null>(null)
  const { eventDate: date, startTime: start, endTime: end } = value
  const windowSet = Boolean(date && HHMM.test(start) && HHMM.test(end) && start !== end)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!windowSet) { setTaken(null); return }
    let live = true
    api<{ venues: { id: string; available: boolean }[]; bundles: { id: string; available: boolean }[] }>(
      `/availability/venues?date=${date}&start=${start}&end=${end}`,
    )
      .then((r) => {
        if (!live) return
        setTaken(new Set([
          ...r.venues.filter((v) => !v.available).map((v) => `venue:${v.id}`),
          ...r.bundles.filter((b) => !b.available).map((b) => `bundle:${b.id}`),
        ]))
      })
      .catch(() => { if (live) setTaken(null) })
    return () => { live = false }
  }, [date, start, end, windowSet])
  /* eslint-enable react-hooks/set-state-in-effect */

  const items = venueItems.map((v) => ({ ...v, label: taken?.has(v.value) ? `${v.label} — taken then` : v.label }))
  const tierItems = tiers.map((t) => ({ value: t.id, label: t.name }))
  const set = <K extends keyof Fn>(k: K, v: Fn[K]) => onChange({ ...value, [k]: v })

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => set('eventDate', e.target.value)} />
        </Field>
        <Field label="Start">
          <div><TimePicker12 value={start} onChange={(v) => set('startTime', v)} /></div>
        </Field>
        <Field label="End">
          <div><TimePicker12 value={end} onChange={(v) => set('endTime', v)} /></div>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Venue">
          <Select items={items} value={value.target} onValueChange={(v) => set('target', v ?? '')}>
            <SelectTrigger><SelectValue placeholder="Not decided" /></SelectTrigger>
            <SelectContent>
              {items.map((it) => (
                <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Function name">
          <Input value={value.name} onChange={(e) => set('name', e.target.value)} placeholder="Sangeet" />
        </Field>
        <Field label="Pax">
          <Input
            type="number"
            min={1}
           
            value={value.pax || ''}
            onChange={(e) => set('pax', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          />
        </Field>
      </div>
      {windowSet && value.target && taken && (
        <p className={cn('flex items-center gap-1.5 text-sm', taken.has(value.target) ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400')}>
          {taken.has(value.target) ? <X className="size-4" /> : <Check className="size-4" />}
          {taken.has(value.target)
            ? 'This venue is taken at that time — try another venue, time or date.'
            : 'This venue is free at that time.'}
        </p>
      )}
      <Field label="Menu (per plate)">
        <Select items={tierItems} value={value.tierId} onValueChange={(v) => onChange({ ...value, tierId: v ?? '', dishes: {} })}>
          <SelectTrigger><SelectValue placeholder="Not decided" /></SelectTrigger>
          <SelectContent>
            {tierItems.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  )
}

const isBlank = (f: Fn) => JSON.stringify(f) === JSON.stringify(BLANK_FN)

function InstantFunctions({
  venueItems,
  tiers,
  fromDate,
  fns,
  setFns,
}: {
  venueItems: VenueItem[]
  tiers: Tier[]
  fromDate: string
  fns: Fn[]
  setFns: (f: Fn[]) => void
}) {
  /** The function in the form: a new one (editing = null) or a copy of fns[editing]. */
  const [form, setForm] = useState<Fn>({ ...BLANK_FN, eventDate: fromDate })
  const [editing, setEditing] = useState<number | null>(null)
  const [openMenu, setOpenMenu] = useState<number | null>(null)
  // The form sits below the list, so with a few functions it is off-screen: pressing Edit
  // filled it in where nobody could see, and the button read as dead (client, 16 Oct 2026).
  const formRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (editing == null) return
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    formRef.current?.querySelector<HTMLInputElement>('input:not([type=date])')?.focus({ preventScroll: true })
  }, [editing])

  function commit() {
    const next = editing == null ? [...fns, form] : fns.map((f, i) => (i === editing ? form : f))
    setFns(next.sort(byWhen))
    setForm({ ...BLANK_FN, eventDate: form.eventDate, startTime: form.endTime })
    setEditing(null)
    setOpenMenu(null)
  }

  return (
    <div className="space-y-4">
      {fns.length > 0 && (
        <ol className="space-y-2">
          {fns.map((f, i) => (
            <li key={i} className={cn('rounded-lg border bg-card p-3 text-sm', editing === i && 'ring-2 ring-primary/40')}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-medium">{f.name || 'Untitled function'}</span>{' '}
                  <span className="tabular-nums text-muted-foreground">
                    {[
                      f.eventDate || 'date open',
                      f.startTime && f.endTime ? formatTimeRange(f.startTime, f.endTime) : 'time open',
                      venueItems.find((v) => v.value === f.target)?.label ?? 'venue open',
                      f.pax ? `${f.pax} pax` : 'pax open',
                    ].join(' · ')}
                  </span>
                  <div className="text-xs text-muted-foreground">{tiers.find((t) => t.id === f.tierId)?.name ?? 'No menu yet'}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {f.tierId && (
                    <Button variant="outline" size="sm" onClick={() => setOpenMenu((o) => (o === i ? null : i))}>
                      {openMenu === i ? 'Hide dishes' : 'Choose dishes'}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit function"
                    onClick={() => {
                      setForm(f)
                      setEditing(i)
                    }}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove function"
                    onClick={() => {
                      setFns(fns.filter((_, j) => j !== i))
                      setOpenMenu(null)
                      if (editing === i) {
                        setEditing(null)
                        setForm({ ...BLANK_FN, eventDate: fromDate })
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              {openMenu === i && (
                <InstantDishes
                  tier={tiers.find((t) => t.id === f.tierId)}
                  dishes={f.dishes}
                  onChange={(dishes) => setFns(fns.map((x, j) => (j === i ? { ...x, dishes } : x)))}
                />
              )}
            </li>
          ))}
        </ol>
      )}

      <div ref={formRef} className={cn('rounded-lg border p-4', editing != null && 'ring-2 ring-primary/40')}>
        <h4 className="mb-3 text-sm font-medium">
          {editing != null
            ? `Edit ${fns[editing]?.name || 'function'}`
            : fns.length === 0
              ? 'Add the first function'
              : `Add function ${fns.length + 1}`}
        </h4>
        <p className="mb-3 text-xs text-muted-foreground">Fill in whatever is known — the rest can wait.</p>
        <FunctionFields value={form} onChange={setForm} venueItems={venueItems} tiers={tiers} />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={commit} disabled={isBlank(form)}>{editing != null ? 'Save changes' : 'Add function'}</Button>
          {editing != null && (
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null)
                setForm({ ...BLANK_FN, eventDate: fromDate })
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A plain dish picker held in page state. Each section takes up to its "any N"; a section with
 * no count is all included and read-only, as in the real picker. No Increase — an instant shows
 * the menu as sold, and asking the Authority for extras belongs to a real proposal.
 */
function InstantDishes({
  tier,
  dishes,
  onChange,
}: {
  tier: Tier | undefined
  dishes: Record<string, string[]>
  onChange: (d: Record<string, string[]>) => void
}) {
  if (!tier) return null
  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3">
      {tier.categories.map((c) => {
        const picked = dishes[c.name] ?? []
        // Free choice (breakfasts): ticked, any number, nought included.
        const allIncluded = c.pickCount == null && !c.freeChoice
        const full = c.pickCount != null && picked.length >= c.pickCount
        return (
          <div key={c.id}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {allIncluded
                  ? 'All included'
                  : c.pickCount == null
                    ? `${picked.length} ticked`
                    : `${picked.length} of ${c.pickCount} chosen`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {c.items.map((item) => {
                const on = allIncluded || picked.includes(item)
                return (
                  <button
                    key={item}
                    type="button"
                    disabled={allIncluded || (!on && full)}
                    aria-pressed={on}
                    onClick={() =>
                      onChange({ ...dishes, [c.name]: on ? picked.filter((x) => x !== item) : [...picked, item] })
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
                      allIncluded && 'cursor-default',
                      !on && full && 'opacity-40',
                    )}
                  >
                    {on && !allIncluded && '✓ '}
                    {item}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function InstantRooms({
  options,
  rooms,
  setRooms,
  fromDate,
}: {
  options: Options
  rooms: Room[]
  setRooms: (r: Room[]) => void
  fromDate: string
}) {
  const units = options.lodgingUnits ?? []
  const [unitId, setUnitId] = useState('')
  const [roomType, setRoomType] = useState('')
  const [count, setCount] = useState('')
  const [nights, setNights] = useState('1')
  // Blank means "from the From date", so a run changed later still carries the rooms with it.
  const [checkIn, setCheckIn] = useState('')

  // Rooms are taken from what the lodge actually has free (client, 16 Oct 2026: "not like that
  // to choose 100 rooms which has only 20"). The same check the real proposal runs — every line
  // counted against the others of its category on the same nights — asked for the lines already
  // here AND the one in the form, which goes last with a count of nought so it measures the room
  // that is left rather than competing with itself. An instant still holds nothing: the real
  // proposal re-checks on save, so a room taken by somebody else in between is caught there.
  const start = checkIn || fromDate
  const nightsN = Number(nights)
  const lines = rooms.map((r) => ({ r, from: r.checkIn || fromDate }))
  const query = [
    ...lines.filter((l) => l.from).map(({ r, from }) => ({ unit_id: r.unitId, room_type: r.roomType, count: r.count, check_in: from, check_out: addDaysISO(from, r.nights) })),
    ...(unitId && roomType && start && nightsN > 0
      ? [{ unit_id: unitId, room_type: roomType, count: 0, check_in: start, check_out: addDaysISO(start, nightsN) }]
      : []),
  ]
  const queryKey = JSON.stringify(query)
  const [free, setFree] = useState<{ key: string; lines: { available: number; total: number }[] } | null>(null)
  useEffect(() => {
    if (query.length === 0) return
    const t = setTimeout(() => {
      api<{ lines: { available: number; total: number }[] }>('/rooms/availability', { method: 'POST', body: JSON.stringify({ lines: query }) })
        .then((res) => setFree({ key: queryKey, lines: res.lines }))
        .catch(() => setFree(null))
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])
  const answered = free?.key === queryKey ? free.lines : null
  const datedCount = lines.filter((l) => l.from).length
  /** What the line at `i` of `rooms` has free, or undefined while unknown / undated. */
  const freeFor = (i: number) => {
    if (!answered || !lines[i]!.from) return undefined
    return answered[lines.slice(0, i).filter((l) => l.from).length]
  }
  const formFree = answered && query.length > datedCount ? answered[datedCount] : undefined

  const unitItems = units.map((u) => ({ value: u.id, label: u.name }))
  const typeItems = options.roomRates
    .filter((r) => r.unitId === unitId)
    .map((r) => ({ value: r.roomType, label: `${r.roomType} · ${formatPaise(r.rackRatePaise)} / night` }))
  // Never more than is free: the Add waits for the answer, and refuses a count above it.
  const over = formFree != null && Number(count) > formFree.available
  const ready = Boolean(unitId && roomType && start && Number(count) > 0 && nightsN > 0 && formFree && !over)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Optional — skip if the guest needs no rooms.</p>
      {rooms.length > 0 && (
        <ul className="space-y-2">
          {rooms.map((r, i) => (
            <li key={i} className="flex items-center justify-between rounded-lg border bg-card p-3 text-sm">
              <span>
                {r.count} × {roomLabel(r.roomType)} · {units.find((u) => u.id === r.unitId)?.name} ·{' '}
                {stayLabel(r.checkIn || fromDate, r.nights)}
                {/* A line that fitted when it was added can stop fitting: its dates moved, or
                    another booking took the rooms. Said in words, not just colour. */}
                {(() => {
                  const f = freeFor(i)
                  return f && r.count > f.available ? (
                    <span className="block text-xs font-medium text-red-600 dark:text-red-400">
                      Only {f.available} of {f.total} free on these dates — reduce this line.
                    </span>
                  ) : null
                })()}
              </span>
              <Button variant="ghost" size="icon" aria-label="Remove rooms" onClick={() => setRooms(rooms.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="Lodge">
          <Select items={unitItems} value={unitId} onValueChange={(v) => { setUnitId(v ?? ''); setRoomType('') }}>
            <SelectTrigger><SelectValue placeholder="Lodge" /></SelectTrigger>
            <SelectContent>
              {unitItems.map((u) => (
                <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Category">
          <Select items={typeItems} value={roomType} onValueChange={(v) => setRoomType(v ?? '')}>
            <SelectTrigger disabled={!unitId}><SelectValue placeholder="Category" /></SelectTrigger>
            <SelectContent>
              {typeItems.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Rooms">
          <Input type="number" min={1} max={formFree?.available || undefined} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Check-in">
          <Input type="date" value={checkIn || fromDate} onChange={(e) => setCheckIn(e.target.value === fromDate ? '' : e.target.value)} />
        </Field>
        <Field label="Nights">
          <Input type="number" min={1} value={nights} onChange={(e) => setNights(e.target.value)} />
        </Field>
      </div>
      {unitId && roomType && (
        <p className={cn('text-sm', over ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
          {!start
            ? 'Pick a check-in date to see how many rooms are free.'
            : !formFree
              ? 'Checking what is free…'
              : over
                ? `Only ${formFree.available} of ${formFree.total} ${roomLabel(roomType)} free on these dates.`
                : `${formFree.available} of ${formFree.total} ${roomLabel(roomType)} free on these dates.`}
        </p>
      )}
      <Button
        variant="outline"
        disabled={!ready}
        onClick={() => {
          setRooms([...rooms, { unitId, roomType, count: Number(count), nights: Number(nights), ...(checkIn && { checkIn }) }])
          setCount('')
        }}
      >
        Add rooms
      </Button>
    </div>
  )
}

const inr = (paise: number) => formatPaise(paise, { symbol: false })
/** Table cells: whole rupees when there are no paise ("2,10,000"), so eight columns fit an A4. */
const inrShort = (paise: number) => {
  const full = inr(paise)
  return full.endsWith('.00') ? full.slice(0, -3) : full
}
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
/** "Wednesday, 10 February 2027" — a date heading. */
const dayDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

/** "deluxe_other" → "Deluxe Other": room categories are stored as codes. */
const roomLabel = (code: string) => code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
/** "16 Oct → 18 Oct · 2 nights", or just the nights when there is no date to count from. */
const stayLabel = (checkIn: string, nights: number) =>
  `${checkIn ? `${shortDate(checkIn)} → ${shortDate(addDaysISO(checkIn, nights))} · ` : ''}${nights} night${nights === 1 ? '' : 's'}`
const addDaysISO = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * The one-page summary the lead drew (booking-summary.html), filled from the quote.
 *
 * Every price on its own line (client, 16 Oct 2026): each function's hall, plate rate and food,
 * and each room line with its lodge, category and nights — on ONE page, so the dish lists were
 * taken off it. The dishes are still on the proposal itself, and on the real one once converted.
 */
function InstantSummary({
  quote,
  rooms,
  guestName,
  eventLabel,
  fromDate,
  toDate,
}: {
  quote: DemoQuote
  /** The draft's rooms, in the order the quote priced them — for the dates the quote doesn't carry. */
  rooms: Room[]
  guestName: string
  eventLabel: string
  fromDate: string
  toDate: string
}) {
  const roomCount = quote.rooms.reduce((s, r) => s + r.count, 0)
  const from = fromDate || quote.functions.find((f) => f.eventDate)?.eventDate || ''
  const to = toDate || [...quote.functions].reverse().find((f) => f.eventDate)?.eventDate || from
  const dates = !from ? 'Dates to be fixed' : from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`

  // DATE-WISE (client, 16 Oct 2026): each date has its functions — hall, menu and the price of
  // each — and the rooms occupied THAT night, so a guest reads what every day costs. A room booked
  // for three nights appears under each of its three dates at one night's price; the hall is
  // shown on its function's date, carried by the day's first function as on the bill.
  type QuoteFn = DemoQuote['functions'][number]
  type Night = { lodge: string; category: string; night: string; count: number; ratePaise: number; amountPaise: number; nights: number }
  const byDate = new Map<string, { fns: QuoteFn[]; rooms: Night[]; totalPaise: number }>()
  const dayOf = (date: string) => {
    if (!byDate.has(date)) byDate.set(date, { fns: [], rooms: [], totalPaise: 0 })
    return byDate.get(date)!
  }
  for (const f of quote.functions) {
    const day = dayOf(f.eventDate ?? '')
    day.fns.push(f)
    day.totalPaise += (f.venuePaise ?? 0) + f.foodPaise
  }
  quote.rooms.forEach((r, i) => {
    const start = rooms[i]?.checkIn || from
    const base = { lodge: r.unitName, category: roomLabel(r.roomType), count: r.count, ratePaise: r.ratePaise, nights: r.nights }
    if (!start) {
      // Undated: the whole stay in one line under "Date to be fixed".
      dayOf('').rooms.push({ ...base, night: '', amountPaise: r.amountPaise })
      dayOf('').totalPaise += r.amountPaise
      return
    }
    for (let n = 0; n < r.nights; n++) {
      const night = addDaysISO(start, n)
      const day = dayOf(night)
      day.rooms.push({ ...base, night, amountPaise: r.ratePaise * r.count })
      day.totalPaise += r.ratePaise * r.count
    }
  })
  // Dated days in order; anything not yet dated last.
  const days = [...byDate.entries()]
    .sort(([a], [b]) => (a || '9999').localeCompare(b || '9999'))
    .map(([date, d]) => ({ date, ...d }))

  return (
    <div className={styles.sheet}>
      <div className={styles.bar} />
      <div className={styles.wrap}>
        <div className={styles.hdr}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/hotel-dipali-logo.png" alt="Hotel Dipali" />
          <div className={styles.hdrR}>
            <div className={styles.eyebrow}>BOOKING ESTIMATE</div>
            <div className={styles.title}>PROPOSAL</div>
            <div className={styles.ref}>Estimate · {longDate(new Date().toISOString().slice(0, 10))}</div>
          </div>
        </div>

        <div className={styles.guest}>
          <div>
            <div className={styles.guestName}>{guestName}</div>
            <div className={styles.guestEvent}>{[eventLabel, dates].filter(Boolean).join(' · ')}</div>
          </div>
          <div className={styles.stats}>
            <div><b>{quote.functions.length}</b><span>FUNCTIONS</span></div>
            <div><b>{quote.functions.reduce((s, f) => s + (f.pax ?? 0), 0).toLocaleString('en-IN')}</b><span>GUESTS</span></div>
            <div><b>{roomCount}</b><span>ROOMS</span></div>
          </div>
        </div>

        {days.map((day) => (
          <section key={day.date || 'tbd'} className={styles.day}>
            <div className={styles.dayH}>
              <span>{day.date ? dayDate(day.date) : 'Date to be fixed'}</span>
              <span>Day total ₹{inr(day.totalPaise)}</span>
            </div>
            {day.fns.length > 0 && (
              <table className={cn(styles.tbl, styles.fnTbl)}>
                <thead>
                  <tr>
                    <th>Function</th>
                    <th>Item</th>
                    <th>Details</th>
                    <th className={styles.r}>Pax</th>
                    <th className={styles.r}>₹ / plate</th>
                    <th className={styles.r}>Amount ₹</th>
                  </tr>
                </thead>
                {/* Venue and food on rows of their own (client, 16 Oct 2026), the function named
                    once beside them. One <tbody> per function keeps the pair together. */}
                {day.fns.map((f) => {
                  const lines: { item: string; detail: string; pax: string; rate: string; amount: ReactNode }[] = []
                  if (f.venueName) {
                    lines.push({
                      item: 'Venue',
                      detail: f.venueName,
                      pax: '',
                      rate: '',
                      // 0 is a hall already paid for that day (one hire a day), never "free".
                      amount: f.venuePaise == null ? <small>To be quoted</small> : f.venuePaise === 0 ? <small>Included</small> : inrShort(f.venuePaise),
                    })
                  }
                  if (f.tierName) {
                    lines.push({
                      item: 'Food',
                      detail: f.tierName,
                      pax: f.pax ? String(f.pax) : '—',
                      rate: f.perPlatePaise != null ? inrShort(f.perPlatePaise) : '—',
                      amount: inrShort(f.foodPaise),
                    })
                  }
                  if (lines.length === 0) lines.push({ item: '—', detail: 'Venue and menu to be fixed', pax: f.pax ? String(f.pax) : '', rate: '', amount: '—' })
                  return (
                    <tbody key={f.index} className={styles.fnGroup}>
                      {lines.map((l, i) => (
                        <tr key={l.item}>
                          {i === 0 && (
                            <td rowSpan={lines.length} className={styles.fnName}>
                              <b>{f.name || 'Function'}</b>
                              <small>{f.startTime && f.endTime ? formatTimeRange(f.startTime, f.endTime) : 'Time to be fixed'}</small>
                            </td>
                          )}
                          <td className={styles.item}>{l.item}</td>
                          <td>{l.detail}</td>
                          <td className={styles.r}>{l.pax}</td>
                          <td className={styles.r}>{l.rate}</td>
                          <td className={cn(styles.r, styles.amt)}>{l.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  )
                })}
              </table>
            )}
            {day.rooms.length > 0 && (
              <table className={cn(styles.tbl, styles.roomTbl)}>
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>{day.date ? 'Night' : 'Stay'}</th>
                    <th className={styles.r}>Rooms</th>
                    <th className={styles.r}>₹ / night</th>
                    <th className={styles.r}>Amount ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {day.rooms.map((r, i) => (
                    <tr key={i}>
                      <td><b>{r.lodge}</b> · {r.category}</td>
                      <td>
                        {r.night
                          ? `${shortDate(r.night)} → check-out ${shortDate(addDaysISO(r.night, 1))}`
                          : `${r.nights} night${r.nights === 1 ? '' : 's'}`}
                      </td>
                      <td className={styles.r}>{r.count}</td>
                      <td className={styles.r}>{inrShort(r.ratePaise)}</td>
                      <td className={cn(styles.r, styles.amt)}>{inrShort(r.amountPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>

      <div className={styles.bottom}>
        <div>
          <div className={styles.sumRow}><span>Functions · venue &amp; food</span><span>{inr(quote.functionsPaise)}</span></div>
          {quote.rooms.length > 0 && (
            <>
              <div className={styles.sumRow}><span>Rooms · {roomCount} rooms</span><span>{inr(quote.roomsPaise)}</span></div>
              <div className={styles.sumRow}><span>GST on rooms</span><span>{inr(quote.roomTaxPaise)}</span></div>
            </>
          )}
          <div className={styles.sumRow}><span>Amount payable</span><span>{inr(quote.payablePaise)}</span></div>
          <div className={styles.sumRow}><span>GST 18%</span><span>{inr(quote.shownGstPaise)}</span></div>
        </div>
        <div className={styles.total}>
          <div className={styles.totalL}>ESTIMATED TOTAL</div>
          <div className={styles.totalV}>{formatPaise(quote.displayTotalPaise)}</div>
          <div className={styles.totalA}>Amount payable: <b>{formatPaise(quote.payablePaise)}</b></div>
          <div className={styles.totalA}>Advance to confirm: <b>{formatPaise(quote.advancePaise)}</b></div>
        </div>
      </div>

      <div className={styles.ftr}>
        <div className={styles.ftrQ}>We look forward to hosting your celebration.</div>
        <div className={styles.ftrC}>Hotel Dipali, Sagar · +91 07582 263910</div>
      </div>
    </div>
  )
}
