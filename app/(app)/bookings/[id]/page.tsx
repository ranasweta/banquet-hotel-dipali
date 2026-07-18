import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { loadEventDetail } from '@/lib/events'
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

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/bookings" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        ← All bookings
      </Link>
      <EventDetailView
        initial={detail as unknown as EventDetail}
        canViewMenus={can('menus', 'view')}
        canEditMenus={can('menus', 'create_edit')}
        canViewRooms={can('rooms', 'view')}
        canEditRooms={can('rooms', 'create_edit')}
      />
    </div>
  )
}
