import { requirePageView } from '@/lib/auth'
import { ChefQueue } from '@/components/chef-queue'

/**
 * Chef delicacy queue. Readable by anyone who can view menus (so a Booking Manager can see
 * where their request stands); only the Chef may actually set a price — enforced in the
 * service layer, not here.
 */
export default async function ChefPage() {
  const user = await requirePageView('menus')
  const canPrice = user.roleName === 'chef' || user.roleName === 'auditor'

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Chef requests</h1>
        <p className="text-muted-foreground">
          The charge is <strong>per plate</strong>.
        </p>
      </div>
      <ChefQueue canPrice={canPrice} />
    </div>
  )
}
