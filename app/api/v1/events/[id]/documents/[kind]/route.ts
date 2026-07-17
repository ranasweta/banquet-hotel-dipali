import { NextResponse, type NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { errorResponse, notFound } from '@/lib/api'
import { readDecrypted } from '@/lib/storage'

const kindSchema = z.enum(['aadhaar_front', 'aadhaar_back', 'receipt', 'other'])

/**
 * GET /events/:id/documents/:kind — returns the decrypted image bytes, gated on Bookings
 * view permission (FR-1.10: visible only to roles with Bookings view). Never logs the
 * bytes. Not cacheable by shared caches.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; kind: string }> },
) {
  try {
    await requirePermission('bookings', 'view')
    const { id, kind } = await ctx.params
    const parsedKind = kindSchema.parse(kind)

    const [doc] = await db
      .select({ fileKey: schema.guestDocuments.fileKey })
      .from(schema.guestDocuments)
      .where(and(eq(schema.guestDocuments.eventId, id), eq(schema.guestDocuments.kind, parsedKind)))
      .limit(1)
    if (!doc) throw notFound('Document not found')

    const { bytes, contentType } = await readDecrypted(doc.fileKey)
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'private, no-store',
        'content-disposition': `inline; filename="${parsedKind}"`,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
