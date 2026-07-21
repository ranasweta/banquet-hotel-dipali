import Link from 'next/link'
import { ChefHat, CalendarDays, UtensilsCrossed, Users, Clock, MapPin, CircleCheck } from 'lucide-react'
import type { ChefDashboard as ChefData } from '@/lib/dashboard'
import { Hero, KpiTile, SectionCard, EmptyState, AgendaList, formatDay, formatTimeRange } from '@/components/dashboard-shared'
import { OperationsBoard } from '@/components/operations-board'

/**
 * Chef home: the kitchen's own board. What is waiting on a price from them, what they cook
 * today and this week, and which upcoming functions still have no settled menu. Deliberately
 * not the Booking board — the Chef has no bookings access and every link there would dead-end.
 */
export function ChefDashboard({ data, user }: { data: ChefData; user: { fullName: string } }) {
  const { toPrice, today, upcoming, menuGaps } = data
  const coversToday = today.reduce((s, f) => s + f.pax, 0)

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Hero name={user.fullName} dateISO={data.asOf} accent={today.length > 0}>
        {today.length === 0 ? (
          <div className="flex items-start gap-3">
            <CircleCheck className="mt-0.5 size-6 shrink-0 text-emerald-500" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold sm:text-2xl">Nothing to cook today</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {upcoming[0]
                  ? <>Next: <span className="font-medium text-foreground">{upcoming[0].guestName} {upcoming[0].name}</span> on {formatDay(upcoming[0].eventDate)}.</>
                  : 'Nothing in the next week either.'}
              </p>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {today.length} {today.length === 1 ? 'function' : 'functions'} today · {coversToday} covers
            </h1>
            <ul className="mt-4 space-y-2">
              {today.map((fn) => (
                <li key={fn.subEventId} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white/10 px-4 py-3 backdrop-blur-sm">
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums text-primary-foreground/90">
                    <Clock className="size-4" aria-hidden />
                    {formatTimeRange(fn.startTime, fn.endTime)}
                  </span>
                  <span className="min-w-0 flex-1 text-base font-semibold">
                    {fn.guestName}
                    <span className="ml-2 font-normal text-primary-foreground/75">{fn.name}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-sm text-primary-foreground/90">
                    <MapPin className="size-4" aria-hidden />
                    {fn.venueName ?? 'Venue TBD'}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-sm text-primary-foreground/75">
                    <Users className="size-4" aria-hidden />
                    {fn.pax}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-sm text-primary-foreground/90">
                    <UtensilsCrossed className="size-4" aria-hidden />
                    {fn.tierName ?? 'no menu'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile href="/chef" icon={<ChefHat className="size-5" aria-hidden />} value={toPrice.length} label="Delicacies to price" tone={toPrice.length ? 'amber' : 'slate'} />
        <KpiTile icon={<Users className="size-5" aria-hidden />} value={coversToday} label="Covers today" tone={coversToday ? 'blue' : 'slate'} />
        <KpiTile href="/calendar" icon={<CalendarDays className="size-5" aria-hidden />} value={upcoming.length} label="Functions · next 7 days" tone="blue" />
        <KpiTile icon={<UtensilsCrossed className="size-5" aria-hidden />} value={menuGaps.length} label="Menus not settled" tone={menuGaps.length ? 'amber' : 'emerald'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          icon={<CalendarDays className="size-4 text-muted-foreground" aria-hidden />}
          title="The week ahead"
          link={{ href: '/calendar', label: 'Calendar' }}
        >
          <AgendaList functions={upcoming} asOf={data.asOf} empty="No functions in the next seven days." />
        </SectionCard>

        <div className="space-y-6">
          <SectionCard
            icon={<ChefHat className="size-4 text-muted-foreground" aria-hidden />}
            title="Waiting on your price"
            badge={toPrice.length}
            link={{ href: '/chef', label: 'Queue' }}
          >
            {toPrice.length === 0 ? (
              <EmptyState text="No delicacy requests waiting." />
            ) : (
              <ul className="space-y-2 text-sm">
                {toPrice.map((r) => (
                  <li key={r.id}>
                    <Link href="/chef" className="block rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                      <span className="line-clamp-1 font-medium">{r.description}</span>
                      <span className="text-xs text-muted-foreground">
                        {r.eventCode} · {r.subEventName} · {formatDay(r.eventDate)} · {r.pax} pax
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard icon={<UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden />} title="Menus not settled">
            {menuGaps.length === 0 ? (
              <EmptyState text="Every upcoming function has a settled menu." />
            ) : (
              <ul className="space-y-2 text-sm">
                {menuGaps.map((g) => (
                  <li key={g.subEventId} className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="line-clamp-1 font-medium">{g.guestName} <span className="font-normal text-muted-foreground">{g.name}</span></span>
                      <span className="text-xs text-muted-foreground">{g.eventCode} · {formatDay(g.eventDate)}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      {g.tierName ?? 'no menu'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Today's kitchen order in full (client, 21 Jul 2026): the Chef sees the same menu
          the Banquet Manager does — every dish, its preferences, and the delicacies he has
          priced himself. No money on it. */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Today&apos;s menus</h2>
        <OperationsBoard days={1} />
      </div>
    </div>
  )
}
