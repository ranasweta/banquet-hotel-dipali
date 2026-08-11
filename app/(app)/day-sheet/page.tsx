import { requirePageView } from '@/lib/auth'
import { OperationsBoard } from '@/components/operations-board'

/**
 * The operations board (client, 21 Jul 2026). The Banquet Manager's home for "which event,
 * when, how many people, and what is the menu" across the next fifteen days, with today
 * pinned at the top of its own section.
 *
 * Gated on `calendar:view`, so the Chef and the Booking Manager reach the same board — it
 * is the day sheet the lock checklist has always referred to, finally given a screen.
 * Nothing on it is money.
 */
export default async function DaySheetPage() {
  await requirePageView('calendar')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Next 15 days</h1>
      <OperationsBoard days={15} />
    </div>
  )
}
