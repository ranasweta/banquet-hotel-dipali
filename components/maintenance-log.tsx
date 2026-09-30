'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EventMaintenance } from '@/components/event-maintenance'
import { cn } from '@/lib/utils'
import { titleCase } from '@/lib/text'

type EventRow = {
  id: string
  code: string
  guestName: string
  status: string
  firstDate: string | null
  entryCount: number
  closed: boolean
}

/**
 * The Maintenance team's own way in. Charges are logged against an event, but the team has no
 * Bookings access — the event page they'd otherwise need is closed to them — so this lists the
 * events they may log against (Confirmed / In Progress / Completed, FR-5.1) and opens the same
 * entry editor inline. Live events come first, then what is still to come, then what is done
 * and waiting on a close. A closed section is frozen and read-only (FR-5.2).
 */
export function MaintenanceLog({ canEdit }: { canEdit: boolean }) {
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await api<{ events: EventRow[] }>('/maintenance/events')
    setEvents(r.events)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load events'))
  }, [load])

  if (!events) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading events…
      </div>
    )
  }

  const live = events.filter((e) => e.status === 'in_progress')
  const upcoming = events.filter((e) => e.status === 'confirmed')
  const done = events.filter((e) => e.status === 'completed')

  return (
    <div className="space-y-6">
      <Section
        title="Live events"
        note="in progress — log as the work happens"
        rows={live}
        empty="No event is running right now."
        open={open}
        setOpen={setOpen}
        canEdit={canEdit}
      />
      {/* Confirmed but not started. A generator hired in, a repair, scaffolding on site — all
          arranged and paid for before the day, and until 30 Sep 2026 there was nowhere to put
          them until the morning of. */}
      <Section
        title="Upcoming events"
        note="confirmed — log what is arranged ahead of the day"
        rows={upcoming}
        empty="Nothing confirmed and still to come."
        open={open}
        setOpen={setOpen}
        canEdit={canEdit}
      />
      <Section
        title="Completed events"
        note="log what is left, then add it to the bill"
        rows={done}
        empty="Nothing completed and awaiting a close."
        open={open}
        setOpen={setOpen}
        canEdit={canEdit}
      />
    </div>
  )
}

function Section({
  title,
  note,
  rows,
  empty,
  open,
  setOpen,
  canEdit,
}: {
  title: string
  note: string
  rows: EventRow[]
  empty: string
  open: string | null
  setOpen: (id: string | null) => void
  canEdit: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="size-4 text-muted-foreground" aria-hidden />
          {title}
          <span className="text-sm font-normal text-muted-foreground">{note}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y">
            {rows.map((e) => (
              <li key={e.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium tabular-nums">{e.code}</span>{' '}
                    <span className="font-medium">{titleCase(e.guestName)}</span>
                    <div className="text-xs text-muted-foreground">
                      {e.firstDate ?? 'date TBD'} · {e.entryCount} {e.entryCount === 1 ? 'entry' : 'entries'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* What the guest will be charged, not what state the log is in. "open" in
                        green read as done and meant the opposite — money logged and not billed. */}
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        e.closed
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                          : e.entryCount > 0
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                            : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {e.closed ? 'on the bill' : e.entryCount > 0 ? 'not billed' : 'nothing logged'}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      {open === e.id ? 'Hide' : e.closed ? 'View charges' : 'Log charges'}
                    </Button>
                  </div>
                </div>
                {open === e.id && (
                  <div className="mt-3 rounded-lg border bg-muted/20 p-3">
                    {/* Same editor the event page uses — one implementation, two ways in. */}
                    <EventMaintenance eventId={e.id} editable={canEdit && !e.closed} />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {e.status === 'confirmed'
                        ? 'Charges go to the bill once the event starts — until then keep logging.'
                        : 'Adding to the bill charges these to the guest and freezes them — log everything first.'}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
