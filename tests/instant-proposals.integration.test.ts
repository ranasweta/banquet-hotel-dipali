/**
 * Instant proposals (client, 7 Oct 2026): only the name is required, every write is audited, and
 * a converted instant is read-only and cannot be converted twice.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

const { createInstantProposal, updateInstantProposal, markConverted, getInstantProposal, draftSchema } = await import(
  '@/lib/instant-proposals'
)
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping instant-proposal tests\n')

let actor = { id: '', roleName: '' }
let eventId = ''

beforeAll(async () => {
  if (!hasDb) return
  const setup = createClient('TEST_DATABASE_URL')
  try {
    await migrate(setup, () => {})
    await seed(setup, { reset: true, force: true, password: 'test-only' }, () => {})
  } finally {
    await setup.end()
  }
  const [u] = (await db.execute(sql`
    SELECT u.id, r.name AS "roleName" FROM users u JOIN roles r ON r.id = u.role_id LIMIT 1
  `)) as unknown as { id: string; roleName: string }[]
  actor = u!
  const [e] = (await db.execute(sql`
    INSERT INTO events (code, guest_name, event_type, created_by)
    VALUES ('E-INST-1', 'Instant guest', 'wedding', ${actor.id}) RETURNING id
  `)) as unknown as { id: string }[]
  eventId = e!.id
}, 120_000)

const auditRows = async (id: string) =>
  (await db.execute(sql`SELECT action, field FROM audit_log WHERE entity = 'instant_proposals' AND entity_id = ${id} ORDER BY seq`)) as unknown as {
    action: string
    field: string
  }[]

d('instant proposals', () => {
  it('saves with only a name, audits each change, and locks once converted', async () => {
    const id = await createInstantProposal(actor, 'Sharma', draftSchema.parse({}))
    const blank = await getInstantProposal(id)
    expect(blank.draft).toEqual({ fromDate: '', toDate: '', eventType: '', phone: '', functions: [], rooms: [] })

    const draft = draftSchema.parse({ functions: [{ name: 'Sangeet' }] })
    await updateInstantProposal(actor, id, 'Sharma family', draft)
    // An unchanged save writes nothing.
    await updateInstantProposal(actor, id, 'Sharma family', draft)
    expect((await getInstantProposal(id)).draft.functions[0]).toMatchObject({ name: 'Sangeet', eventDate: '', pax: 0 })

    await markConverted(actor, id, eventId)
    expect((await getInstantProposal(id)).convertedCode).toBe('E-INST-1')
    await expect(updateInstantProposal(actor, id, 'Again', draft)).rejects.toMatchObject({ status: 409 })
    await expect(markConverted(actor, id, eventId)).rejects.toMatchObject({ status: 409 })

    expect(await auditRows(id)).toEqual([
      { action: 'insert', field: 'name' },
      { action: 'update', field: 'name' },
      { action: 'update', field: 'draft' },
      { action: 'status', field: 'converted_event_id' },
    ])
  })
})
