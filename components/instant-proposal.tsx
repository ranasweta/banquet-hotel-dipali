'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
type Room = { unitId: string; roomType: string; count: number; nights: number }
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
      <SummaryNotes quote={quote} fns={fns} eventType={eventType} />
      {/* On a phone the A4 sheet scrolls sideways inside its own box, never the page. */}
      <div className="overflow-x-auto print:overflow-visible">
        <InstantSummary
          quote={quote}
          fns={fns}
          tiers={tiers}
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
          <InstantRooms options={options} rooms={rooms} setRooms={setRooms} />
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

function SummaryNotes({ quote, fns, eventType }: { quote: DemoQuote; fns: Fn[]; eventType: string }) {
  const notes: string[] = []
  if (!eventType && fns.some((f) => f.target)) notes.push('Pick the event type to price the halls — a hall’s rate depends on it.')
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

      <div className="rounded-lg border p-4">
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
        const full = c.pickCount != null && picked.length >= c.pickCount
        return (
          <div key={c.id}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {c.pickCount == null ? 'All included' : `${picked.length} of ${c.pickCount} chosen`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {c.items.map((item) => {
                const on = c.pickCount == null || picked.includes(item)
                return (
                  <button
                    key={item}
                    type="button"
                    disabled={c.pickCount == null || (!on && full)}
                    aria-pressed={on}
                    onClick={() =>
                      onChange({ ...dishes, [c.name]: on ? picked.filter((x) => x !== item) : [...picked, item] })
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
                      c.pickCount == null && 'cursor-default',
                      !on && full && 'opacity-40',
                    )}
                  >
                    {on && c.pickCount != null && '✓ '}
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

function InstantRooms({ options, rooms, setRooms }: { options: Options; rooms: Room[]; setRooms: (r: Room[]) => void }) {
  const units = options.lodgingUnits ?? []
  const [unitId, setUnitId] = useState('')
  const [roomType, setRoomType] = useState('')
  const [count, setCount] = useState('')
  const [nights, setNights] = useState('1')

  const unitItems = units.map((u) => ({ value: u.id, label: u.name }))
  const typeItems = options.roomRates
    .filter((r) => r.unitId === unitId)
    .map((r) => ({ value: r.roomType, label: `${r.roomType} · ${formatPaise(r.rackRatePaise)} / night` }))
  const ready = Boolean(unitId && roomType && Number(count) > 0 && Number(nights) > 0)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Optional — skip if the guest needs no rooms.</p>
      {rooms.length > 0 && (
        <ul className="space-y-2">
          {rooms.map((r, i) => (
            <li key={i} className="flex items-center justify-between rounded-lg border bg-card p-3 text-sm">
              <span>
                {r.count} × {r.roomType} · {units.find((u) => u.id === r.unitId)?.name} · {r.nights} night{r.nights === 1 ? '' : 's'}
              </span>
              <Button variant="ghost" size="icon" aria-label="Remove rooms" onClick={() => setRooms(rooms.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
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
          <Input type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Nights">
          <Input type="number" min={1} value={nights} onChange={(e) => setNights(e.target.value)} />
        </Field>
      </div>
      <Button
        variant="outline"
        disabled={!ready}
        onClick={() => {
          setRooms([...rooms, { unitId, roomType, count: Number(count), nights: Number(nights) }])
          setCount('')
        }}
      >
        Add rooms
      </Button>
    </div>
  )
}

const inr = (paise: number) => formatPaise(paise, { symbol: false })
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

/** The one-page summary the lead drew (booking-summary.html), filled from the quote. */
function InstantSummary({
  quote,
  fns,
  tiers,
  guestName,
  eventLabel,
  fromDate,
  toDate,
}: {
  quote: DemoQuote
  fns: Fn[]
  tiers: Tier[]
  guestName: string
  eventLabel: string
  fromDate: string
  toDate: string
}) {
  const roomCount = quote.rooms.reduce((s, r) => s + r.count, 0)
  // One block per distinct menu: functions on the same tier with the same dishes share one.
  const menus = new Map<string, { names: string[]; tierName: string; perPlatePaise: number; lines: string[] }>()
  quote.functions.forEach((qf) => {
    const f = fns[qf.index]
    const tier = f && tiers.find((t) => t.id === f.tierId)
    if (!f || !tier || !qf.tierName || qf.perPlatePaise == null) return
    const lines = tier.categories.flatMap((c) => {
      if (c.pickCount == null) return [c.name]
      const picked = f.dishes[c.name] ?? []
      return picked.length ? picked : [`${c.name} (any ${c.pickCount})`]
    })
    const key = `${f.tierId}|${lines.join('|')}`
    const fnName = f.name || 'Untitled function'
    const m = menus.get(key)
    if (m) m.names.push(fnName)
    else menus.set(key, { names: [fnName], tierName: qf.tierName, perPlatePaise: qf.perPlatePaise, lines })
  })
  const from = fromDate || quote.functions.find((f) => f.eventDate)?.eventDate || ''
  const to = toDate || [...quote.functions].reverse().find((f) => f.eventDate)?.eventDate || from
  const dates = !from ? 'Dates to be fixed' : from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`
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

        {quote.functions.length > 0 && (
          <>
            <div className={styles.sec}>FUNCTIONS</div>
            <table className={styles.fn}>
              <thead>
                <tr><th>FUNCTION</th><th>VENUE</th><th>MENU</th><th className={styles.r}>PAX</th><th className={styles.r}>₹</th></tr>
              </thead>
              <tbody>
                {quote.functions.map((f) => (
                  <tr key={f.index}>
                    <td>
                      <b>{f.name || 'Function'}</b>
                      <small>
                        {[
                          f.eventDate ? shortDate(f.eventDate) : 'Date to be fixed',
                          f.startTime && f.endTime ? formatTimeRange(f.startTime, f.endTime) : null,
                        ].filter(Boolean).join(' · ')}
                      </small>
                    </td>
                    <td>{f.venueName ?? '—'}</td>
                    <td className={styles.menuName}>{f.tierName ?? '—'}</td>
                    <td className={styles.r}>{f.pax ?? '—'}</td>
                    <td className={styles.r}>{inr((f.venuePaise ?? 0) + f.foodPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {menus.size > 0 && (
          <>
            <div className={styles.sec}>MENUS</div>
            <div className={styles.menus}>
              {[...menus.entries()].map(([key, m]) => (
                <div key={key}>
                  <div className={styles.menuH}><span>{m.tierName}</span><em>₹{inr(m.perPlatePaise)} / plate</em></div>
                  <p className={styles.menuFor}>{m.names.join(', ')}</p>
                  <p>{m.lines.join(' · ')}</p>
                </div>
              ))}
            </div>
          </>
        )}
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
