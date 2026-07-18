import { NextResponse, type NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { errorResponse, notFound } from '@/lib/api'
import { entryAttachmentKey } from '@/lib/maintenance'
import { readDecrypted } from '@/lib/storage'

/** GET /maintenance/:id/attachment — the decrypted receipt/photo, behind a permission check. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission('maintenance', 'view')
    const { id } = await ctx.params
    const fileKey = await entryAttachmentKey(id)
    if (!fileKey) throw notFound('This entry has no attachment')
    const { bytes, contentType } = await readDecrypted(fileKey)
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': contentType, 'cache-control': 'private, no-store', 'content-disposition': 'inline' },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
