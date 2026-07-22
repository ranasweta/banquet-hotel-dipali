import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { banquetScopeFor, requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { getOperationsHorizon } from '@/lib/daysheet'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_DAYS = 15
const MAX_DAYS = 31

const querySchema = z.object({
  from: z.string().regex(ISO_DATE).optional(),
  days: z.coerce.number().int().min(1).max(MAX_DAYS).optional(),
})

/**
 * GET /calendar/horizon?from=&days= — the operations board: every function over a window,
 * with venue, timing, pax, the full menu with preferences, priced chef delicacies and
 * add-ons. No money anywhere in the payload.
 *
 * Fifteen days by default (client, 21 Jul 2026: "the banquet manager should see next 15
 * days event in dashboard with today's event highlighted"). The Chef reads the same shape
 * for a single day.
 *
 * Gated on `calendar:view`, which the Banquet Manager, the Chef, Booking, the Authority
 * and the Auditor all hold — and which carries no billing rights, matching a payload that
 * deliberately contains no rupees.
 */
export const GET = route(async (req: NextRequest) => {
  const user = await requirePermission('calendar', 'view')

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!parsed.success) throw badRequest('from must be YYYY-MM-DD and days 1–31')

  const from = parsed.data.from ?? new Date().toLocaleDateString('en-CA')
  const days = parsed.data.days ?? DEFAULT_DAYS
  // Scoped for a Banquet Manager to their own venues; everyone else sees all.
  return ok(await getOperationsHorizon(from, days, undefined, banquetScopeFor(user)))
})
