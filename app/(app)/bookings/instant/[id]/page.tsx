import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { InstantProposal } from '@/components/instant-proposal'

export default async function InstantProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  // The same counter's tool as New proposal, so the same gate.
  if (!perms.some((p) => p.module === 'bookings' && p.action === 'create_edit')) redirect('/bookings')
  // The tape chart reads the calendar; without it the "Check availability" button is not offered.
  const canSeeAvailability = perms.some((p) => p.module === 'calendar' && p.action === 'view')

  return (
    <div className="mx-auto max-w-4xl space-y-6 print:max-w-none print:space-y-0">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold">Instant proposal</h1>
          <p className="text-sm text-muted-foreground">Saved as you go. Nothing is booked or charged until it is converted.</p>
        </div>
        <Link href="/bookings" className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline">
          Past proposals →
        </Link>
      </div>
      <InstantProposal id={id} canSeeAvailability={canSeeAvailability} />
    </div>
  )
}
