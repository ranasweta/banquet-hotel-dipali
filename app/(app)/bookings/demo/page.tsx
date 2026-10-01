import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { DemoProposal } from '@/components/demo-proposal'

export default async function DemoProposalPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  // The same counter's tool as New proposal, so the same gate.
  if (!perms.some((p) => p.module === 'bookings' && p.action === 'create_edit')) redirect('/bookings')

  return (
    <div className="mx-auto max-w-4xl space-y-6 print:max-w-none print:space-y-0">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold">Demo proposal</h1>
          <p className="text-sm text-muted-foreground">Nothing here is saved, booked or charged.</p>
        </div>
        <Link href="/bookings/new" className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline">
          Start a real proposal →
        </Link>
      </div>
      <DemoProposal />
    </div>
  )
}
