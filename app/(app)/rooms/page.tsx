import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { listUnits } from '@/lib/rooms'
import { RoomsBoard } from '@/components/rooms-board'

export default async function RoomsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'rooms' && p.action === 'view')) redirect('/')

  const units = await listUnits()

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Rooms board</h1>
        <p className="text-muted-foreground">
          Availability across a lodging unit for a date range. Allocate rooms from a booking’s detail page.
        </p>
      </div>
      <RoomsBoard initialUnits={units} />
    </div>
  )
}
