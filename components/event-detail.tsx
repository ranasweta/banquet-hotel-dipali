'use client'

import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, MapPin, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { MenuPicker, type CatalogTier } from '@/components/menu-picker'
import { EventRooms } from '@/components/event-rooms'
import { EventBilling } from '@/components/event-billing'

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
  enquiry: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
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
}: {
  initial: EventDetail
  canViewMenus: boolean
  canEditMenus: boolean
  canViewRooms: boolean
  canEditRooms: boolean
  canViewBilling: boolean
  canEditBilling: boolean
}) {
  const [event, setEvent] = useState(initial)
  const [tiers, setTiers] = useState<CatalogTier[] | null>(null)

  useEffect(() => {
    if (!canViewMenus) return
    api<{ tiers: CatalogTier[] }>('/menu/catalog')
      .then((r) => setTiers(r.tiers))
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
            {event.guestName} · <span className="capitalize">{event.eventType.replace(/_/g, ' ')}</span>
            {event.firstDate && (
              <>
                {' '}
                · {event.firstDate}
                {event.lastDate && event.lastDate !== event.firstDate ? ` → ${event.lastDate}` : ''}
              </>
            )}
          </p>
        </div>
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
          <div className="flex flex-wrap gap-1.5">
            {['aadhaar_front', 'aadhaar_back'].map((k) => (
              <Badge
                key={k}
                variant="outline"
                className={event.documents.some((d) => d.kind === k) ? 'text-emerald-600' : 'text-muted-foreground'}
              >
                {k.replace('aadhaar_', 'Aadhaar ')}
                {event.documents.some((d) => d.kind === k) ? ' ✓' : ' —'}
              </Badge>
            ))}
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
                  <CardTitle>{s.name}</CardTitle>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1 tabular-nums">
                      <CalendarDays className="size-3.5" />
                      {s.eventDate} · {s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}
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
                    canEdit={canEditMenus}
                    onChanged={refreshTotal}
                  />
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
