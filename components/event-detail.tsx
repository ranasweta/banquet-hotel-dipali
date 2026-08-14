'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, MapPin, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { formatTimeRange } from '@/lib/time'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
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
import { EventLockInvoice } from '@/components/event-lock-invoice'
import { EventTrail } from '@/components/event-trail'
import { titleCase } from '@/lib/text'

type SubEvent = {
  id: string
  name: string
  eventDate: string
  startTime: string
  endTime: string
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
  proposalTotalPaise: number
  subEvents: SubEvent[]
  contacts: { phone: string; label: string | null }[]
  documents: { kind: string }[]
  payments: { kind: string; amountPaise: number; receiptNo: string }[]
}

const STATUS_STYLES: Record<string, string> = {
  enquiry: 'bg-muted text-muted-foreground',
  confirmed: 'bg-[var(--chart-2)]/15 text-[var(--chart-5)] dark:text-[var(--chart-2)]',
  in_progress: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

export function EventDetailView({
  initial,
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

  // After a menu/add-on change, refresh the header proposal total.
  const refreshTotal = useCallback(async () => {
    try {
      const r = await api<{ event: { proposalTotalPaise: number } }>(`/events/${event.id}`)
      setEvent((e) => ({ ...e, proposalTotalPaise: r.event.proposalTotalPaise }))
    } catch {
      /* header total is cosmetic; ignore a refresh miss */
    }
  }, [event.id])

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
          <Card className="min-w-52">
            <CardContent className="py-3">
              <div className="text-xs text-muted-foreground">Proposal total</div>
              <div className="text-xl font-semibold tabular-nums">{formatPaise(event.proposalTotalPaise)}</div>
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

      {/* At-a-glance meta */}
      <div className="grid gap-3 sm:grid-cols-3">
        <MetaCard title="Contacts">
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
        <h2 className="text-lg font-semibold">Functions &amp; menus</h2>
        {event.subEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No functions on this event yet.</p>
        ) : (
          event.subEvents.map((s) => (
            <Card key={s.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>{titleCase(s.name)}</CardTitle>
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
                  </div>
                </div>
              </CardHeader>
              <CardContent>
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
            </Card>
          ))
        )}
      </div>

      {canViewRooms && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Rooms &amp; lodging</h2>
            {event.status === 'enquiry' ? (
              <p className="text-sm text-muted-foreground">
                Rooms can be allocated once the booking is confirmed.
              </p>
            ) : (
              <EventRooms
                eventId={event.id}
                editable={
                  canEditRooms &&
                  ['confirmed', 'in_progress', 'completed'].includes(event.status)
                }
              />
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
