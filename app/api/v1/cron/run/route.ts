import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth'
import { forbidden, ok, route } from '@/lib/api'
import { generateWeddingReminders, listStaleEnquiries } from '@/lib/reminders'
import { advanceEventStatuses } from '@/lib/events'
import { sql } from 'drizzle-orm'
import { db } from '@/db/drizzle'

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
  let actor: { id: string; roleName: string } | null = null
  if (!(secret && provided && provided === secret)) {
    const user = await requireAuth()
    if (user.roleName !== 'auditor') throw forbidden('Only the Auditor/Admin (or the cron secret) may run jobs.')
    actor = { id: user.id, roleName: user.roleName }
  }

  const body = bodySchema.parse(await req.json().catch(() => ({})))
  const asOf = body?.as_of ?? new Date().toISOString().slice(0, 10)

  // Advance first: an event that finished today should be Completed before the reminder
  // and stale-enquiry passes look at it.
  const runner = actor ?? (await systemActor())
  const advanced = await advanceEventStatuses(runner, asOf)

  const reminders = await generateWeddingReminders(asOf)
  const stale = await listStaleEnquiries(asOf)
  return ok({
    asOf,
    advanced: { started: advanced.started.length, completed: advanced.finished.length },
    reminders,
    staleEnquiries: stale.length,
  })
})

/**
 * Who the audit trail credits when the scheduler runs the job unattended. Every status move
 * writes an audit row naming a user, so a headless run still needs one: the Auditor/Admin
 * account, which is the role that may run this by hand anyway.
 */
async function systemActor(): Promise<{ id: string; roleName: string }> {
  const [row] = (await db.execute(sql`
    SELECT u.id, r.name AS "roleName"
      FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'auditor' AND u.is_active
     ORDER BY u.created_at
     LIMIT 1
  `)) as unknown as { id: string; roleName: string }[]
  if (!row) throw forbidden('No active Auditor account to attribute the scheduled run to.')
  return row
}
