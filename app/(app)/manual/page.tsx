import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { UserManual } from '@/components/user-manual'

/**
 * How to work each role's screens. Gated on being signed in and nothing else — the manual
 * carries no booking data, and a new member of staff needs it before they have been granted
 * anything else.
 */
export default async function ManualPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">User manual</h1>
      <UserManual roleName={user.roleName} />
    </div>
  )
}
