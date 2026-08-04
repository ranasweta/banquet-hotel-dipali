'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { titleCase } from '@/lib/text'

type Reminder = {
  id: string
  eventId: string
  eventCode: string
  guestName: string
  firstDate: string
  remindOn: string
  /** Short of the 50% milestone — not the whole outstanding balance (client, 4 Aug 2026). */
  shortfallPaise: number
  milestonePaise: number
  milestonePct: number
}

/** Wedding milestone reminders due for the signed-in user's role (FR-9.1 / BR-P2). */
export function DashboardReminders() {
  const [reminders, setReminders] = useState<Reminder[] | null>(null)

  useEffect(() => {
    api<{ reminders: Reminder[] }>('/reminders/pending')
      .then((r) => setReminders(r.reminders))
      .catch(() => setReminders([]))
  }, [])

  if (!reminders || reminders.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Payment reminders
          <Badge variant="outline" className="text-amber-600">{reminders.length} due</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {reminders.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <Link href={`/bookings/${r.eventId}`} className="hover:underline">
                <span className="font-medium tabular-nums">{r.eventCode}</span> · {titleCase(r.guestName)}
                <span className="text-muted-foreground"> · event {r.firstDate}</span>
              </Link>
              {/* What to ask for, not what is owed overall: the guest has to reach the 50%
                  milestone by D-30, and the rest settles at billing (client, 4 Aug 2026). */}
              <span className="tabular-nums text-amber-600">
                collect {formatPaise(r.shortfallPaise)}
                <span className="text-muted-foreground"> to reach {r.milestonePct}%</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
