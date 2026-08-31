'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, ChevronDown, MapPin, Pencil, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { formatTimeRange } from '@/lib/time'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { MenuPicker, type CatalogTier, type MenuPool } from '@/components/menu-picker'
import { EventRooms } from '@/components/event-rooms'
import { EventBilling } from '@/components/event-billing'
import { EventMaintenance } from '@/components/event-maintenance'
import { EventLodgeExtras } from '@/components/event-lodge-extras'
import { EventExtraPlates } from '@/components/event-extra-plates'
import { RequestChange } from '@/components/request-change'
import { CancelBooking } from '@/components/cancel-booking'
import { FunctionEdit } from '@/components/function-edit'
import { BookingBasicsEdit } from '@/components/booking-basics-edit'
import { EventLockInvoice } from '@/components/event-lock-invoice'
import { EventTrail } from '@/components/event-trail'
import { titleCase } from '@/lib/text'

type SubEvent = {
  id: string
  name: string
  eventDate: string
  startTime: string
  endTime: string
  // The ids as well as the names: `loadEventDetail` has always returned them, and the in-place
  // editor needs them to pre-select the venue the function already has.
  venueId: string | null
  bundleId: string | null
  venueName: string | null
  bundleName: string | null
  pax: number
}
export type EventDetail = {
  id: string
  code: string
  guestName: string
  eventType: string
  status: string
  firstDate: string | null
  lastDate: string | null
  /** The proposal's declared run (migration 0018) — what the room dates are bounded by. */
  plannedFrom: string | null
  plannedTo: string | null
  proposalTotalPaise: number
  subEvents: SubEvent[]
  contacts: { phone: string; label: string | null }[]
  documents: { kind: string }[]
  payments: { kind: string; amountPaise: number; receiptNo: string }[]
}

/**
 * The header's money. `proposal_total_paise` is venue + food + add-ons and always was, so
 * a booking with lodging on it showed a figure the guest had never been quoted (client,
 * 31 Aug 2026). Both, never one (rule 11): `payablePaise` is what is collected — rooms and
 * their 5%/18% included — and `displayTotalPaise` is that plus the 18% the proposal prints
 * and nobody pays.
 */
export type EventTotals = { payablePaise: number; displayTotalPaise: number }

const STATUS_STYLES: Record<string, string> = {
  enquiry: 'bg-muted text-muted-foreground',
  confirmed: 'bg-[var(--chart-2)]/15 text-[var(--chart-5)] dark:text-[var(--chart-2)]',
  in_progress: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

export function EventDetailView({
  initial,
  initialTotals,
  canViewMenus,
  canEditMenus,
  canViewRooms,
  canEditRooms,
  canViewBilling,
  canEditBilling,
  canViewMaintenance,
  canEditMaintenance,
  canViewUtensils,
  canEditUtensils,
  canEditBookings,
  canViewAudit,
  role,
  isAuditor,
}: {
  initial: EventDetail
  initialTotals: EventTotals
  canViewMenus: boolean
  canEditMenus: boolean
  canViewRooms: boolean
  canEditRooms: boolean
  canViewBilling: boolean
  canEditBilling: boolean
  canViewMaintenance: boolean
  canEditMaintenance: boolean
  canViewUtensils: boolean
  canEditUtensils: boolean
  canEditBookings: boolean
  canViewAudit: boolean
  role: string
  isAuditor: boolean
}) {
  const [event, setEvent] = useState(initial)
  const [totals, setTotals] = useState(initialTotals)
  // Which function's in-place editor is open. One at a time: two half-edited functions on one
  // screen is how the wrong one gets saved.
  const [editingFn, setEditingFn] = useState<string | null>(null)
  /**
   * Which function cards are folded shut (client, 17 Aug 2026). A wedding runs to five or six
   * functions and each one carries a whole tier picker, so the page was thousands of pixels of
   * checkboxes and the next function to fill was never on screen.
   *
   * A booking with ONE function opens flat, as it always did — there is nothing to scroll past.
   * From two upwards everything starts shut, so the run of functions is visible at a glance and
   * one is opened at a time. Ids, not indexes: adding a function must not shuffle what is open.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(initial.subEvents.length > 1 ? initial.subEvents.map((s) => s.id) : []),
  )
  const toggleCollapsed = useCallback((id: string, open?: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (open ?? next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const [editingBasics, setEditingBasics] = useState(false)
  const [tiers, setTiers] = useState<CatalogTier[] | null>(null)
  const [pools, setPools] = useState<MenuPool[]>([])

  useEffect(() => {
    if (!canViewMenus) return
    api<{ tiers: CatalogTier[]; pools: MenuPool[] }>('/menu/catalog')
      .then((r) => {
        setTiers(r.tiers)
        setPools(r.pools ?? [])
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load menu catalog'))
  }, [canViewMenus])

  // After a menu, room or price change, refresh the header's money. The quote endpoint
  // rather than `/events/:id`, because the card no longer shows a column off the events
  // row: it shows the payable and the printed total, which is what the quote returns. Same
  // `bookings: view` gate as this page, so anyone who can read the card can refresh it.
  const refreshTotal = useCallback(async () => {
    try {
      const r = await api<{ payablePaise: number; displayTotalPaise: number }>(
        `/events/${event.id}/quote`,
      )
      setTotals({ payablePaise: r.payablePaise, displayTotalPaise: r.displayTotalPaise })
    } catch {
      /* header total is cosmetic; ignore a refresh miss */
    }
  }, [event.id])

  // After editing a function, the whole record is reloaded rather than the total alone: the
  // date, time, venue and pax on the card all moved, and so may the event's own first/last
  // dates. A miss here is not cosmetic, so it surfaces.
  const refreshEvent = useCallback(async () => {
    const r = await api<{ event: EventDetail }>(`/events/${event.id}`)
    setEvent(r.event)
    await refreshTotal()
  }, [event.id, refreshTotal])

  const advancePaid = event.payments
    .filter((p) => p.kind === 'advance_block' || p.kind === 'part_payment')
    .reduce((s, p) => s + p.amountPaise, 0)

  // KYC is optional and added whenever the guest brings it (client, 22 Jul 2026) — including
  // after the booking is confirmed. It stays editable until the booking is locked or cancelled.
  const kycEditable =
    canEditBookings && !['locked', 'billed', 'closed', 'cancelled'].includes(event.status)

  // The Higher Authority and Auditor may reopen a CONFIRMED booking in the wizard (tester,
  // 23 Jul 2026); everyone else's post-confirm changes go through the change-request flow.
  const isAuthority = role === 'higher_authority' || isAuditor

  // Everything on a proposal is editable in place until it is confirmed (client, 15 Aug 2026).
  // After that a function is a held venue slot and moves through the change-request flow.
  const isEnquiry = event.status === 'enquiry'

  async function uploadDoc(kind: 'aadhaar_front' | 'aadhaar_back', file: File) {
    try {
      const fd = new FormData()
      fd.append('kind', kind)
      fd.append('file', file)
      const res = await fetch(`/api/v1/events/${event.id}/documents`, { method: 'POST', body: fd })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message ?? 'Upload failed')
      }
      // Reflect the new document without a round trip; the row replaces any of the same kind.
      setEvent((e) => ({ ...e, documents: [...e.documents.filter((d) => d.kind !== kind), { kind }] }))
      toast.success(`${kind === 'aadhaar_front' ? 'Aadhaar front' : 'Aadhaar back'} saved`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tabular-nums">{event.code}</h1>
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[event.status] ?? STATUS_STYLES.enquiry}`}
            >
              {event.status.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">
            {titleCase(event.guestName)} · <span>{titleCase(event.eventType)}</span>
            {event.firstDate && (
              <>
                {' '}
                · {event.firstDate}
                {event.lastDate && event.lastDate !== event.firstDate ? ` → ${event.lastDate}` : ''}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {/* What the guest owes, rooms and their GST included — not `proposal_total_paise`,
              which is venue + food + add-ons and left the whole lodging charge off the one
              figure most people on this page read (client, 31 Aug 2026).

              Amount payable leads because it is what a counter collects and what staff quote
              (see the manual); the printed Total sits under it because a document carries
              both and showing one alone is how 18% too much gets taken (rule 11). This is a
              staff screen, so the shown-not-collected 18% is spelt out in words — on a
              guest-facing document it never is. */}
          <Card className="min-w-64">
            <CardContent className="space-y-1 py-3">
              <div className="text-xs text-muted-foreground">Amount payable</div>
              <div className="text-xl font-semibold tabular-nums">{formatPaise(totals.payablePaise)}</div>
              <div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
                <span>Total</span>
                <span className="tabular-nums">{formatPaise(totals.displayTotalPaise)}</span>
              </div>
              <div className="text-xs leading-snug text-muted-foreground">
                The difference is the 18% GST shown on the proposal and collected from nobody.
              </div>
              {advancePaid > 0 && (
                <div className="text-xs text-muted-foreground tabular-nums">
                  Advance recorded: {formatPaise(advancePaid)}
                </div>
              )}
            </CardContent>
          </Card>
          {/* An enquiry isn't blocked yet — reopen the wizard to keep building it toward the
              25% confirm. Everything stays editable until then. */}
          {event.status === 'enquiry' && canEditBookings && (
            <Link href={`/bookings/${event.id}/edit`} className={buttonVariants({ size: 'sm' })}>
              Continue proposal →
            </Link>
          )}
          {event.status === 'confirmed' && isAuthority && (
            <Link href={`/bookings/${event.id}/edit`} className={buttonVariants({ size: 'sm' })}>
              Edit booking →
            </Link>
          )}
          {/* The proposal Draft prints at any stage — an enquiry (Draft) or a confirmed
              booking (Draft 2). Save-as-PDF from the print dialog produces the shareable file. */}
          <Link href={`/bookings/${event.id}/proforma`} className="text-sm text-primary hover:underline">
            Print Draft →
          </Link>
          {/* Last in the column and unstyled until opened: cancelling is rare, destructive, and
              releases the dates to whoever asks next. It is also the GM's remedy when a
              part-paid booking never completes its advance (client's lead, 4 Aug 2026). */}
          <CancelBooking
            eventId={event.id}
            code={event.code}
            status={event.status}
            canCancel={canEditBookings}
          />
        </div>
      </div>

      {/* Guest, contacts and the declared run — editable in place while it is an enquiry. */}
      {isEnquiry && canEditBookings && editingBasics && (
        <BookingBasicsEdit
          eventId={event.id}
          guestName={event.guestName}
          contacts={event.contacts}
          plannedFrom={event.plannedFrom}
          plannedTo={event.plannedTo}
          onSaved={async () => {
            await refreshEvent()
            setEditingBasics(false)
          }}
          onCancel={() => setEditingBasics(false)}
        />
      )}

      {/* At-a-glance meta */}
      <div className="grid gap-3 sm:grid-cols-3">
        <MetaCard title="Contacts">
          {isEnquiry && canEditBookings && !editingBasics && (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 mb-1 h-7"
              onClick={() => setEditingBasics(true)}
            >
              <Pencil className="size-3" /> Guest &amp; contacts
            </Button>
          )}
          {event.contacts.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <ul className="space-y-0.5">
              {event.contacts.map((c) => (
                <li key={c.phone} className="tabular-nums">
                  {c.phone}
                  {c.label && <span className="text-muted-foreground"> · {c.label}</span>}
                </li>
              ))}
            </ul>
          )}
        </MetaCard>
        <MetaCard title="KYC">
          <div className="space-y-1.5">
            {(['aadhaar_front', 'aadhaar_back'] as const).map((k) => {
              const present = event.documents.some((d) => d.kind === k)
              return (
                <div key={k} className="flex items-center justify-between gap-2">
                  <Badge variant="outline" className={present ? 'text-emerald-600' : 'text-muted-foreground'}>
                    {k.replace('aadhaar_', 'Aadhaar ')}
                    {present ? ' ✓' : ' —'}
                  </Badge>
                  {/* Add or replace the image after the fact — KYC is no longer a confirm gate. */}
                  {kycEditable && (
                    <label className="cursor-pointer text-xs text-primary hover:underline">
                      {present ? 'Replace' : 'Upload'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          e.target.value = ''
                          if (f) void uploadDoc(k, f)
                        }}
                      />
                    </label>
                  )}
                </div>
              )
            })}
          </div>
        </MetaCard>
        <MetaCard title="Functions">
          <span className="tabular-nums">{event.subEvents.length}</span>
          <span className="text-muted-foreground"> scheduled</span>
        </MetaCard>
      </div>

      <Separator />

      {/* Functions with menus */}
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Functions &amp; menus</h2>
          {event.subEvents.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setCollapsed(
                  collapsed.size === 0 ? new Set(event.subEvents.map((s) => s.id)) : new Set(),
                )
              }
            >
              {collapsed.size === 0 ? 'Collapse all' : 'Expand all'}
            </Button>
          )}
        </div>
        {event.subEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No functions on this event yet.</p>
        ) : (
          event.subEvents.map((s) => {
          const open = !collapsed.has(s.id)
          return (
            <Card key={s.id}>
              <CardHeader className={open ? 'pb-3' : undefined}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* The title is the handle. A whole-header click would swallow the Edit
                      button beside it, and the meta line has to stay selectable. */}
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleCollapsed(s.id)}
                    className="-ml-1 flex items-center gap-1.5 rounded px-1 text-left hover:bg-muted/60"
                  >
                    <ChevronDown
                      className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
                      aria-hidden
                    />
                    <CardTitle>{titleCase(s.name)}</CardTitle>
                  </button>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1 tabular-nums">
                      <CalendarDays className="size-3.5" />
                      {s.eventDate} · {formatTimeRange(s.startTime, s.endTime)}
                    </span>
                    <span className="flex items-center gap-1">
                      <MapPin className="size-3.5" />
                      {s.venueName ?? s.bundleName ?? '—'}
                    </span>
                    <span className="flex items-center gap-1 tabular-nums">
                      <Users className="size-3.5" />
                      {s.pax}
                    </span>
                    {/* Enquiry only. A confirmed function is a held venue slot: it moves
                        through the change-request flow below, or the Authority's editor. */}
                    {isEnquiry && canEditBookings && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const next = editingFn === s.id ? null : s.id
                          setEditingFn(next)
                          // Editing a folded function has to unfold it, or the form opens
                          // inside a card that is not showing its body.
                          if (next) toggleCollapsed(s.id, true)
                        }}
                      >
                        <Pencil className="size-3.5" /> {editingFn === s.id ? 'Close' : 'Edit'}
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              {open && (
              <CardContent>
                {isEnquiry && canEditBookings && editingFn === s.id && (
                  <div className="mb-3">
                    <FunctionEdit
                      fn={{
                        id: s.id,
                        name: s.name,
                        eventDate: s.eventDate,
                        startTime: s.startTime,
                        endTime: s.endTime,
                        venueId: s.venueId,
                        bundleId: s.bundleId,
                        pax: s.pax,
                      }}
                      onSaved={async () => {
                        await refreshEvent()
                        setEditingFn(null)
                      }}
                      onCancel={() => setEditingFn(null)}
                    />
                  </div>
                )}
                {!canViewMenus ? (
                  <p className="text-sm text-muted-foreground">You don’t have access to menus.</p>
                ) : !tiers ? (
                  <p className="text-sm text-muted-foreground">Loading menu…</p>
                ) : (
                  <MenuPicker
                    subEventId={s.id}
                    tiers={tiers}
                    pools={pools}
                    canEdit={canEditMenus}
                    onChanged={refreshTotal}
                  />
                )}
                {canEditBookings && ['confirmed', 'in_progress'].includes(event.status) && (
                  <div className="mt-3 border-t pt-3">
                    <RequestChange sub={{ id: s.id, eventDate: s.eventDate, startTime: s.startTime, endTime: s.endTime, venueName: s.venueName }} />
                  </div>
                )}
              </CardContent>
              )}
            </Card>
          )
          })
        )}
      </div>

      {canViewRooms && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Rooms &amp; lodging</h2>
            {/* Editable on an enquiry too (client, 15 Aug 2026). This used to read "Rooms can
                be allocated once the booking is confirmed", which was wrong on both counts:
                the requirements ARE the booking (rule 9) and the wizard has always captured
                them at step 4 on an enquiry. The service allowed it all along; only this
                screen refused to show it. An enquiry still HOLDS nothing — whoever confirms
                first takes the rooms — which is what the panel says while it is one. */}
            <EventRooms
              eventId={event.id}
              editable={
                canEditRooms &&
                ['enquiry', 'confirmed', 'in_progress', 'completed'].includes(event.status)
              }
              onChanged={refreshTotal}
            />
            {isEnquiry && (
              <p className="text-sm text-muted-foreground">
                An enquiry holds no rooms — whoever confirms first takes them.
              </p>
            )}
          </div>
        </>
      )}

      {/* Extras the lodge gave out during the event (15 Aug 2026). Same window as maintenance:
          there is nothing to log before the guest arrives, and the log is read-only after lock. */}
      {canViewRooms && ['in_progress', 'completed', 'locked', 'billed', 'closed'].includes(event.status) && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Lodge extras</h2>
            <EventLodgeExtras
              eventId={event.id}
              editable={canEditRooms && ['in_progress', 'completed'].includes(event.status)}
            />
          </div>
        </>
      )}

      {/* Plates issued on the day (15 Aug 2026). Same window as maintenance and lodge extras. */}
      {canViewUtensils && ['in_progress', 'completed', 'locked', 'billed', 'closed'].includes(event.status) && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Extra plates</h2>
            <EventExtraPlates
              eventId={event.id}
              editable={canEditUtensils && ['in_progress', 'completed'].includes(event.status)}
            />
          </div>
        </>
      )}

      {canViewMaintenance && ['in_progress', 'completed', 'locked', 'billed', 'closed'].includes(event.status) && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Maintenance</h2>
            <EventMaintenance
              eventId={event.id}
              editable={canEditMaintenance && ['in_progress', 'completed'].includes(event.status)}
            />
          </div>
        </>
      )}

      {canViewBilling && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Billing</h2>
            {event.status === 'enquiry' ? (
              <p className="text-sm text-muted-foreground">
                Discounts and payments open once the booking is confirmed.
              </p>
            ) : (
              <EventBilling
                eventId={event.id}
                editable={canEditBilling && !['locked', 'billed', 'closed'].includes(event.status)}
                onChanged={refreshTotal}
              />
            )}
          </div>
        </>
      )}

      {canViewBilling && ['completed', 'locked', 'billed', 'closed'].includes(event.status) && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Lock &amp; payment review</h2>
            <EventLockInvoice eventId={event.id} role={role} isAuditor={isAuditor} />
          </div>
        </>
      )}

      {canViewAudit && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Audit trail</h2>
            <EventTrail eventId={event.id} />
          </div>
        </>
      )}
    </div>
  )
}

function MetaCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-3 text-sm">
        <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
        {children}
      </CardContent>
    </Card>
  )
}
