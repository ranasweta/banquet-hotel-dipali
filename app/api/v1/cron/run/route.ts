import type { NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
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
 * what Cloud Scheduler and a manual curl send; `Authorization: Bearer` was Vercel Cron's,
 * kept because it costs a line and nothing is gained by breaking an old caller.
 */
function isScheduler(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    // Unset, every scheduler call 403s and NOTHING ever reaches Completed — so nothing can be
    // locked, invoiced or billed. That failure is silent (the 403 goes to a cron job nobody
    // watches) and looks nothing like its cause, so it is announced here instead.
    console.error(
      'CRON_SECRET is not set, so the daily job cannot be run by the scheduler. Until it is, ' +
        'no event will advance to In Progress or Completed. See docs/OPERATIONS.md.',
    )
    return false
  }
  const header = req.headers.get('x-cron-secret')
  const bearer = req.headers.get('authorization')
  return matches(header, secret) || matches(bearer, `Bearer ${secret}`)
}

/** Constant-time compare, so the secret can't be recovered a character at a time. */
function matches(given: string | null, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * GET /cron/run — the same job for a caller that can only issue a GET. Scheduler-only:
 * there is no body, so no `as_of`, and a browser hitting this URL without the secret gets a
 * 403 rather than silently advancing every event in the hotel.
 *
 * The live schedule is a Cloud Scheduler job (08:30 IST, before the hotel's day starts)
 * calling POST — see docs/OPERATIONS.md. It lives in GCP rather than in this repo, so
 * changing the time is a console edit and leaves no trace here.
 *
 * This job is why an event ever reaches Completed. Nothing else advances a status, so
 * without it nothing can be locked, invoiced or billed.
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
    // `failed` carries the bookings that would not move, by id. A run that half-worked must
    // say so — the job used to abort on the first bad row and report nothing at all.
    advanced: {
      started: advanced.started.length,
      completed: advanced.finished.length,
      failed: advanced.failed,
    },
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
