import { requirePageView } from '@/lib/auth'
import { CalendarBoard } from '@/components/calendar-board'

export default async function CalendarPage() {
  await requirePageView('calendar')
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Venue calendar</h1>
        <p className="text-muted-foreground">
          Confirmed events across every venue. A hall can hold several functions a day as
          long as their times don&apos;t overlap; a booking running past midnight shows as a
          carryover on the next morning.
        </p>
      </div>
      <CalendarBoard />
    </div>
  )
}
