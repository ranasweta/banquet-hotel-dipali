import { requirePageView } from '@/lib/auth'
import { RolesMatrix } from '@/components/roles-matrix'

export default async function RolesPage() {
  await requirePageView('roles_users')
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Roles &amp; permissions</h1>
        <p className="text-muted-foreground">Changes take effect immediately.</p>
      </div>
      <RolesMatrix />
    </div>
  )
}
