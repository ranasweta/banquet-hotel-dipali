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
 * Is this the scheduler rather than a person?
 *
 * Two shapes are accepted because two callers exist. Our own header (`x-cron-secret`) is
 * what a self-hosted scheduler or a manual curl uses; `Authorization: Bearer` is what Vercel
 * Cron sends, and it is not negotiable — the platform picks the header, not us.
 */
function isScheduler(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.get('x-cron-secret')
  const bearer = req.headers.get('authorization')
  return header === secret || bearer === `Bearer ${secret}`
}

/**
 * GET /cron/run — the same job, for Vercel Cron, which issues a GET and cannot be told to
 * POST. Scheduler-only: there is no body, so no `as_of`, and a browser hitting this URL
 * without the secret gets a 403 rather than silently advancing every event in the hotel.
 */
export const GET = route(async (req: NextRequest) => {
  if (!isScheduler(req)) throw forbidden('This endpoint is for the scheduler.')
  return runDailyJob(await systemActor(), new Date().toISOString().slice(0, 10))
})

/**
 * POST /cron/run — the daily job: advance events onto their dates, generate wedding balance
 * reminders and surface stale enquiries. Run by a scheduler with the secret, or manually by
 * the Auditor/Admin. `as_of` overrides "today" (used by the time-travel test path).
 */
export const POST = route(async (req: NextRequest) => {
  let actor: { id: string; roleName: string } | null = null
  if (!isScheduler(req)) {
    const user = await requireAuth()
    if (user.roleName !== 'auditor') throw forbidden('Only the Auditor/Admin (or the cron secret) may run jobs.')
    actor = { id: user.id, roleName: user.roleName }
  }

  const body = bodySchema.parse(await req.json().catch(() => ({})))
  const asOf = body?.as_of ?? new Date().toISOString().slice(0, 10)
  return runDailyJob(actor ?? (await systemActor()), asOf)
})

async function runDailyJob(runner: { id: string; roleName: string }, asOf: string) {

  // Advance first: an event that finished today should be Completed before the reminder
  // and stale-enquiry passes look at it.
  const advanced = await advanceEventStatuses(runner, asOf)

  const reminders = await generateWeddingReminders(asOf)
  const stale = await listStaleEnquiries(asOf)
  return ok({
    asOf,
    advanced: { started: advanced.started.length, completed: advanced.finished.length },
    reminders,
    staleEnquiries: stale.length,
  })
}

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
