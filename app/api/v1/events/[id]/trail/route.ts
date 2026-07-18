import { NextResponse, type NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { errorResponse, ok } from '@/lib/api'
import { getTrail, trailCsv, trailEntities } from '@/lib/audit-trail'

/**
 * GET /events/:id/trail?user=&entity=&from=&to=&export=csv — the event's audit timeline
 * (FR-10.2). Gated on the audit module. `export=csv` streams a CSV download.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission('audit', 'view')
    const { id } = await ctx.params
    const p = new URL(req.url).searchParams
    const filter = {
      userId: p.get('user') ?? undefined,
      entity: p.get('entity') ?? undefined,
      from: p.get('from') ?? undefined,
      to: p.get('to') ?? undefined,
    }
    const rows = await getTrail(id, filter)
    if (p.get('export') === 'csv') {
      return new NextResponse(trailCsv(rows), {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="audit-${id}.csv"` },
      })
    }
    return ok({ trail: rows, entities: await trailEntities(id) })
  } catch (err) {
    return errorResponse(err)
  }
}
