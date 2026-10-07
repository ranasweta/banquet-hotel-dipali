import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { draftSchema, getInstantProposal, nameSchema, updateInstantProposal } from '@/lib/instant-proposals'

type Ctx = { params: Promise<{ id: string }> }

export const GET = route(async (_req: NextRequest, ctx: Ctx) => {
  await requirePermission('bookings', 'view')
  const { id } = await ctx.params
  return ok({ instant: await getInstantProposal(z.uuid().parse(id)) })
})

const bodySchema = z.object({ name: nameSchema, draft: draftSchema })

/** PUT /instant-proposals/:id { name, draft } — the whole instant, replaced. 409 once converted. */
export const PUT = route(async (req: NextRequest, ctx: Ctx) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const body = bodySchema.parse(await req.json())
  await updateInstantProposal(actor, z.uuid().parse(id), body.name, body.draft)
  return ok({ id })
})
