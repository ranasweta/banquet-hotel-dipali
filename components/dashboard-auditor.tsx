import Link from 'next/link'
import { ScrollText, Users, ShieldCheck, ClipboardCheck, FileText } from 'lucide-react'
import type { AuditorDashboard as AuditorData } from '@/lib/dashboard'
import { Hero, KpiTile, SectionCard, EmptyState, StatusPill, formatType } from '@/components/dashboard-shared'

/**
 * Auditor / Admin home: the system at a glance rather than any one desk's work — the event
 * population, what is pending across every queue, who has access, and the newest entries in
 * the append-only trail (CLAUDE.md rule 5).
 */
export function AuditorDashboard({ data, user }: { data: AuditorData; user: { fullName: string } }) {
  const { statusCounts, pendingApprovals, userCount, roleCount, recent } = data
  const totalEvents = statusCounts.reduce((s, r) => s + r.n, 0)
  const live = statusCounts.filter((s) => ['confirmed', 'in_progress'].includes(s.status)).reduce((s, r) => s + r.n, 0)

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Hero name={user.fullName} dateISO={data.asOf}>
        <h1 className="text-2xl font-semibold sm:text-3xl">
          {totalEvents} {totalEvents === 1 ? 'event' : 'events'} on the books
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {live} live · {pendingApprovals} awaiting a decision · {userCount} active users across {roleCount} roles.
        </p>
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile href="/bookings" icon={<FileText className="size-5" aria-hidden />} value={totalEvents} label="Events total" tone="blue" />
        <KpiTile href="/approvals" icon={<ClipboardCheck className="size-5" aria-hidden />} value={pendingApprovals} label="Pending decisions" tone={pendingApprovals ? 'amber' : 'slate'} />
        <KpiTile href="/admin/users" icon={<Users className="size-5" aria-hidden />} value={userCount} label="Active users" tone="slate" />
        <KpiTile href="/admin/roles" icon={<ShieldCheck className="size-5" aria-hidden />} value={roleCount} label="Roles" tone="slate" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          icon={<ScrollText className="size-4 text-muted-foreground" aria-hidden />}
          title="Recent activity"
          note="append-only trail"
          link={{ href: '/reports', label: 'Reports' }}
        >
          {recent.length === 0 ? (
            <EmptyState text="Nothing recorded yet." />
          ) : (
            <ul className="divide-y text-sm">
              {recent.map((a) => (
                <li key={a.seq} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
                  <span className="font-medium capitalize">{formatType(a.entity)}</span>
                  <span className="text-xs capitalize text-muted-foreground">{a.action}</span>
                  {a.field && <span className="text-xs text-muted-foreground">· {formatType(a.field)}</span>}
                  {a.newValue && (
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {a.oldValue ? `${a.oldValue} → ${a.newValue}` : a.newValue}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {a.eventCode ? `${a.eventCode} · ` : ''}{a.userName} ({formatType(a.roleName)})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="space-y-6">
          <SectionCard icon={<FileText className="size-4 text-muted-foreground" aria-hidden />} title="Events by status">
            {statusCounts.length === 0 ? (
              <EmptyState text="No events yet." />
            ) : (
              <ul className="space-y-1.5 text-sm">
                {statusCounts.map((s) => (
                  <li key={s.status} className="flex items-center justify-between gap-2">
                    <StatusPill status={s.status} />
                    <span className="tabular-nums text-muted-foreground">{s.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard icon={<ShieldCheck className="size-4 text-muted-foreground" aria-hidden />} title="Administration">
            <div className="flex flex-col gap-2 text-sm">
              <Link className="font-medium text-primary underline-offset-4 hover:underline" href="/admin/roles">
                Roles &amp; permissions →
              </Link>
              <Link className="font-medium text-primary underline-offset-4 hover:underline" href="/admin/users">
                Users →
              </Link>
              <Link className="font-medium text-primary underline-offset-4 hover:underline" href="/reports">
                Reports →
              </Link>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
