import { NextResponse, type NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { errorResponse } from '@/lib/api'
import { platePhotoKey } from '@/lib/utensils'
import { readDecrypted } from '@/lib/storage'

/**
 * GET /extra-plates/:id/photo — the decrypted photograph of the plates.
 *
 * `utensils:view` is what gates it, which by default means the Auditor, the Higher Authority
 * and the Utensil Manager himself. That is the point of the whole feature: the people who can
 * question the charge are exactly the people who can see the evidence for it.
 *
 * `no-store` so an image of a charge under dispute is never served from a shared cache.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission('utensils', 'view')
    const { id } = await ctx.params
    const { bytes, contentType } = await readDecrypted(await platePhotoKey(id))
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': contentType, 'cache-control': 'private, no-store', 'content-disposition': 'inline' },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
