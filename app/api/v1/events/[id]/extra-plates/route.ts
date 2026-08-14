import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { storeEncrypted } from '@/lib/storage'
import { addPlates, getUtensilExtras } from '@/lib/utensils'

const MAX_BYTES = 8 * 1024 * 1024
// Images only, unlike the maintenance receipt which also takes a PDF. A photograph of the
// plates is the whole evidence here, and a PDF is not one.
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])

const fieldsSchema = z.object({
  sub_event_id: z.string().uuid(),
  plates: z.coerce.number().int().positive(),
  remarks: z.string().max(300).optional(),
})

/** GET /events/:id/extra-plates — the event's plate log, its total, and its functions + rates. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('utensils', 'view')
  const { id } = await ctx.params
  return ok(await getUtensilExtras(id))
})

/**
 * POST /events/:id/extra-plates — log plates issued at one function, with their photograph.
 *
 * Multipart, and the photo is REQUIRED (client, 15 Aug 2026): this is the one charge in the
 * system a member of staff could invent, so an entry without evidence is refused outright
 * rather than saved and flagged. The bytes are encrypted before they leave the process.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('utensils', 'create_edit')
  await ctx.params
  const form = await req.formData()
  const input = fieldsSchema.parse({
    sub_event_id: form.get('sub_event_id'),
    plates: form.get('plates'),
    remarks: form.get('remarks') ?? undefined,
  })

  const file = form.get('photo')
  if (!(file instanceof File) || file.size === 0) {
    throw badRequest('A photo of the plates is required — take one now or pick one from the gallery.')
  }
  if (!ALLOWED_TYPES.has(file.type)) throw badRequest('The photo must be a JPEG, PNG, WebP or HEIC image')
  if (file.size > MAX_BYTES) throw badRequest('The photo must be 8 MB or smaller')
  const { fileKey } = await storeEncrypted(Buffer.from(await file.arrayBuffer()), { contentType: file.type })

  const entry = await addPlates(actor, {
    subEventId: input.sub_event_id,
    plates: input.plates,
    remarks: input.remarks,
    fileKey,
  })
  return ok({ entry }, 201)
})
