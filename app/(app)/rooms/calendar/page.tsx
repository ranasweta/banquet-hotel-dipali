import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { LodgingCalendar } from '@/components/lodging-calendar'

export default async function LodgingCalendarPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  const can = (module: string) => perms.some((p) => p.module === module && p.action === 'view')
  if (!can('lodging_calendar')) redirect('/')

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold">Lodging calendar</h1>
        {/* Only offered to someone who can actually open it — the rooms board is a separate
            module, and this link is cosmetic either way (that page re-checks server-side). */}
      </div>
      <LodgingCalendar />
    </div>
  )
}
