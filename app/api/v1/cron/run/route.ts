import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth'
import { forbidden, ok, route } from '@/lib/api'
import { generateWeddingReminders, listStaleEnquiries } from '@/lib/reminders'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const bodySchema = z.object({ as_of: z.string().regex(ISO_DATE).optional() }).optional()

/**
 * POST /cron/run — the daily job: generate wedding balance reminders and surface stale
 * enquiries. Run by a scheduler with a CRON_SECRET header, or manually by the Auditor/Admin.
 * `as_of` overrides "today" (used by the time-travel test path).
 */
export const POST = route(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('x-cron-secret')
  if (!(secret && provided && provided === secret)) {
    const user = await requireAuth()
    if (user.roleName !== 'auditor') throw forbidden('Only the Auditor/Admin (or the cron secret) may run jobs.')
  }

  const body = bodySchema.parse(await req.json().catch(() => ({})))
  const asOf = body?.as_of ?? new Date().toISOString().slice(0, 10)

  const reminders = await generateWeddingReminders(asOf)
  const stale = await listStaleEnquiries(asOf)
  return ok({ asOf, reminders, staleEnquiries: stale.length })
})
