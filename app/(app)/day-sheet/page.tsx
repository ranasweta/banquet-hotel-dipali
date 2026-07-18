import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { DaySheetView } from '@/components/day-sheet-view'

export default async function DaySheetPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'calendar' && p.action === 'view')) redirect('/')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="print:hidden">
        <h1 className="text-2xl font-semibold">Day sheet</h1>
        <p className="text-muted-foreground">
          The kitchen &amp; operations order for a date — every function with its menu, add-ons and notes.
        </p>
      </div>
      <DaySheetView initialDate="2026-07-18" />
    </div>
  )
}
