import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { ok, route, unauthorized } from '@/lib/api'

/** Current user, role, and permission matrix — the client uses this to drive UI visibility. */
export const GET = route(async () => {
  const user = await getCurrentUser()
  if (!user) throw unauthorized()
  return ok({
    user: { id: user.id, fullName: user.fullName, loginId: user.loginId, mobile: user.mobile, email: user.email },
    role: { id: user.roleId, name: user.roleName },
    permissions: await getPermissionMatrix(user.roleId),
  })
})
