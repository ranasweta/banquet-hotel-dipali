'use client'

import { useEffect, useState } from 'react'
import { Printer, Trash2 } from 'lucide-react'
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
import type { DemoQuote } from '@/lib/demo-quote'
import styles from './demo-summary.module.css'

/**
 * The demo proposal (client's lead, 1 Oct 2026). The New-proposal steps, held entirely in this
 * page's state: nothing is saved, no venue is held, no money is taken. It exists so a guest who
 * is only asking can be shown how a booking comes together — and what it costs — without a real
 * proposal being created that has to be cancelled later. Any venue, menu or time may be picked;
 * availability is not checked. Prices are the real ones, from /demo-quote.
 */

type Options = {
  eventTypes: { code: string; displayName: string }[]
  venues: { id: string; name: string; propertyName: string; priceable: boolean }[]
  bundles: { id: string; name: string }[]
  roomRates: { unitId: string; roomType: string; rackRatePaise: number }[]
  lodgingUnits?: { id: string; name: string }[]
}
type Tier = { id: string; name: string }
type Fn = { name: string; eventDate: string; startTime: string; endTime: string; target: string; pax: number; tierId: string }
type Room = { unitId: string; roomType: string; count: number; nights: number }

const STEPS = ['Date & event', 'Guest', 'Functions & menu', 'Rooms', 'Summary']

export function DemoProposal() {
  const [step, setStep] = useState(0)
  const [options, setOptions] = useState<Options | null>(null)
  const [tiers, setTiers] = useState<Tier[]>([])
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [eventType, setEventType] = useState('')
  const [guestName, setGuestName] = useState('')
  const [phone, setPhone] = useState('')
  const [fns, setFns] = useState<Fn[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [quote, setQuote] = useState<DemoQuote | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Options>('/booking-options')
      .then(setOptions)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load options'))
    api<{ tiers: Tier[] }>('/menu/catalog')
      .then((r) => setTiers(r.tiers))
      .catch(() => setTiers([]))
  }, [])

  if (!options) return <p className="text-sm text-muted-foreground">Loading…</p>

  const types = BOOKABLE_EVENT_TYPES.map((code) => options.eventTypes.find((t) => t.code === code))
    .filter((t): t is Options['eventTypes'][number] => Boolean(t))
    .map((t) => ({ value: t.code, label: eventTypeLabel(t.code, t.displayName) }))
  const datesOk = Boolean(fromDate && toDate && toDate >= fromDate)

  async function review() {
    setBusy(true)
    try {
      const r = await api<{ quote: DemoQuote }>('/demo-quote', {
        method: 'POST',
        body: JSON.stringify({
          event_type: eventType,
          functions: fns.map((f) => ({
            name: f.name,
            event_date: f.eventDate,
            start_time: f.startTime,
            end_time: f.endTime,
            venue_id: f.target.startsWith('venue:') ? f.target.slice(6) : null,
            bundle_id: f.target.startsWith('bundle:') ? f.target.slice(7) : null,
            pax: f.pax,
            tier_id: f.tierId,
          })),
          rooms: rooms.map((r) => ({ unit_id: r.unitId, room_type: r.roomType, count: r.count, nights: r.nights })),
        }),
      })
      setQuote(r.quote)
      setStep(4)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not price the demo')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="print:hidden">
        <Stepper steps={STEPS} step={step} onStep={setStep} canStep={(i) => i < step} />
      </div>

      {step === 0 && (
        <StepCard title="Date & event">
          <p className="text-sm text-muted-foreground">A demo — nothing here is saved or booked.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From date">
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </Field>
            <Field label="To date">
              <Input type="date" min={fromDate || undefined} value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Event">
              <Select items={types} value={eventType} onValueChange={(v) => setEventType(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Wedding or Others" /></SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Guest name">
              <Input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Any name" />
            </Field>
          </div>
          <Nav onNext={() => setStep(1)} nextDisabled={!datesOk || !eventType || !guestName.trim()} />
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
            On a real proposal the guest&apos;s Aadhaar is captured here. A demo needs none.
          </p>
          <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} />
        </StepCard>
      )}

      {step === 2 && (
        <StepCard title="Functions & menu">
          <DemoFunctions options={options} tiers={tiers} fromDate={fromDate} toDate={toDate} fns={fns} setFns={setFns} />
          <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={fns.length === 0} />
        </StepCard>
      )}

      {step === 3 && (
        <StepCard title="Rooms">
          <DemoRooms options={options} rooms={rooms} setRooms={setRooms} />
          <Nav onBack={() => setStep(2)} onNext={review} busy={busy} nextLabel="Show summary" />
        </StepCard>
      )}

      {step === 4 && quote && (
        <>
          <div className="flex justify-between print:hidden">
            <Button variant="outline" onClick={() => setStep(3)}>Back</Button>
            <Button onClick={() => window.print()}>
              <Printer className="mr-2 size-4" /> Print / Save as PDF
            </Button>
          </div>
          {quote.missingVenueRates.length > 0 && (
            <p className="text-sm text-amber-600 print:hidden">
              No hall rate for this event type at: {quote.missingVenueRates.join(', ')}. The summary leaves the hall out of those functions.
            </p>
          )}
          {/* On a phone the A4 sheet scrolls sideways inside its own box, never the page. */}
          <div className="overflow-x-auto print:overflow-visible">
            <DemoSummary
              quote={quote}
              guestName={guestName}
              eventLabel={types.find((t) => t.value === eventType)?.label ?? ''}
              fromDate={fromDate}
              toDate={toDate}
            />
          </div>
        </>
      )}
    </div>
  )
}

function DemoFunctions({
  options,
  tiers,
  fromDate,
  toDate,
  fns,
  setFns,
}: {
  options: Options
  tiers: Tier[]
  fromDate: string
  toDate: string
  fns: Fn[]
  setFns: (f: Fn[]) => void
}) {
  const [name, setName] = useState('')
  const [date, setDate] = useState(fromDate)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [target, setTarget] = useState('')
  const [pax, setPax] = useState('')
  const [tierId, setTierId] = useState('')

  // Every priceable place, free or not — a demo holds nothing, so availability does not matter.
  const venueItems = [
    ...options.venues.filter((v) => v.priceable).map((v) => ({ value: `venue:${v.id}`, label: `${v.name} (${v.propertyName})` })),
    ...options.bundles.map((b) => ({ value: `bundle:${b.id}`, label: `${b.name} [bundle]` })),
  ]
  const tierItems = tiers.map((t) => ({ value: t.id, label: t.name }))
  const ready = Boolean(name.trim() && date && start && end && start !== end && target && Number(pax) > 0 && tierId)

  function add() {
    setFns(
      [...fns, { name: name.trim(), eventDate: date, startTime: start, endTime: end, target, pax: Number(pax), tierId }].sort(
        (a, b) => (a.eventDate + a.startTime).localeCompare(b.eventDate + b.startTime),
      ),
    )
    setName('')
    setStart(end)
    setEnd('')
  }

  return (
    <div className="space-y-4">
      {fns.length > 0 && (
        <ol className="space-y-2">
          {fns.map((f, i) => (
            <li key={i} className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm">
              <div className="min-w-0">
                <span className="font-medium">{f.name}</span>{' '}
                <span className="tabular-nums text-muted-foreground">
                  {f.eventDate} · {formatTimeRange(f.startTime, f.endTime)} · {venueItems.find((v) => v.value === f.target)?.label} · {f.pax} pax
                </span>
                <div className="text-xs text-muted-foreground">{tiers.find((t) => t.id === f.tierId)?.name}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setFns(fns.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ol>
      )}

      <div className="rounded-lg border p-4">
        <h4 className="mb-3 text-sm font-medium">{fns.length === 0 ? 'Add the first function' : `Add function ${fns.length + 1}`}</h4>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" min={fromDate || undefined} max={toDate || undefined} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Start">
            <TimePicker12 value={start} onChange={setStart} />
          </Field>
          <Field label="End">
            <TimePicker12 value={end} onChange={setEnd} />
          </Field>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Venue">
            <Select items={venueItems} value={target} onValueChange={(v) => setTarget(v ?? '')}>
              <SelectTrigger><SelectValue placeholder="Any venue" /></SelectTrigger>
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
            <Input type="number" min={1} value={pax} onChange={(e) => setPax(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Menu (per plate)">
            <Select items={tierItems} value={tierId} onValueChange={(v) => setTierId(v ?? '')}>
              <SelectTrigger><SelectValue placeholder="Choose a menu" /></SelectTrigger>
              <SelectContent>
                {tierItems.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Button className="mt-3 w-full sm:w-auto" onClick={add} disabled={!ready}>Add function</Button>
      </div>
    </div>
  )
}

function DemoRooms({ options, rooms, setRooms }: { options: Options; rooms: Room[]; setRooms: (r: Room[]) => void }) {
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
              <Button variant="ghost" size="icon" onClick={() => setRooms(rooms.filter((_, j) => j !== i))}>
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

/** The one-page summary the lead drew (booking-summary.html), filled from the demo quote. */
function DemoSummary({
  quote,
  guestName,
  eventLabel,
  fromDate,
  toDate,
}: {
  quote: DemoQuote
  guestName: string
  eventLabel: string
  fromDate: string
  toDate: string
}) {
  const roomCount = quote.rooms.reduce((s, r) => s + r.count, 0)
  const dates = fromDate === toDate ? longDate(fromDate) : `${longDate(fromDate)} – ${longDate(toDate)}`
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
            <div className={styles.guestEvent}>{eventLabel} · {dates}</div>
          </div>
          <div className={styles.stats}>
            <div><b>{quote.functions.length}</b><span>FUNCTIONS</span></div>
            <div><b>{quote.functions.reduce((s, f) => s + f.pax, 0).toLocaleString('en-IN')}</b><span>GUESTS</span></div>
            <div><b>{roomCount}</b><span>ROOMS</span></div>
          </div>
        </div>

        <div className={styles.sec}>FUNCTIONS</div>
        <table className={styles.fn}>
          <thead>
            <tr><th>FUNCTION</th><th>VENUE</th><th>MENU</th><th className={styles.r}>PAX</th><th className={styles.r}>₹</th></tr>
          </thead>
          <tbody>
            {quote.functions.map((f, i) => (
              <tr key={i}>
                <td><b>{f.name}</b><small>{shortDate(f.eventDate)} · {formatTimeRange(f.startTime, f.endTime)}</small></td>
                <td>{f.venueName}</td>
                <td className={styles.menuName}>{f.tierName}</td>
                <td className={styles.r}>{f.pax}</td>
                <td className={styles.r}>{inr((f.venuePaise ?? 0) + f.foodPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className={styles.sec}>MENUS</div>
        <div className={styles.menus}>
          {quote.menus.map((m) => (
            <div key={m.tierName}>
              <div className={styles.menuH}><span>{m.tierName}</span><em>₹{inr(m.perPlatePaise)} / plate</em></div>
              <p>{m.categories.map((c) => (c.pickCount == null ? c.name : `${c.name} (any ${c.pickCount})`)).join(' · ')}</p>
            </div>
          ))}
        </div>
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
