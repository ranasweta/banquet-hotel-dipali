import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { storeEncrypted } from '@/lib/storage'
import { addEntry, listEntries } from '@/lib/maintenance'

const MAX_BYTES = 8 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

const fieldsSchema = z.object({
  item: z.string().trim().min(1).max(120),
  qty: z.coerce.number().positive().max(1_000_000),
  unit: z.string().trim().min(1).max(20).default('nos'),
  rate_paise: z.coerce.number().int().nonnegative(),
  remarks: z.string().max(300).optional(),
})

/** GET /events/:id/maintenance — the event's maintenance entries + running total + closed flag. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('maintenance', 'view')
  const { id } = await ctx.params
  return ok(await listEntries(id))
})

/**
 * POST /events/:id/maintenance — add a cost entry (FR-5.1), optionally with an encrypted
 * receipt/photo attachment. Multipart so the file rides along.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('maintenance', 'create_edit')
  const { id } = await ctx.params
  const form = await req.formData()
  const input = fieldsSchema.parse({
    item: form.get('item'),
    qty: form.get('qty'),
    unit: form.get('unit') ?? undefined,
    rate_paise: form.get('rate_paise'),
    remarks: form.get('remarks') ?? undefined,
  })

  let fileKey: string | undefined
  const file = form.get('file')
  if (file instanceof File && file.size > 0) {
    if (!ALLOWED_TYPES.has(file.type)) throw badRequest('Attachment must be a JPEG, PNG, WebP or PDF')
    if (file.size > MAX_BYTES) throw badRequest('Attachment must be 8 MB or smaller')
    const stored = await storeEncrypted(Buffer.from(await file.arrayBuffer()), { contentType: file.type })
    fileKey = stored.fileKey
  }

  const result = await addEntry(actor, id, {
    item: input.item,
    qty: input.qty,
    unit: input.unit,
    ratePaise: input.rate_paise,
    remarks: input.remarks,
    fileKey,
  })
  return ok({ entry: result }, 201)
})
