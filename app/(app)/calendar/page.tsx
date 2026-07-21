import { requirePageView } from '@/lib/auth'
import { CalendarBoard } from '@/components/calendar-board'

export default async function CalendarPage() {
  await requirePageView('calendar')
  // The whole month has to be visible at once (client, 20 Jul 2026): the page is pinned to
  // the viewport and the grid takes whatever height is left, so nothing scrolls until a
  // date is opened. 3rem accounts for the layout's p-6 top and bottom padding.
  return (
    <div className="flex min-h-full flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Venue calendar</h1>
        <p className="text-sm text-muted-foreground">
          Confirmed events across every venue. A hall can hold several functions a day as
          long as their times don&apos;t overlap; a booking running past midnight shows as a
          carryover on the next morning.
        </p>
      </div>
      <CalendarBoard />
    </div>
  )
}
