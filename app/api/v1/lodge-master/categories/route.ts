import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { addCategory, removeCategory, renameCategory, setCategoryCount, setCategoryRate } from '@/lib/lodge-master'

const target = z.object({ unit_id: z.uuid(), room_type: z.string().min(1).max(60) })

const postSchema = target.and(
  z.object({
    rate_paise: z.number().int().positive(),
    rooms: z.number().int().positive(),
    beds: z.number().int().positive(),
  }),
)

/** POST /lodge-master/categories — add a category to a lodge. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('lodge_master', 'create_edit')
  const b = postSchema.parse(await req.json())
  await addCategory(actor, b.unit_id, {
    roomType: b.room_type,
    ratePaise: b.rate_paise,
    rooms: b.rooms,
    beds: b.beds,
  })
  return ok({ ok: true }, 201)
})

/**
 * PUT /lodge-master/categories — change a category's name, its nightly rate, its room count,
 * or any combination.
 *
 * A REDUCTION IS GUARDED: rooms already promised to confirmed bookings are counted per night,
 * and dropping below the busiest of those is refused with the number that blocks it (409).
 * Growing can hurt nobody and is free.
 */
const putSchema = target.and(
  z.object({
    next_room_type: z.string().min(1).max(60).optional(),
    rate_paise: z.number().int().positive().optional(),
    rooms: z.number().int().nonnegative().optional(),
  }),
)

export const PUT = route(async (req: NextRequest) => {
  const actor = await requirePermission('lodge_master', 'create_edit')
  const b = putSchema.parse(await req.json())
  // The rename runs FIRST and everything after it addresses the new name — otherwise a form
  // that renames and re-prices in one press would look the category up under a name that no
  // longer exists. `renameCategory` returns the normalised name for exactly that.
  const roomType =
    b.next_room_type != null
      ? await renameCategory(actor, b.unit_id, b.room_type, b.next_room_type)
      : b.room_type
  // Rate before count: adding rooms copies the category's rate onto the new rows, so re-pricing
  // and growing in one call should put the NEW price on them.
  if (b.rate_paise != null) await setCategoryRate(actor, b.unit_id, roomType, b.rate_paise)
  if (b.rooms != null) await setCategoryCount(actor, b.unit_id, roomType, b.rooms)
  return ok({ ok: true })
})

/** DELETE /lodge-master/categories — retire a category. Same guard as shrinking it to zero. */
export const DELETE = route(async (req: NextRequest) => {
  const actor = await requirePermission('lodge_master', 'delete')
  const b = target.parse(await req.json())
  await removeCategory(actor, b.unit_id, b.room_type)
  return ok({ ok: true })
})
