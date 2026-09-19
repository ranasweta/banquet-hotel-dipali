import { requirePageView } from '@/lib/auth'
import { VenueTapeChart } from '@/components/venue-tape-chart'

export default async function VenueAvailabilityPage() {
  await requirePageView('calendar')
  return (
    <div className="flex min-h-full flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Venue availability</h1>
        <p className="text-sm text-muted-foreground">
          What is taken, and at what times — hall by hall, lawn by lawn, bundle by bundle.
        </p>
      </div>
      <VenueTapeChart />
    </div>
  )
}
