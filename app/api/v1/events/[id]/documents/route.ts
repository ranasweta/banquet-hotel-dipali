import type { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { badRequest, notFound, ok, route } from '@/lib/api'
import { deleteStored, storeEncrypted } from '@/lib/storage'

const MAX_BYTES = 8 * 1024 * 1024 // 8 MB
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const kindSchema = z.enum(['aadhaar_front', 'aadhaar_back', 'receipt', 'other'])

/**
 * POST /events/:id/documents — multipart upload of a KYC image (FR-1.10). The bytes are
 * encrypted at rest (rule 7) and only a file_key is stored. Never logs the image or any
 * Aadhaar content. Replaces an existing document of the same aadhaar kind.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params

  const [event] = await db
    .select({ id: schema.events.id, status: schema.events.status })
    .from(schema.events)
    .where(eq(schema.events.id, id))
    .limit(1)
  if (!event) throw notFound('Event not found')
  if (event.status !== 'enquiry') throw badRequest('Documents can only be uploaded on an enquiry')

  const form = await req.formData()
  const kind = kindSchema.parse(form.get('kind'))
  const file = form.get('file')
  if (!(file instanceof File)) throw badRequest('file is required')
  if (!ALLOWED_TYPES.has(file.type)) throw badRequest('Only JPEG, PNG or WebP images are accepted')
  if (file.size > MAX_BYTES) throw badRequest('File must be 8 MB or smaller')

  const bytes = Buffer.from(await file.arrayBuffer())
  const { fileKey } = await storeEncrypted(bytes, { contentType: file.type })

  let replaced: string | null = null
  await db.transaction(async (tx) => {
    // Replace any existing document of this kind (one_doc_per_kind for aadhaar).
    const [old] = await tx
      .delete(schema.guestDocuments)
      .where(and(eq(schema.guestDocuments.eventId, id), eq(schema.guestDocuments.kind, kind)))
      .returning({ fileKey: schema.guestDocuments.fileKey })
    replaced = old?.fileKey ?? null
    await tx.insert(schema.guestDocuments).values({
      eventId: id,
      kind,
      fileKey,
      uploadedBy: actor.id,
    })
    // Audit the fact of the upload — never the file contents.
    await audit(tx, actor, {
      entity: 'guest_documents',
      entityId: id,
      eventId: id,
      action: 'insert',
      field: kind,
      newValue: '(uploaded)',
    })
  })

  // The row is gone, so the bytes should be too. After the commit, never inside it: a
  // storage failure must not roll back an upload that has already succeeded, and an
  // unreachable Aadhaar image left in a bucket is still an Aadhaar image (rule 7).
  if (replaced) await deleteStored(replaced)

  return ok({ document: { kind } }, 201)
})
