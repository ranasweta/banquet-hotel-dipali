'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * The venue master (client, 12 Aug 2026). Halls, the bundles made out of them, and what each
 * costs per event type.
 *
 * The thing this screen has to make impossible to miss is the difference between a rate of
 * ZERO and NO RATE AT ALL. They look almost the same in a table and they behave nothing alike:
 * zero is a decision (the venue is sold, and it's free for that event type — which is exactly
 * how "an Other booking pays no hall charge" is stored), while an absent rate is a gate that
 * takes the venue off the standalone picker and blocks confirmation until the Authority
 * approves a manual rate. So zero prints as "Free" in words and an absent rate prints as
 * "Not priced" in amber, never as a blank cell or a dash.
 */

type Rate = { eventType: string; ratePaise: number; effectiveFrom: string; current: boolean }
type Venue = {
  id: string; name: string; propertyName: string; kind: string; isActive: boolean
  rates: Rate[]; bookings: number
}
type Bundle = {
  id: string; name: string; members: { id: string; name: string }[]; rates: Rate[]; bookings: number
}
type Catalog = {
  properties: { id: string; name: string }[]
  eventTypes: { code: string; displayName: string }[]
  venues: Venue[]
  bundles: Bundle[]
}

const today = () => new Date().toLocaleDateString('en-CA')

/** The rate in force for an event type, or undefined when nothing is priced (a gate). */
function inForce(rates: Rate[], eventType: string): Rate | undefined {
  return rates.find((r) => r.eventType === eventType && r.current)
}

export function VenueMaster({ canEdit, canDelete }: { canEdit: boolean; canDelete: boolean }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [newVenue, setNewVenue] = useState(false)
  const [newBundle, setNewBundle] = useState(false)

  const load = useCallback(async () => setCat(await api<Catalog>('/venue-master')), [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e: Error) => toast.error(e.message))
  }, [load])

  const run = useCallback(
    async (fn: () => Promise<unknown>, done: string) => {
      setBusy(true)
      try {
        await fn()
        await load()
        toast.success(done)
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'That did not work')
        return false
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  if (!cat) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the venues…
      </p>
    )
  }

  const byProperty = cat.properties.map((p) => ({
    ...p,
    venues: cat.venues.filter((v) => v.propertyName === p.name),
  }))

  return (
    <div className="space-y-6">
      <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <b className="text-foreground">Free is not the same as unpriced.</b> A rate of zero means the venue
        is sold and costs nothing for that event type — that is how an <b>Other</b> booking gets its hall
        free. A venue with <b>no</b> rate is not offered on its own at all, and any booking on it is blocked
        until the Higher Authority approves a manual rate.
      </p>

      {/* ── Venues ─────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Venues</h2>
          {canEdit && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setNewVenue((v) => !v)}>
              <Plus className="size-4" /> New venue
            </Button>
          )}
        </div>

        {newVenue && canEdit && (
          <NewVenueForm
            properties={cat.properties}
            busy={busy}
            onCancel={() => setNewVenue(false)}
            onSubmit={async (body) => {
              const okDone = await run(
                () => api('/venue-master/venues', { method: 'POST', body: JSON.stringify(body) }),
                `${body.name} added — set its rates below`,
              )
              if (okDone) setNewVenue(false)
            }}
          />
        )}

        {byProperty.map((p) => (
          <div key={p.id} className="rounded-lg border bg-card">
            <header className="border-b px-4 py-2 text-sm font-medium">{p.name}</header>
            <ul className="divide-y">
              {p.venues.length === 0 && (
                <li className="px-4 py-3 text-sm text-muted-foreground">No venues at this property.</li>
              )}
              {p.venues.map((v) => (
                <RateRow
                  key={v.id}
                  title={v.name}
                  subtitle={`${v.kind}${v.bookings ? ` · ${v.bookings} booking${v.bookings === 1 ? '' : 's'}` : ''}`}
                  retired={!v.isActive}
                  rates={v.rates}
                  eventTypes={cat.eventTypes}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  busy={busy}
                  target={{ venue_id: v.id }}
                  run={run}
                  onToggle={() =>
                    run(
                      () =>
                        api(`/venue-master/venues/${v.id}`, {
                          method: 'PUT',
                          body: JSON.stringify({ is_active: !v.isActive }),
                        }),
                      v.isActive ? `${v.name} retired` : `${v.name} restored`,
                    )
                  }
                />
              ))}
            </ul>
          </div>
        ))}
      </section>

      {/* ── Bundles ────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Bundles</h2>
          {canEdit && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setNewBundle((v) => !v)}>
              <Plus className="size-4" /> New bundle
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Booking a bundle holds every venue in it, and holding any one of them blocks the bundle.
          A bundle keeps its price for an <b>Other</b> booking — only standalone halls go free.
        </p>

        {newBundle && canEdit && (
          <NewBundleForm
            venues={cat.venues.filter((v) => v.isActive)}
            busy={busy}
            onCancel={() => setNewBundle(false)}
            onSubmit={async (body) => {
              const okDone = await run(
                () => api('/venue-master/bundles', { method: 'POST', body: JSON.stringify(body) }),
                `${body.name} added — set its rates below`,
              )
              if (okDone) setNewBundle(false)
            }}
          />
        )}

        <div className="rounded-lg border bg-card">
          <ul className="divide-y">
            {cat.bundles.map((b) => (
              <RateRow
                key={b.id}
                title={b.name}
                subtitle={`${b.members.map((m) => m.name).join(' + ')}${b.bookings ? ` · ${b.bookings} booking${b.bookings === 1 ? '' : 's'}` : ''}`}
                retired={false}
                rates={b.rates}
                eventTypes={cat.eventTypes}
                canEdit={canEdit}
                canDelete={canDelete}
                busy={busy}
                target={{ bundle_id: b.id }}
                run={run}
              />
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}

/** One venue or bundle, with its rate per event type and an inline editor for each. */
function RateRow({
  title, subtitle, retired, rates, eventTypes, canEdit, canDelete, busy, target, run, onToggle,
}: {
  title: string
  subtitle: string
  retired: boolean
  rates: Rate[]
  eventTypes: { code: string; displayName: string }[]
  canEdit: boolean
  canDelete: boolean
  busy: boolean
  target: { venue_id?: string; bundle_id?: string }
  run: (fn: () => Promise<unknown>, done: string) => Promise<boolean>
  onToggle?: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')

  return (
    <li className="px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={cn('font-medium', retired && 'text-muted-foreground line-through')}>{title}</span>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
        {retired && <Badge variant="outline" className="text-muted-foreground">retired</Badge>}
        {onToggle && canEdit && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            title={retired ? 'Offer it again' : 'Stop offering it'}
            onClick={onToggle}
          >
            {retired ? <RotateCcw className="size-3" /> : <Trash2 className="size-3" />}
          </Button>
        )}
      </div>

      {/* Two rates, not six: a booking can only be made as Wedding or Others (lib/event-types).
          Side by side rather than in a grid — with two of them a grid is just empty space. */}
      <div className="flex flex-wrap gap-x-8 gap-y-1">
        {eventTypes.map((et) => {
          const rate = inForce(rates, et.code)
          const isEditing = editing === et.code
          return (
            <div key={et.code} className="flex items-center gap-2 text-sm">
              <span className="w-24 shrink-0 truncate text-muted-foreground">{et.displayName}</span>
              {isEditing ? (
                <>
                  <Input
                    autoFocus
                    inputMode="decimal"
                    placeholder="₹"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="h-7 w-24"
                  />
                  <Button
                    size="xs"
                    disabled={busy || !(Number(value) >= 0) || value.trim() === ''}
                    onClick={async () => {
                      const done = await run(
                        () =>
                          api('/venue-master/rates', {
                            method: 'PUT',
                            body: JSON.stringify({
                              ...target,
                              event_type: et.code,
                              rate_paise: rupeesToPaise(Number(value)),
                              effective_from: today(),
                            }),
                          }),
                        `${title} · ${et.displayName} set to ${Number(value) === 0 ? 'free' : `₹${value}`}`,
                      )
                      if (done) setEditing(null)
                    }}
                  >
                    Save
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  {/* Three distinct states, each in words — never a bare 0 and never a blank. */}
                  {rate == null ? (
                    <span className="text-amber-600">Not priced</span>
                  ) : rate.ratePaise === 0 ? (
                    <span className="text-muted-foreground">Free</span>
                  ) : (
                    <span className="tabular-nums">{formatPaise(rate.ratePaise)}</span>
                  )}
                  {canEdit && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={busy}
                      title={`Set the ${et.displayName} rate`}
                      onClick={() => {
                        setValue(rate ? String(rate.ratePaise / 100) : '')
                        setEditing(et.code)
                      }}
                    >
                      <Pencil className="size-3" />
                    </Button>
                  )}
                  {canDelete && rate != null && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="text-destructive"
                      disabled={busy}
                      title="Remove the rate — the venue stops being offered for this event type"
                      onClick={() =>
                        run(
                          () =>
                            api('/venue-master/rates', {
                              method: 'DELETE',
                              body: JSON.stringify({ ...target, event_type: et.code }),
                            }),
                          `${title} · ${et.displayName} is no longer priced`,
                        )
                      }
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </li>
  )
}

/**
 * Property, name, hall-or-lawn. That is the whole of a venue.
 *
 * No capacity: it gates nothing (rule 13) and is shown nowhere, so asking for it collected two
 * numbers that did nothing — and a default of 1–100 would have invented seed data through the
 * back door (client, 13 Aug 2026: "why are u taking seats?").
 */
function NewVenueForm({
  properties, busy, onCancel, onSubmit,
}: {
  properties: { id: string; name: string }[]
  busy: boolean
  onCancel: () => void
  onSubmit: (body: { property_id: string; name: string; kind: string }) => void | Promise<void>
}) {
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('hall')

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-3">
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">Property</span>
        <select
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 w-56" />
      </label>
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">Kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="hall">hall</option>
          <option value="lawn">lawn</option>
        </select>
      </label>
      <Button
        size="sm"
        disabled={busy || !name.trim() || !propertyId}
        onClick={() => onSubmit({ property_id: propertyId, name: name.trim(), kind })}
      >
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
    </div>
  )
}

function NewBundleForm({
  venues, busy, onCancel, onSubmit,
}: {
  venues: { id: string; name: string; propertyName: string }[]
  busy: boolean
  onCancel: () => void
  onSubmit: (body: { name: string; venue_ids: string[] }) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  return (
    <div className="space-y-3 rounded-md border bg-muted/40 p-3">
      <label className="block text-sm">
        <span className="block text-xs text-muted-foreground">Bundle name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 w-64" />
      </label>
      <div>
        <span className="block text-xs text-muted-foreground">
          Venues in it — at least two, since one hall is not a bundle
        </span>
        <div className="mt-1 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {venues.map((v) => (
            <label key={v.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={picked.includes(v.id)} onChange={() => toggle(v.id)} />
              <span className="truncate">{v.name}</span>
              <span className="text-xs text-muted-foreground">{v.propertyName}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !name.trim() || picked.length < 2}
          onClick={() => onSubmit({ name: name.trim(), venue_ids: picked })}
        >
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}
