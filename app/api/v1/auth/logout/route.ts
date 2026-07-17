import { ok, route } from '@/lib/api'
import { getSession } from '@/lib/session'

export const POST = route(async () => {
  const session = await getSession()
  session.destroy()
  return ok({ ok: true })
})
