'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { BOOKABLE_EVENT_TYPES, eventTypeLabel } from '@/lib/event-types'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { formatTimeRange, todayISO } from '@/lib/time'
import { TimePicker12 } from '@/components/ui/time-picker-12'
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
import { MenuPicker, type CatalogTier, type MenuPool } from '@/components/menu-picker'
import { EventDiscounts } from '@/components/event-discounts'
import { cn } from '@/lib/utils'

type EventType = { code: string; displayName: string; contactNumbers: number; isWedding: boolean }
type Venue = { id: string; name: string; kind: string; propertyName: string; capacityMin: number; capacityMax: number }
type Bundle = { id: string; name: string; members: string }
type Options = {
  eventTypes: EventType[]
  venues: Venue[]
  bundles: Bundle[]
  roomTypes: string[]
  roomRates: { unitId: string; roomType: string; rackRatePaise: number }[]
  lodgingUnits?: { id: string; name: string }[]
}
type Tier = CatalogTier

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
type RoomReq = { unit_id: string; room_type: string; count: number; check_in: string; check_out: string }
type Quote = {
  totalPaise: number
  discountPaise: number
  /** Venue + food + rooms + the 5% on rooms, less discounts — what is actually collected. */
  payablePaise: number
  /** The 18% printed on the guest's proposal and charged to nobody (client, 4 Aug 2026). */
  shownGstPaise: number
  /** payable + the 18% — the "Total" line the guest reads. */
  displayTotalPaise: number
  advanceRequiredPaise: number
  weddingMilestonePaise: number
  lines: { subEventId: string; name: string; ratePaise: number | null }[]
  missing: { subEventId: string; name: string }[]
}

// Dates & event first, then who the guest is (KYC), then the functions with their menus.
const STEPS = ['Date & event', 'KYC', 'Functions & menu', 'Rooms', 'Payment review']

/** The usual run of functions, offered as one-tap names once the first one exists. */
const SUGGESTED_FUNCTIONS = ['Mehndi', 'Haldi', 'Sangeet', 'Wedding', 'Reception', 'Tilak']

/**
 * Basis points. Rooms carry 5% and it is the only GST the hotel actually collects — the 18%
 * added on 4 Aug 2026 is printed on the guest's proposal and enters no threshold, so it plays
 * no part in this step's live estimate. Mirrors ROOM_GST_BP in lib/tax.ts.
 */
const ROOM_TAX_BP = 500

export function BookingWizard({ resumeEventId }: { resumeEventId?: string } = {}) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [options, setOptions] = useState<Options | null>(null)
  const [tiers, setTiers] = useState<Tier[]>([])
  const [pools, setPools] = useState<MenuPool[]>([])
  const [eventId, setEventId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // True only while a resumed proposal is being pulled back into the form (client, 23 Jul 2026).
  const [hydrating, setHydrating] = useState(Boolean(resumeEventId))
  // The resumed event's status: an Authority editing a `confirmed` booking skips the advance/
  // confirm at the end, since the edits save incrementally (tester, 23 Jul 2026).
  const [eventStatus, setEventStatus] = useState<string>('enquiry')

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
  const [roomsSavedAt, setRoomsSavedAt] = useState<Date | null>(null)

  // Step 5 — review
  const [quote, setQuote] = useState<Quote | null>(null)

  useEffect(() => {
    api<Options>('/booking-options')
      .then(setOptions)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load options'))
    api<{ tiers: Tier[]; pools: MenuPool[] }>('/menu/catalog')
      .then((r) => {
        setTiers(r.tiers)
        setPools(r.pools ?? [])
      })
      .catch(() => setTiers([]))
  }, [])

  // Resuming a saved enquiry: rehydrate every step from the server so the manager can pick up
  // where they left off and edit anything before the 25% confirm (client, 23 Jul 2026). The
  // page only routes here for enquiries, so no post-confirm state can land in the wizard.
  useEffect(() => {
    if (!resumeEventId) return
    let cancelled = false
    ;(async () => {
      try {
        const [detail, roomRes] = await Promise.all([
          api<{
            event: {
              guestName: string
              eventType: string
              status: string
              contacts: { phone: string; label: string | null }[]
              subEvents: SubEvent[]
              documents: { kind: string }[]
            }
          }>(`/events/${resumeEventId}`),
          api<{
            requirements: RoomReq[]
            window: { firstDate: string | null; lastDate: string | null }
          }>(`/events/${resumeEventId}/room-requirements`),
        ])
        if (cancelled) return
        const ev = detail.event
        setEventId(resumeEventId)
        setEventStatus(ev.status)
        setGuestName(ev.guestName)
        setEventType(ev.eventType)
        setContacts(ev.contacts.length ? ev.contacts.map((c) => c.phone) : [''])
        setDocs({
          aadhaar_front: ev.documents.some((d) => d.kind === 'aadhaar_front'),
          aadhaar_back: ev.documents.some((d) => d.kind === 'aadhaar_back'),
        })
        setSubEvents(ev.subEvents)
        // The declared run (planned_from/to), falling back to the functions' span server-side.
        setFromDate(roomRes.window.firstDate ?? '')
        setToDate(roomRes.window.lastDate ?? '')
        setRooms(roomRes.requirements)

        // Menu summary per function so the food line and the picker both show the saved tier.
        const entries = await Promise.all(
          ev.subEvents.map(async (s) => {
            try {
              const r = await api<{ menu: { tierName: string; perPlatePaise: number } | null }>(`/sub-events/${s.id}/menu`)
              return r.menu ? ([s.id, { tierName: r.menu.tierName, perPlatePaise: r.menu.perPlatePaise }] as const) : null
            } catch {
              return null
            }
          }),
        )
        if (cancelled) return
        setMenuBySub(Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null)))
        void loadQuote(resumeEventId)
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : 'Could not load this proposal')
      } finally {
        if (!cancelled) setHydrating(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resumeEventId])

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
    if (trimmed.some((p) => !/^\d{10}$/.test(p))) {
      return toast.error('Each contact must be a 10-digit mobile number')
    }
    setBusy(true)
    try {
      const contactsPayload = trimmed.map((phone, i) => ({ phone, label: i === 0 ? 'primary' : undefined }))
      // The declared run (from/to) rides along so rooms can be bounded by the whole event
      // window server-side, not just the functions' dates (client, 22 Jul 2026).
      if (!eventId) {
        const { event } = await api<{ event: { id: string } }>('/events', {
          method: 'POST',
          body: JSON.stringify({ guest_name: guestName, event_type: eventType, from_date: fromDate, to_date: toDate, contacts: contactsPayload }),
        })
        setEventId(event.id)
        toast.success('Proposal created — now add the Aadhaar images.')
      } else {
        await api(`/events/${eventId}`, { method: 'PUT', body: JSON.stringify({ guest_name: guestName, from_date: fromDate, to_date: toDate, contacts: contactsPayload }) })
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
    name: string; eventDate: string; startTime: string; endTime: string; target: string; pax: number; tierId: string
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
      }),
    })
    // Tier now, dishes later: saving with no selections keeps the menu incomplete (FR-3.2).
    if (spec.tierId) {
      try {
        const saved = await api<{ menu: { tierName: string; perPlatePaise: number } }>(
          `/sub-events/${subEvent.id}/menu`,
          {
            method: 'PUT',
            body: JSON.stringify({ tier_id: spec.tierId, is_tentative: true, selections: {} }),
          },
        )
        // Read the rate back rather than assuming the tier's base: the wedding surcharge
        // (BR-M5) is added server-side, so a base-rate guess shows Rs. 650 where the guest
        // is billed Rs. 700. Money is never recomputed on the client.
        setMenuBySub((m) => ({
          ...m,
          [subEvent.id]: { tierName: saved.menu.tierName, perPlatePaise: saved.menu.perPlatePaise },
        }))
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

  const persistRooms = useCallback(async () => {
    if (!eventId) return
    await api(`/events/${eventId}/room-requirements`, {
      method: 'POST',
      body: JSON.stringify({ requirements: rooms.filter((r) => r.room_type && r.count > 0) }),
    })
  }, [eventId, rooms])

  /**
   * Rooms save themselves too. Deciding lodging can take days, so a half-filled list has to
   * survive leaving the page — only complete lines are sent, so a row being typed is ignored.
   */
  useEffect(() => {
    if (!eventId || step !== 3) return
    const t = setTimeout(() => {
      persistRooms()
        .then(() => setRoomsSavedAt(new Date()))
        .catch(() => { /* surfaced on the explicit Save & review */ })
    }, 800)
    return () => clearTimeout(t)
  }, [rooms, eventId, step, persistRooms])

  async function saveRooms(next: number) {
    if (!eventId) return
    setBusy(true)
    try {
      await persistRooms()
      setRoomsSavedAt(new Date())
      setStep(next)
      if (next === 4) await loadQuote(eventId)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save rooms')
    } finally {
      setBusy(false)
    }
  }

  if (!options || hydrating) return <p className="text-sm text-muted-foreground">Loading…</p>

  // The proposal only distinguishes Wedding from everything else ("Others" → the `other`
  // type): Wedding drives the 3-contact rule and the silent food surcharge. The event's
  // name never affects price.
  // The pair lives in lib/event-types.ts so the venue master prices exactly the two a booking
  // can be made as, rather than all six rows the table happens to carry.
  const proposalTypes = BOOKABLE_EVENT_TYPES.map((code) =>
    options.eventTypes.find((t) => t.code === code),
  )
    .filter((t): t is EventType => Boolean(t))
    .map((t) => ({ value: t.code, label: eventTypeLabel(t.code, t.displayName) }))

  const datesOk = Boolean(fromDate && toDate && toDate >= fromDate)
  const foodTotalPaise = subEvents.reduce((sum, s) => sum + (menuBySub[s.id]?.perPlatePaise ?? 0) * s.pax, 0)

  // Lodging estimate: rooms × nights × the type's rack rate. The exact charge is settled when
  // the Lodge Manager allocates real rooms, but the proposal has to show a number.
  const roomLinePaise = (r: (typeof rooms)[number]) => {
    // Rate is per lodge + category — the same pairing the server prices with.
    const rate =
      options.roomRates?.find((x) => x.unitId === r.unit_id && x.roomType === r.room_type)?.rackRatePaise ?? 0
    return rate * Math.max(0, r.count) * nightsBetween(r.check_in, r.check_out)
  }
  const roomsTotalPaise = rooms.reduce((sum, r) => sum + roomLinePaise(r), 0)
  // Only rooms are taxed, at 5% (client, 20 Jul 2026) — mirrors GST_BP in lib/invoice.ts.
  // Rounded per line and then summed, exactly as the payment review does it, so this
  // estimate and the figure on the Draft can never disagree by a rounding paisa.
  const roomsTaxPaise = rooms.reduce((sum, r) => sum + Math.round((roomLinePaise(r) * ROOM_TAX_BP) / 10000), 0)

  return (
    <div className="space-y-6">
      {/* Free navigation only once the proposal exists (resume, or after the KYC save). Before
          that the fresh flow keeps its step-0 gating and advances with the Next button. */}
      <Stepper step={step} onStep={setStep} canStep={(i) => Boolean(eventId) || i === 0} />

      {step === 0 && (
        <StepCard title="Date & event">
          <p className="text-sm text-muted-foreground">
            Every function must fall inside these dates.
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
              {/* Event type is fixed once the proposal exists — it drives the contact rule and
                  the food surcharge, and changing it can't be undone cleanly. */}
              <Select items={proposalTypes} value={eventType} onValueChange={(v) => setEventType(v ?? '')} disabled={Boolean(eventId)}>
                <SelectTrigger><SelectValue placeholder="Wedding or Others" /></SelectTrigger>
                <SelectContent>
                  {proposalTypes.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eventId && <p className="text-xs text-muted-foreground">Fixed after the proposal is created.</p>}
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
                  inputMode="numeric"
                  maxLength={10}
                  placeholder={i === 0 ? 'Primary 10-digit mobile' : `Contact ${i + 1}`}
                  // Digits only, capped at 10 — Indian mobile numbers (client, 22 Jul 2026).
                  onChange={(e) => setContacts((prev) => prev.map((x, j) => (j === i ? e.target.value.replace(/\D/g, '').slice(0, 10) : x)))}
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
              Capture the card live with the camera, or upload an image. Optional — you can add
              it now, or later from the booking&apos;s page; stored encrypted.
              {!eventId && ' Save the contacts first to enable this.'}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <AadhaarCapture label="Aadhaar front" done={Boolean(docs.aadhaar_front)} disabled={!eventId} onFile={(f) => uploadDoc('aadhaar_front', f)} />
              <AadhaarCapture label="Aadhaar back" done={Boolean(docs.aadhaar_back)} disabled={!eventId} onFile={(f) => uploadDoc('aadhaar_back', f)} />
            </div>
          </div>

          {/* Aadhaar is no longer a gate (client, 22 Jul 2026): it can be skipped here and
              added later from the booking's page. Only the proposal itself must exist to move
              on — that is what `eventId` checks. */}
          <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} busy={busy} nextDisabled={!eventId} />
        </StepCard>
      )}

      {step === 2 && eventId && (
        <StepCard title="Functions & menu">
          <FunctionsEditor
            tiers={tiers}
            pools={pools}
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
          <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} busy={busy} nextDisabled={subEvents.length === 0} />
        </StepCard>
      )}

      {step === 3 && (
        <StepCard title="Room requirements">
          <RoomEditor
            rooms={rooms}
            setRooms={setRooms}
            roomRates={options.roomRates ?? []}
            units={options.lodgingUnits ?? []}
            eventId={eventId}
            fromDate={fromDate}
            toDate={toDate}
          />
          {rooms.length > 0 && (
            <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Rooms (rack-rate estimate)</span>
                <span className="tabular-nums">{formatPaise(roomsTotalPaise)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax — 5% on rooms</span>
                <span className="tabular-nums">+ {formatPaise(roomsTaxPaise)}</span>
              </div>
              <div className="flex justify-between border-t pt-1 font-medium">
                <span>Rooms total</span>
                <span className="tabular-nums">{formatPaise(roomsTotalPaise + roomsTaxPaise)}</span>
              </div>
              <p className="pt-1 text-xs text-muted-foreground">
                Rooms and their tax count toward the 25% advance.
              </p>
            </div>
          )}
          {roomsSavedAt && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              Saved automatically — you can come back to this later.
            </p>
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
          roomsTaxPaise={roomsTaxPaise}
          functions={subEvents.map((s) => ({
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
          rooms={rooms}
          roomRates={options.roomRates ?? []}
          lodgingUnits={options.lodgingUnits ?? []}
          alreadyConfirmed={eventStatus !== 'enquiry'}
          onBack={() => setStep(3)}
          onConfirmed={(code, shortfallPaise) => {
            // A part payment confirms and holds the dates all the same; saying so here is the
            // only moment the manager is guaranteed to be looking (client's lead, 4 Aug 2026).
            if (shortfallPaise > 0) {
              toast.warning(`Confirmed — ${code}. Dates held, ${formatPaise(shortfallPaise)} of the advance still due.`)
            } else {
              toast.success(`Confirmed — ${code}`)
            }
            router.push('/calendar')
          }}
          onDone={() => {
            toast.success('Changes saved')
            router.push(`/bookings/${eventId}`)
          }}
          onDiscountChanged={() => loadQuote(eventId)}
        />
      )}
    </div>
  )
}

/**
 * A numbered trail rather than a row of pills: the connector line makes the sequence
 * legible at a glance, and a done step keeps its number as a tick so progress reads
 * left-to-right. Colour is never the only cue — position, number and tick all carry it.
 */
function Stepper({
  step,
  onStep,
  canStep,
}: {
  step: number
  onStep: (i: number) => void
  canStep: (i: number) => boolean
}) {
  return (
    <ol className="flex items-start">
      {STEPS.map((label, i) => {
        const done = i < step
        const current = i === step
        // A step is reachable once its data can exist; clicking it jumps straight there so a
        // resumed proposal doesn't have to be walked through in order (client, 23 Jul 2026).
        const reachable = canStep(i) && !current
        return (
          <li key={label} className="relative flex flex-1 flex-col items-center gap-2">
            {/* Connector: drawn behind the marker, half on each side, so the ends never
                overhang the first and last markers. */}
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  'absolute left-0 top-4 h-px w-1/2 -translate-x-1/2',
                  done || current ? 'bg-primary/40' : 'bg-border',
                )}
              />
            )}
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  'absolute right-0 top-4 h-px w-1/2 translate-x-1/2',
                  done ? 'bg-primary/40' : 'bg-border',
                )}
              />
            )}
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onStep(i)}
              className="group flex flex-col items-center gap-2 outline-none enabled:cursor-pointer disabled:cursor-default"
            >
              <span
                className={cn(
                  'relative z-10 grid size-8 place-items-center rounded-full border text-[13px] tabular-nums transition-colors',
                  current && 'border-primary bg-primary font-semibold text-primary-foreground',
                  done && 'border-primary/40 bg-card text-primary',
                  !done && !current && 'border-border bg-card text-muted-foreground',
                  reachable && 'group-hover:border-primary',
                )}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={cn(
                  'text-center text-xs leading-tight',
                  current ? 'font-semibold text-primary' : 'text-muted-foreground',
                )}
              >
                {label}
              </span>
            </button>
          </li>
        )
      })}
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
  tiers,
  pools,
  fromDate,
  toDate,
  rows,
  onAdd,
  onRemove,
}: {
  tiers: Tier[]
  pools: MenuPool[]
  fromDate: string
  toDate: string
  rows: FunctionRow[]
  onAdd: (spec: { name: string; eventDate: string; startTime: string; endTime: string; target: string; pax: number; tierId: string }) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [target, setTarget] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [pax, setPax] = useState('')
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
    setBusy(true)
    try {
      await onAdd({ name, eventDate: date, startTime: start, endTime: end, target, pax: Number(pax), tierId })
      // Carry the run of the event forward rather than blanking the form: the next function
      // usually follows straight on, on the same day, at the same head count and tier. Only
      // what genuinely differs each time is cleared. (Client: adding functions one by one
      // from scratch was tedious.)
      setName(''); setTarget(''); setFreeVenues(null)
      setStart(end); setEnd('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add function')
    } finally {
      setBusy(false)
    }
  }

  const venueItems = freeVenues ?? []
  // No price in the picker: the per-plate rate is internal and must not be quoted here
  // (client, 20 Jul 2026). It appears once, correctly surcharged, on Payment review.
  const tierItems = tiers.map((t) => ({ value: t.id, label: t.name }))

  return (
    <div className="space-y-4">
      {/* The functions read as a trail of their own — Haldi → Mehndi → Sangeet — so the run
          of the event is visible while it is being built, not just at review. Numbering
          follows date/time order, which is the order the server returns them in. */}
      {rows.length > 0 && (
        <ol className="space-y-0">
          {rows.map((r, i) => (
            <li key={r.id} className="relative flex gap-3 pb-3 text-sm last:pb-0">
              {i < rows.length - 1 && (
                <span aria-hidden className="absolute bottom-0 left-4 top-9 w-px bg-border" />
              )}
              <span className="relative z-10 grid size-8 shrink-0 place-items-center rounded-full border border-primary/40 bg-card text-[13px] font-medium tabular-nums text-primary">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-medium">{r.name}</span>{' '}
                  <span className="tabular-nums text-muted-foreground">
                    {r.eventDate} · {formatTimeRange(r.startTime, r.endTime)} · {r.venueLabel} · {r.pax} pax
                  </span>
                  <div className="text-xs text-muted-foreground">
                    {/* Tier only — no rate on the selection step (client, 20 Jul 2026). */}
                    {r.menu ? r.menu.tierName : 'No menu chosen'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpenMenu((o) => (o === r.id ? null : r.id))}
                  >
                    {openMenu === r.id ? 'Hide dishes' : 'Choose dishes'}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => onRemove(r.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              {/* The full picker for this function — dishes, swap, preferences, chef delicacy.
                  Everything in it saves itself, so a menu can be assembled over several days. */}
              {openMenu === r.id && (
                <div className="mt-3 rounded-lg border bg-muted/20 p-3">
                  <MenuPicker subEventId={r.id} tiers={tiers} pools={pools} canEdit />
                </div>
              )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-medium">
            {rows.length === 0 ? 'Add the first function' : `Add function ${rows.length + 1}`}
          </h4>
          {rows.length > 0 && (
            <span className="text-xs text-muted-foreground">
              Date, pax and menu carried over from {rows[rows.length - 1]!.name} — change anything that differs.
            </span>
          )}
        </div>

        {/* Quick-pick names for the usual run of an Indian wedding. Typing is still fine. */}
        {rows.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1">
            {SUGGESTED_FUNCTIONS.filter((s) => !rows.some((r) => r.name.toLowerCase() === s.toLowerCase())).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setName(s)}
                className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                + {s}
              </button>
            ))}
          </div>
        )}

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

        <Button className="mt-3 w-full sm:w-auto" onClick={add} disabled={busy || !windowSet || !target || !tierId}>Add function</Button>
      </div>
    </div>
  )
}

function RoomEditor({
  rooms,
  setRooms,
  roomRates,
  units,
  eventId,
  fromDate,
  toDate,
}: {
  rooms: RoomReq[]
  setRooms: (r: RoomReq[]) => void
  /** Per-lodge inventory: which categories each lodge actually holds (and at what rate). */
  roomRates: { unitId: string; roomType: string; rackRatePaise: number }[]
  units: { id: string; name: string }[]
  eventId: string | null
  fromDate: string
  toDate: string
}) {
  // Lodge + category + count + dates is the whole booking (client, 21 Jul 2026). No room
  // numbers: which actual room a guest gets is the reception desk's call, not this system's.
  //
  // Both limits the server enforces are mirrored here, so a manager is stopped at the input
  // rather than at the save: the dates are bounded by the event's own span, and the count is
  // bounded by what the lodge actually has free. The server still decides — this only saves
  // the round trip and the error toast.
  const latestCheckOut = toDate ? addDays(toDate, 1) : ''

  /** Availability keyed by ROW INDEX — two lines can share a shape (same lodge, category and
   *  dates) yet each takes real rooms, so a shared string key would collide and hide one. */
  const [free, setFree] = useState<Record<number, { available: number; total: number }>>({})
  const keyOf = (r: RoomReq) => `${r.unit_id}|${r.room_type}|${r.check_in}|${r.check_out}|${r.count}`

  // Ask the server what is free whenever a line is complete. Debounced: the manager is still
  // typing, and every keystroke on the count would otherwise be a query. Counts ride along so
  // sibling lines of the same category compete for the same rooms (client, 22 Jul 2026).
  const complete = rooms.map((r, i) => ({ r, i })).filter(({ r }) => r.unit_id && r.room_type && r.check_in && r.check_out)
  const signature = complete.map(({ r }) => keyOf(r)).join(',')
  useEffect(() => {
    if (!complete.length) return
    const t = setTimeout(() => {
      api<{ lines: { available: number; total: number }[] }>('/rooms/availability', {
        method: 'POST',
        body: JSON.stringify({
          event_id: eventId ?? undefined,
          lines: complete.map(({ r }) => ({
            unit_id: r.unit_id, room_type: r.room_type,
            count: Number.isInteger(r.count) && r.count > 0 ? r.count : 0,
            check_in: r.check_in, check_out: r.check_out,
          })),
        }),
      })
        .then((res) => {
          const next: Record<number, { available: number; total: number }> = {}
          complete.forEach(({ i }, k) => {
            const l = res.lines[k]
            if (l) next[i] = { available: l.available, total: l.total }
          })
          setFree(next)
        })
        .catch(() => {
          // A failed lookup must not block the form — the save still enforces the cap.
          setFree({})
        })
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, eventId])

  /**
   * The categories a given lodge actually holds. Residency has deluxe and suite and no
   * dormitory; Regency has semi-deluxe where Palace does not. Offering one flat list let a
   * manager book "Residency dormitory", which does not exist — the save then failed on the
   * inventory cap with a message about rooms being unavailable, when the truth is there is
   * no such room to be unavailable.
   */
  const typesFor = (unitId: string) =>
    [...new Set(roomRates.filter((r) => r.unitId === unitId).map((r) => r.roomType))].sort()

  const add = () => {
    const unitId = units[0]?.id ?? ''
    setRooms([
      ...rooms,
      // Pre-filled with the event's own dates: rooms almost always run the length of the
      // booking, and it is one fewer thing to get wrong.
      { unit_id: unitId, room_type: typesFor(unitId)[0] ?? '', count: 1, check_in: fromDate, check_out: latestCheckOut },
    ])
  }

  /** Changing lodge re-points the category, since the old one may not exist at the new lodge. */
  const changeUnit = (i: number, unitId: string) => {
    const types = typesFor(unitId)
    const cur = rooms[i]!.room_type
    update(i, { unit_id: unitId, room_type: types.includes(cur) ? cur : (types[0] ?? '') })
  }
  const update = (i: number, patch: Partial<RoomReq>) => setRooms(rooms.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => setRooms(rooms.filter((_, j) => j !== i))

  return (
    <div className="space-y-3">
      {rooms.length === 0 && <p className="text-sm text-muted-foreground">No rooms required. Add a line if the guest needs lodging.</p>}
      {rooms.map((r, i) => {
        const avail = free[i]
        const over = avail != null && r.count > avail.available
        return (
          <div key={i} className="space-y-1">
            {/* Not six equal columns: that gave a one-digit count the same width as
                "Presidential suite", which then had nowhere to go. Width follows what each
                field actually holds. One column on a phone, where everything is full width. */}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_4.5rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Select items={units.map((u) => ({ value: u.id, label: u.name }))} value={r.unit_id} onValueChange={(v) => changeUnit(i, v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Lodge" /></SelectTrigger>
                <SelectContent>{units.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent>
              </Select>
              {/* Only this lodge's categories — see typesFor. */}
              {/* The trigger reads from `items`, so the label is humanised there too — otherwise
                  the closed select showed `presidential_suite` where the open list showed
                  "presidential suite". */}
              <Select items={typesFor(r.unit_id).map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))} value={r.room_type} onValueChange={(v) => update(i, { room_type: v ?? '' })}>
                <SelectTrigger className="capitalize"><SelectValue /></SelectTrigger>
                <SelectContent>{typesFor(r.unit_id).map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, ' ')}</SelectItem>)}</SelectContent>
              </Select>
              <Input
                type="number"
                min={1}
                max={avail?.available || undefined}
                value={r.count}
                onChange={(e) => update(i, { count: Number(e.target.value) })}
                placeholder="Count"
                aria-invalid={over || undefined}
                className={over ? 'border-destructive' : undefined}
              />
              {/* Bounded by the event: check-in cannot precede the first function, and
                  check-out reaches at most the morning after the last. */}
              <Input
                type="date"
                min={fromDate || undefined}
                max={toDate || undefined}
                value={r.check_in}
                onChange={(e) => update(i, { check_in: e.target.value })}
              />
              <Input
                type="date"
                min={r.check_in ? addDays(r.check_in, 1) : fromDate || undefined}
                max={latestCheckOut || undefined}
                value={r.check_out}
                onChange={(e) => update(i, { check_out: e.target.value })}
              />
              <Button variant="ghost" size="icon" onClick={() => remove(i)}><Trash2 className="size-4" /></Button>
            </div>
            {avail && (
              <p className={cn('text-xs', over ? 'text-destructive' : 'text-muted-foreground')}>
                {over
                  ? `Only ${avail.available} of ${avail.total} ${r.room_type.replace(/_/g, ' ')} free at this lodge on these dates.`
                  : `${avail.available} of ${avail.total} free on these dates.`}
              </p>
            )}
          </div>
        )
      })}
      <Button variant="outline" size="sm" onClick={add}>Add room requirement</Button>
    </div>
  )
}

/** `date` shifted by whole days, staying in YYYY-MM-DD. UTC so a timezone cannot shift it. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
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
  roomsTaxPaise,
  functions,
  rooms,
  roomRates,
  lodgingUnits,
  alreadyConfirmed,
  onBack,
  onConfirmed,
  onDone,
  onDiscountChanged,
}: {
  eventId: string
  quote: Quote | null
  foodTotalPaise: number
  roomsTotalPaise: number
  roomsTaxPaise: number
  functions: FunctionRow[]
  rooms: RoomReq[]
  roomRates: { unitId: string; roomType: string; rackRatePaise: number }[]
  lodgingUnits: { id: string; name: string }[]
  // An Authority editing an already-confirmed booking: edits save as they're made, so there's
  // no advance to collect and nothing to re-confirm — the step just closes.
  alreadyConfirmed: boolean
  onBack: () => void
  onConfirmed: (code: string, shortfallPaise: number) => void
  onDone: () => void
  onDiscountChanged: () => void
}) {
  const [amount, setAmount] = useState('')
  // Whether the manager has typed their own figure. Until they do, the field follows the
  // required advance.
  //
  // It used to prefill once (`!amount`) and then never move again, so adding rooms or a
  // discount left the old number sitting there while the line above it said something else —
  // 35 rooms took the requirement from ₹11.6L to ₹13L and the field still read ₹11.6L. Confirm
  // refuses that with a 402, which is the system working, but the manager is looking at a
  // plausible number with no clue why it was rejected. A figure they typed themselves is left
  // alone: part-payments happen, and the quote moving is not a reason to overwrite what they
  // actually collected.
  const [amountEdited, setAmountEdited] = useState(false)
  const [mode, setMode] = useState('upi')
  const [receipt, setReceipt] = useState('')
  const [receivedOn, setReceivedOn] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (quote && !amountEdited) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAmount(String(quote.advanceRequiredPaise / 100))
    }
  }, [quote, amountEdited])

  async function confirm() {
    if (!receipt.trim() || !receivedOn) return toast.error('Enter the receipt number and date')
    setBusy(true)
    try {
      const { event } = await api<{ event: { code: string; advanceShortfallPaise: number } }>(`/events/${eventId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          advance: { amount_paise: rupeesToPaise(Number(amount)), mode, receipt_no: receipt, received_on: receivedOn },
        }),
      })
      onConfirmed(event.code, event.advanceShortfallPaise)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Confirmation failed')
    } finally {
      setBusy(false)
    }
  }

  // Rooms grouped by lodge so the estimate reads lodge-by-lodge, each with its own sub-total
  // (client, 23 Jul 2026). First-appearance order is preserved so the review mirrors the editor.
  const roomGroups = (() => {
    const order: string[] = []
    const byUnit: Record<string, { r: RoomReq; i: number }[]> = {}
    rooms.forEach((r, i) => {
      if (!byUnit[r.unit_id]) {
        byUnit[r.unit_id] = []
        order.push(r.unit_id)
      }
      byUnit[r.unit_id].push({ r, i })
    })
    return order.map((unitId) => ({
      unitId,
      lodgeName: lodgingUnits.find((u) => u.id === unitId)?.name,
      lines: byUnit[unitId],
    }))
  })()

  const grossPaise = quote ? quote.totalPaise + foodTotalPaise + roomsTotalPaise + roomsTaxPaise : 0
  // What is actually being collected right now, so the form can say how far short it falls.
  const amountPaise = Number.isFinite(Number(amount)) ? Math.round(Number(amount) * 100) : 0

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
                {/* Every function spelled out — venue, menu, pax and the arithmetic — so the
                    total can be checked line by line rather than taken on trust. */}
                {functions.map((f) => {
                  const venuePaise = quote.lines.find((l) => l.subEventId === f.id)?.ratePaise ?? null
                  const foodPaise = (f.menu?.perPlatePaise ?? 0) * f.pax
                  return (
                    <Fragment key={f.id}>
                      <tr className="bg-muted/40">
                        <td colSpan={2} className="px-3 py-1.5 text-xs font-semibold">
                          {f.name}
                          <span className="ml-2 font-normal tabular-nums text-muted-foreground">
                            {f.eventDate} · {formatTimeRange(f.startTime, f.endTime)} · {f.pax} pax
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2">Venue — {f.venueLabel}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {venuePaise == null ? <span className="text-destructive">no rate</span> : formatPaise(venuePaise)}
                        </td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2">
                          {/* Guard the per-plate rate: a menu whose price hasn't come back
                              yet must degrade to "no menu", never crash the whole review
                              step through formatPaise(undefined). */}
                          {f.menu && Number.isFinite(f.menu.perPlatePaise)
                            ? `Food — ${f.menu.tierName}, ${f.pax} pax × ${formatPaise(f.menu.perPlatePaise)}/plate`
                            : `Food — no menu chosen yet (${f.pax} pax)`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPaise(foodPaise)}</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{f.name} sub-total</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                          {formatPaise((venuePaise ?? 0) + foodPaise)}
                        </td>
                      </tr>
                    </Fragment>
                  )
                })}

                {rooms.length > 0 && (
                  <>
                    <tr className="bg-muted/40">
                      <td colSpan={2} className="px-3 py-1.5 text-xs font-semibold">Rooms</td>
                    </tr>
                    {roomGroups.map((g) => {
                      const groupSubtotal = g.lines.reduce((sum, { r }) => {
                        const rate = roomRates.find((x) => x.unitId === r.unit_id && x.roomType === r.room_type)?.rackRatePaise ?? 0
                        return sum + rate * Math.max(0, r.count) * nightsBetween(r.check_in, r.check_out)
                      }, 0)
                      return (
                        <Fragment key={g.unitId || 'no-lodge'}>
                          <tr>
                            <td colSpan={2} className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                              {g.lodgeName ?? 'Lodge'}
                            </td>
                          </tr>
                          {g.lines.map(({ r, i }) => {
                            const rate = roomRates.find((x) => x.unitId === r.unit_id && x.roomType === r.room_type)?.rackRatePaise ?? 0
                            const nights = nightsBetween(r.check_in, r.check_out)
                            return (
                              <tr key={`${r.room_type}-${i}`}>
                                <td className="px-3 py-2 pl-6">
                                  <span className="capitalize">{r.room_type.replace(/_/g, ' ')}</span>
                                  {' — '}{r.count} room{r.count === 1 ? '' : 's'} × {nights} night{nights === 1 ? '' : 's'} × {formatPaise(rate)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {formatPaise(rate * Math.max(0, r.count) * nights)}
                                </td>
                              </tr>
                            )
                          })}
                          <tr>
                            <td className="px-3 py-2 pl-6 text-xs text-muted-foreground">{g.lodgeName ?? 'Lodge'} sub-total</td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{formatPaise(groupSubtotal)}</td>
                          </tr>
                        </Fragment>
                      )
                    })}
                    <tr>
                      <td className="px-3 py-2 text-muted-foreground">Tax — 5% on rooms</td>
                      <td className="px-3 py-2 text-right tabular-nums">+ {formatPaise(roomsTaxPaise)}</td>
                    </tr>
                  </>
                )}
                <tr>
                  <td className="px-3 py-2">Estimated total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(grossPaise)}</td>
                </tr>
                {quote.discountPaise > 0 && (
                  <tr className="text-emerald-700 dark:text-emerald-400">
                    <td className="px-3 py-2">Less discounts</td>
                    <td className="px-3 py-2 text-right tabular-nums">− {formatPaise(quote.discountPaise)}</td>
                  </tr>
                )}
                {/* The two totals, in the order they have to be read. The bold one is what we
                    collect; the 18% below it is printed on the guest's proposal and charged to
                    nobody (client, 4 Aug 2026). Showing only the bigger figure is how a
                    counter ends up taking 18% too much. */}
                <tr className="font-medium">
                  <td className="px-3 py-2">Amount payable</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(quote.payablePaise)}</td>
                </tr>
                <tr className="text-muted-foreground">
                  <td className="px-3 py-2">GST 18% — shown on the proposal, not collected</td>
                  <td className="px-3 py-2 text-right tabular-nums">+ {formatPaise(quote.shownGstPaise)}</td>
                </tr>
                <tr className="text-muted-foreground">
                  <td className="px-3 py-2">Total printed on the proposal</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(quote.displayTotalPaise)}</td>
                </tr>
                <tr className="text-muted-foreground">
                  <td className="px-3 py-2">Advance required (25% of the amount payable)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPaise(quote.advanceRequiredPaise)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Rooms are a rack-rate estimate until they are allocated. Every instalment is a
            percentage of the amount payable, never of the printed total.
          </p>

          {/* Per-head percentage discounts — applied here so the total and the 25% advance
              reflect them before you confirm (client, 25 Jul 2026). */}
          <div className="rounded-lg border p-3">
            <EventDiscounts eventId={eventId} editable onChanged={onDiscountChanged} />
          </div>

          {alreadyConfirmed ? (
            <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              Already confirmed. Edits save as you make them and the venue holds move with the
              functions. No advance is collected here.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Advance received (₹)">
                <Input
                  type="number"
                  value={amount}
                  onChange={(e) => { setAmountEdited(true); setAmount(e.target.value) }}
                />
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
                <Input type="date" max={todayISO()} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
              </Field>
              {/* A guest who brings part of the advance is no longer turned away (client's lead,
                  4 Aug 2026). Said here, at the field, because this is where a manager decides
                  whether to argue with the guest or take what is on the table. */}
              {quote && amountPaise > 0 && amountPaise < quote.advanceRequiredPaise && (
                <p className="sm:col-span-2 lg:col-span-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  This is {formatPaise(quote.advanceRequiredPaise - amountPaise)} short of the 25%
                  ({formatPaise(quote.advanceRequiredPaise)}). The dates will still be held — the
                  booking confirms and shows as <span className="font-medium">Downpayment due</span> on
                  the calendar until the rest arrives.
                </p>
              )}
            </div>
          )}
        </>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button>
        {alreadyConfirmed ? (
          <Button onClick={onDone} disabled={busy}>Save &amp; finish</Button>
        ) : (
          <Button onClick={confirm} disabled={busy || !quote || quote.missing.length > 0}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            Confirm proposal
          </Button>
        )}
      </div>
    </StepCard>
  )
}
