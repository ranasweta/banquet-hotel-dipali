import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { loadEventDetail } from '@/lib/events'
import { payableBreakdown } from '@/lib/payment-schedule'
import { shownTaxPaise } from '@/lib/invoice'
import { EventDetailView, type EventDetail } from '@/components/event-detail'
import { buttonVariants } from '@/components/ui/button'

export default async function BookingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  const can = (module: string, action: string) =>
    perms.some((p) => p.module === module && p.action === action)
  if (!can('bookings', 'view')) redirect('/')

  const { id } = await params
  const detail = await loadEventDetail(id)
  if (!detail) notFound()

  // The header's money, computed here rather than read off `proposal_total_paise`: that column
  // is venue + food + add-ons and has no rooms or tax in it, so on a booking with lodging the
  // card understated what the guest owes by the whole lodging charge (client, 31 Aug 2026).
  // Both figures, never one (rule 11) — the payable is what is collected, the total is what
  // the proposal prints.
  const [bill, shownGstPaise] = await Promise.all([payableBreakdown(id), shownTaxPaise(id)])

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/bookings" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        ← All bookings
      </Link>
      <EventDetailView
        initial={detail as unknown as EventDetail}
        initialTotals={{
          payablePaise: bill.payablePaise,
          displayTotalPaise: bill.payablePaise + shownGstPaise,
        }}
        canViewMenus={can('menus', 'view')}
        canEditMenus={can('menus', 'create_edit')}
        canViewRooms={can('rooms', 'view')}
        canEditRooms={can('rooms', 'create_edit')}
        canViewBilling={can('billing', 'view')}
        canEditBilling={can('billing', 'create_edit')}
        canViewMaintenance={can('maintenance', 'view')}
        canEditMaintenance={can('maintenance', 'create_edit')}
        canViewUtensils={can('utensils', 'view')}
        canEditUtensils={can('utensils', 'create_edit')}
        canEditBookings={can('bookings', 'create_edit')}
        canViewAudit={can('audit', 'view')}
        role={user.roleName}
        isAuditor={user.roleName === 'auditor'}
      />
    </div>
  )
}
