import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DashboardReminders } from '@/components/dashboard-reminders'

export default async function DashboardPage() {
  // Next renders the layout and this page in parallel, so the page cannot rely on the
  // layout's auth guard having run first — it must guard itself.
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const permissions = await getPermissionMatrix(user.roleId)
  const modules = [...new Set(permissions.map((p) => p.module))].sort()

  const canAdmin = permissions.some((p) => p.module === 'roles_users' && p.action === 'view')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome, {user.fullName}</h1>
        <p className="text-muted-foreground">
          Signed in as {formatRole(user.roleName)}.
        </p>
      </div>

      <DashboardReminders />

      <Card>
        <CardHeader>
          <CardTitle>Your access</CardTitle>
          <CardDescription>
            Modules your role can see. Administration sets these in Roles &amp; permissions.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {modules.length ? (
            modules.map((m) => (
              <Badge key={m} variant="secondary">
                {m}
              </Badge>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No module access yet.</p>
          )}
        </CardContent>
      </Card>

      {canAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Administration</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-4">
            <Link className="text-sm font-medium text-primary underline-offset-4 hover:underline" href="/admin/roles">
              Roles &amp; permissions →
            </Link>
            <Link className="text-sm font-medium text-primary underline-offset-4 hover:underline" href="/admin/users">
              Users →
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function formatRole(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
