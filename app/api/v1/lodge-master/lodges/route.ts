import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createLodge } from '@/lib/lodge-master'

const bodySchema = z.object({ name: z.string().min(1).max(120) })

/** POST /lodge-master/lodges — a new lodge. It has no categories until some are added. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('lodge_master', 'create_edit')
  const b = bodySchema.parse(await req.json())
  return ok(await createLodge(actor, b.name), 201)
})
