import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createInstantProposal, draftSchema, listInstantProposals, nameSchema } from '@/lib/instant-proposals'

/** GET /instant-proposals — the "Instant" tab of Past proposals, newest first. */
export const GET = route(async () => {
  await requirePermission('bookings', 'view')
  return ok({ instants: await listInstantProposals() })
})

const bodySchema = z.object({ name: nameSchema, draft: draftSchema })

/** POST /instant-proposals { name, draft } — only the name is required (lib/instant-proposals.ts). */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const body = bodySchema.parse(await req.json())
  const id = await createInstantProposal(actor, body.name, body.draft)
  return ok({ id }, 201)
})
