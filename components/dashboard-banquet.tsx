import Link from 'next/link'
import { CalendarDays, MapPin, Users, Clock, UtensilsCrossed, ArrowLeftRight, CheckCircle2, CircleCheck } from 'lucide-react'
import type { BanquetDashboard } from '@/lib/dashboard'
import {
  Hero,
  KpiTile,
  SectionCard,
  EmptyState,
  AgendaList,
  formatDay,
  formatTimeRange,
} from '@/components/dashboard-shared'
import { OperationsBoard } from '@/components/operations-board'
import { SignoffCard } from '@/components/signoff-card'
import { titleCase } from '@/lib/text'

/**
 * Banquet Manager home: the floor & kitchen view. Today's functions with their menu state, the
 * week ahead, change requests they decide (FR-1.9), and functions whose menu still isn't locked.
 */
export function BanquetDashboard({ data, user }: { data: BanquetDashboard; user: { fullName: string } }) {
  const { today, upcoming, changeRequests, menuGaps, awaitingSignoff } = data
  const nextFn = upcoming[0]

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Hero name={user.fullName} dateISO={data.asOf} accent={today.length > 0}>
        {today.length === 0 ? (
          <div className="flex items-start gap-3">
            <CircleCheck className="mt-0.5 size-6 shrink-0 text-emerald-500" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold sm:text-2xl">No functions today</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {nextFn ? (
                  <>
                    Next: <span className="font-medium text-foreground">{titleCase(nextFn.guestName)} {titleCase(nextFn.name)}</span> ·{' '}
                    {nextFn.venueName ?? 'venue TBD'} on {formatDay(nextFn.eventDate)}.
                  </>
                ) : (
                  'Nothing on the floor in the next week either.'
                )}
              </p>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {today.length} {today.length === 1 ? 'function' : 'functions'} today
            </h1>
            <ul className="mt-4 space-y-2">
              {today.map((fn) => (
                <li key={fn.subEventId} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white/10 px-4 py-3 backdrop-blur-sm">
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums text-primary-foreground/90">
                    <Clock className="size-4" aria-hidden />
                    {formatTimeRange(fn.startTime, fn.endTime)}
                  </span>
                  <span className="min-w-0 flex-1 text-base font-semibold">
                    {titleCase(fn.guestName)}
                    <span className="ml-2 font-normal text-primary-foreground/75">{titleCase(fn.name)}</span>
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
                    {fn.tierName ? `${fn.tierName}${fn.menuComplete ? '' : ' · draft'}` : 'no menu'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile href="/calendar" icon={<CalendarDays className="size-5" aria-hidden />} value={today.length} label="Functions today" tone={today.length ? 'blue' : 'slate'} />
        <KpiTile href="/calendar" icon={<CalendarDays className="size-5" aria-hidden />} value={upcoming.length} label="Functions · next 7 days" tone="blue" />
        <KpiTile href="/change-requests" icon={<ArrowLeftRight className="size-5" aria-hidden />} value={changeRequests.length} label="Change requests to decide" tone={changeRequests.length ? 'amber' : 'slate'} />
        <KpiTile icon={<CheckCircle2 className="size-5" aria-hidden />} value={awaitingSignoff.length} label="Awaiting your sign-off" tone={awaitingSignoff.length ? 'amber' : 'emerald'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          icon={<CalendarDays className="size-4 text-muted-foreground" aria-hidden />}
          title="The week ahead"
          link={{ href: '/calendar', label: 'Calendar' }}
        >
          <AgendaList functions={upcoming} asOf={data.asOf} empty="No functions scheduled in the next seven days." />
        </SectionCard>

        <div className="space-y-6">
          <SignoffCard rows={awaitingSignoff} designation="banquet_manager" />

          <SectionCard
            icon={<ArrowLeftRight className="size-4 text-muted-foreground" aria-hidden />}
            title="Change requests"
            note="to decide"
            badge={changeRequests.length}
            link={{ href: '/change-requests', label: 'Queue' }}
          >
            {changeRequests.length === 0 ? (
              <EmptyState text="No moves waiting on your decision." />
            ) : (
              <ul className="space-y-2 text-sm">
                {changeRequests.map((cr) => (
                  <li key={cr.id}>
                    <Link href="/change-requests" className="block rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                      <span className="line-clamp-1 font-medium">{cr.summary}</span>
                      <span className="text-xs text-muted-foreground">{cr.eventCode} · {titleCase(cr.guestName)} · {cr.requestedByName}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            icon={<UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden />}
            title="Menus to confirm"
          >
            {menuGaps.length === 0 ? (
              <EmptyState text="Every upcoming function has a locked menu." />
            ) : (
              <ul className="space-y-2 text-sm">
                {menuGaps.map((g) => (
                  <li key={g.subEventId}>
                    <Link href={`/bookings/${g.eventId}`} className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="line-clamp-1 font-medium">{titleCase(g.guestName)} <span className="font-normal text-muted-foreground">{titleCase(g.name)}</span></span>
                        <span className="text-xs text-muted-foreground">{g.eventCode} · {formatDay(g.eventDate)}</span>
                      </span>
                      <span className={g.tierName ? 'shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300'}>
                        {g.tierName ? 'draft' : 'no menu'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>

      {/* The Banquet Manager's main view (client, 21 Jul 2026): the next fifteen days, with
          today highlighted, carrying every detail except money. He decides nothing here —
          he reads which event, when, how many people, and what the menu is. */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Next 15 days</h2>
        <OperationsBoard days={15} />
      </div>
    </div>
  )
}
