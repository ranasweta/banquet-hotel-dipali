import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { listForSubEvent, requestDelicacy } from '@/lib/chef'

/** GET /sub-events/:id/chef-requests — delicacy requests on one function. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('menus', 'view')
  const { id } = await ctx.params
  return ok({ requests: await listForSubEvent(id) })
})

const createSchema = z.object({ description: z.string().trim().min(1).max(300) })

/**
 * POST /sub-events/:id/chef-requests — ask the Chef for something off-menu ("sushi").
 * Anyone who can edit a menu may ask; only the Chef puts a price on it.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  const input = createSchema.parse(await req.json())
  const result = await requestDelicacy(actor, id, input.description)
  return ok({ request: result }, 201)
})
