import { requirePageView } from '@/lib/auth'
import { UsersAdmin } from '@/components/users-admin'

export default async function UsersPage() {
  await requirePageView('roles_users')
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-muted-foreground">
          A disabled user is signed out on their next request.
        </p>
      </div>
      <UsersAdmin />
    </div>
  )
}
