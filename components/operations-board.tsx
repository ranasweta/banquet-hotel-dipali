'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/http'

/**
 * The Banquet Manager's board and the Chef's day view: what is happening, for how many
 * people, and exactly what goes out of the kitchen — with no money on it at all.
 *
 * Money is absent from the payload, not hidden here (see lib/daysheet.ts). Nothing in this
 * file could show a rupee even if it wanted to.
 */

type Dish = { name: string; note: string | null; isExtra: boolean }
type Fn = {
  subEventId: string
  date: string
  eventCode: string
  guestName: string
  eventType: string
  name: string
  startTime: string
  endTime: string
  pax: number
  paxOverrideNote: string | null
  venueName: string | null
  tierName: string | null
  menuComplete: boolean
  segments: { name: string; dishes: Dish[] }[]
  chefDishes: string[]
  addons: { description: string; qty: number }[]
}
type Day = { date: string; isToday: boolean; functions: Fn[] }

function hhmm(t: string) {
  return t.slice(0, 5)
}
function dayLabel(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function OperationsBoard({ days = 15 }: { days?: number }) {
  const [data, setData] = useState<Day[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ days: Day[] }>(`/calendar/horizon?days=${days}`)
      .then((r) => setData(r.days))
      .catch((e: Error) => setError(e.message))
  }, [days])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>

  const busy = data.filter((d) => d.functions.length > 0)
  if (busy.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        Nothing booked in the next {days} days.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {busy.map((day) => (
        <section key={day.date} className="space-y-3">
          <h2
            className={
              day.isToday
                ? 'sticky top-0 z-10 -mx-1 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground'
                : 'text-sm font-semibold text-muted-foreground'
            }
          >
            {dayLabel(day.date)}
            {day.isToday && <span className="ml-2 font-normal opacity-90">· today</span>}
          </h2>

          <div className="space-y-3">
            {day.functions.map((f) => (
              <article key={f.subEventId} className="rounded-lg border bg-card p-4">
                <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div>
                    <h3 className="font-semibold">
                      {f.name} <span className="font-normal text-muted-foreground">· {f.guestName}</span>
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {f.eventCode} · {f.venueName ?? 'Venue TBC'} · {hhmm(f.startTime)}–{hhmm(f.endTime)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold tabular-nums">{f.pax}</p>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">guests</p>
                  </div>
                </header>

                {f.paxOverrideNote && (
                  <p className="mt-2 text-sm text-amber-700 dark:text-amber-500">
                    Capacity override: {f.paxOverrideNote}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  {f.tierName ? (
                    <span className="rounded bg-muted px-2 py-0.5 font-medium">{f.tierName}</span>
                  ) : (
                    <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">No menu saved</span>
                  )}
                  {f.tierName && !f.menuComplete && (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      Menu incomplete
                    </span>
                  )}
                </div>

                {f.segments.length > 0 && (
                  <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    {f.segments.map((s) => (
                      <div key={s.name}>
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {s.name}
                        </dt>
                        {/* One dish per line rather than a comma list: the preference is an
                            instruction the kitchen acts on, and it was disappearing into a
                            muted aside at the end of a run-on sentence. */}
                        <dd className="mt-0.5 space-y-0.5 text-sm">
                          {s.dishes.map((d) => (
                            <div key={d.name} className="flex flex-wrap items-baseline gap-x-1.5">
                              {/* Extras are the guest's additions beyond the tier's count —
                                  the kitchen should see which dishes those are. */}
                              <span className={d.isExtra ? 'text-violet-700 dark:text-violet-400' : undefined}>
                                {d.name}
                              </span>
                              {d.note && (
                                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                                  {d.note}
                                </span>
                              )}
                            </div>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}

                {f.chefDishes.length > 0 && (
                  <p className="mt-3 text-sm">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Chef delicacies
                    </span>
                    <br />
                    {f.chefDishes.join(', ')}
                  </p>
                )}

                {f.addons.length > 0 && (
                  <p className="mt-3 text-sm">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Add-ons
                    </span>
                    <br />
                    {f.addons.map((a) => `${a.description}${a.qty > 1 ? ` ×${a.qty}` : ''}`).join(', ')}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
