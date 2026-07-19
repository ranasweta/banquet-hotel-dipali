import Link from 'next/link'
import { ArrowRight, MapPin, CircleCheck } from 'lucide-react'
import type { AgendaFunction } from '@/lib/dashboard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** An agenda row, with the Banquet menu fields optional so plain Booking agendas fit too. */
export type AgendaItem = AgendaFunction & { tierName?: string | null; menuComplete?: boolean | null }

/**
 * Presentational building blocks shared by every role dashboard, so the boards read as one
 * system: the hero shell, KPI tiles, status pills, section cards, the grouped agenda list, and
 * the tz-safe date/time formatters. All pure server components — no client JS.
 */

// ── Hero ─────────────────────────────────────────────────────────────────────

/** The top-of-page banner. `accent` paints it blue for an "there's action today" state. */
export function Hero({
  name,
  dateISO,
  accent,
  children,
}: {
  name: string
  dateISO: string
  accent?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl ring-1 ring-foreground/10',
        accent ? 'bg-gradient-to-br from-blue-600 to-indigo-700 text-white' : 'bg-gradient-to-br from-muted/60 to-card',
      )}
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <p className={cn('text-xs font-medium uppercase tracking-wide', accent ? 'text-blue-100' : 'text-muted-foreground')}>
            {greeting()}, {firstName(name)}
          </p>
          <p className={cn('text-xs tabular-nums', accent ? 'text-blue-100' : 'text-muted-foreground')}>
            {formatFullDate(dateISO)}
          </p>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </section>
  )
}

// ── KPI tile ─────────────────────────────────────────────────────────────────

export type Tone = 'blue' | 'amber' | 'emerald' | 'red' | 'slate' | 'violet'

const TONE: Record<Tone, { ring: string; icon: string; value: string }> = {
  blue: { ring: 'ring-blue-500/20', icon: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300', value: 'text-foreground' },
  amber: { ring: 'ring-amber-500/30', icon: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300', value: 'text-amber-700 dark:text-amber-300' },
  emerald: { ring: 'ring-emerald-500/20', icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300', value: 'text-foreground' },
  red: { ring: 'ring-red-500/30', icon: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300', value: 'text-red-700 dark:text-red-300' },
  violet: { ring: 'ring-violet-500/20', icon: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300', value: 'text-foreground' },
  slate: { ring: 'ring-foreground/10', icon: 'bg-muted text-muted-foreground', value: 'text-foreground' },
}

export function KpiTile({
  href,
  icon,
  value,
  label,
  hint,
  tone,
}: {
  href?: string
  icon: React.ReactNode
  value: number | string
  label: string
  hint?: string
  tone: Tone
}) {
  const t = TONE[tone]
  const inner = (
    <>
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', t.icon)}>{icon}</span>
      <span className="min-w-0">
        <span className={cn('block text-2xl font-semibold leading-none tabular-nums', t.value)}>{value}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{label}</span>
        {hint && <span className="block truncate text-xs font-medium text-amber-600 dark:text-amber-400">{hint}</span>}
      </span>
    </>
  )
  const base = cn('flex items-center gap-3 rounded-xl bg-card p-4 ring-1', t.ring)
  return href ? (
    <Link href={href} className={cn(base, 'group transition-all hover:shadow-sm hover:ring-2')}>
      {inner}
    </Link>
  ) : (
    <div className={base}>{inner}</div>
  )
}

// ── Section card ─────────────────────────────────────────────────────────────

/** A titled card with an icon, optional count badge / note, and an optional header link. */
export function SectionCard({
  icon,
  title,
  note,
  badge,
  link,
  className,
  children,
}: {
  icon: React.ReactNode
  title: string
  note?: string
  badge?: number
  link?: { href: string; label: string }
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
          {note && <span className="text-sm font-normal text-muted-foreground">{note}</span>}
          {badge != null && badge > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              {badge}
            </span>
          )}
        </CardTitle>
        {link && (
          <Link href={link.href} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            {link.label} <ArrowRight className="size-3" aria-hidden />
          </Link>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function EmptyState({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      {icon ?? <CircleCheck className="size-5 text-emerald-500" aria-hidden />}
      {text}
    </div>
  )
}

// ── Status pill ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  enquiry: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  in_progress: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  completed: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  locked: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  billed: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
  closed: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs', STATUS_STYLES[status] ?? STATUS_STYLES.completed)}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

// ── Agenda list (grouped by date; shows a menu chip when present) ─────────────

export function AgendaList({
  functions,
  asOf,
  empty,
}: {
  functions: AgendaItem[]
  asOf: string
  empty: string
}) {
  if (functions.length === 0) return <EmptyState text={empty} />
  const byDate = groupBy(functions, (f) => f.eventDate)
  return (
    <div className="space-y-4">
      {[...byDate.entries()].map(([date, fns]) => (
        <div key={date}>
          <div className="mb-2 flex items-baseline gap-2">
            <h3 className="text-sm font-semibold">{relativeDay(date, asOf)}</h3>
            <span className="text-xs text-muted-foreground">
              {fns.length} {fns.length === 1 ? 'function' : 'functions'}
            </span>
          </div>
          <ul className="space-y-1.5">
            {fns.map((fn) => (
              <li key={fn.subEventId}>
                <Link
                  href={`/bookings/${fn.eventId}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-transparent px-3 py-2 hover:border-border hover:bg-muted/50"
                >
                  <span className="w-32 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                    {formatTimeRange(fn.startTime, fn.endTime)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {fn.guestName}
                    <span className="ml-1.5 font-normal text-muted-foreground">{fn.name}</span>
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <MapPin className="size-3.5" aria-hidden />
                    {fn.venueName ?? 'TBD'}
                  </span>
                  {fn.tierName !== undefined && <MenuChip tierName={fn.tierName} complete={fn.menuComplete ?? null} />}
                  <StatusPill status={fn.status} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function MenuChip({ tierName, complete }: { tierName: string | null; complete: boolean | null }) {
  if (!tierName) {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        no menu
      </span>
    )
  }
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs',
        complete
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
      )}
    >
      {tierName}
      {complete ? '' : ' · draft'}
    </span>
  )
}

// ── Date / string helpers (no external date lib; parse parts to stay tz-safe) ──

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function firstName(full: string): string {
  return full.split(/\s+/)[0]
}

export function formatFullDate(iso: string): string {
  return parseISO(iso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export function formatDay(iso: string): string {
  return parseISO(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** "Tomorrow" for asOf+1, otherwise a weekday + date label. */
export function relativeDay(iso: string, asOf: string): string {
  const days = Math.round((parseISO(iso).getTime() - parseISO(asOf).getTime()) / 86_400_000)
  if (days === 1) return 'Tomorrow'
  return formatDay(iso)
}

export function formatTime(hms: string): string {
  const [hStr, mStr] = hms.split(':')
  let h = Number(hStr)
  const m = Number(mStr)
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return m === 0 ? `${h} ${ampm}` : `${h}:${mStr} ${ampm}`
}

/** A window whose end ≤ start runs past midnight (schema BR-C1); flag it with +1. */
export function formatTimeRange(start: string, end: string): string {
  const overnight = end <= start
  return `${formatTime(start)} – ${formatTime(end)}${overnight ? ' +1' : ''}`
}

export function daysUntilDue(dateISO: string, asOf: string): number {
  return Math.round((parseISO(dateISO).getTime() - parseISO(asOf).getTime()) / 86_400_000)
}

export function formatType(code: string): string {
  return code.replace(/_/g, ' ')
}

export function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return map
}
