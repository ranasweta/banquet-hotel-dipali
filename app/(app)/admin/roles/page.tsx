import { requirePageView } from '@/lib/auth'
import { RolesMatrix } from '@/components/roles-matrix'

export default async function RolesPage() {
  await requirePageView('roles_users')
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Roles &amp; permissions</h1>
        <p className="text-muted-foreground">
          Grant each role View, Create/Edit, or Delete per module. Changes take effect
          immediately — no one needs to sign in again.
        </p>
      </div>
      <RolesMatrix />
    </div>
  )
}
