import 'server-only'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { conflict, notFound } from '@/lib/api'

/**
 * Instant proposals (client, 7 Oct 2026; migration 0039) — the demo proposal, saved. Only the
 * name is required; every other field may be blank and changed at any time, because an instant
 * holds nothing (no venue, no room, no money). When the guest commits, the page converts it
 * into a real enquiry through the ordinary routes and `markConverted` records which one; from
 * then on the instant is read-only.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const blankOr = (re: RegExp) => z.union([z.literal(''), z.string().regex(re)])

export const draftSchema = z.object({
  fromDate: blankOr(ISO_DATE).default(''),
  toDate: blankOr(ISO_DATE).default(''),
  eventType: z.string().max(40).default(''),
  phone: z.string().max(10).default(''),
  functions: z
    .array(
      z.object({
        name: z.string().max(80).default(''),
        eventDate: blankOr(ISO_DATE).default(''),
        startTime: blankOr(HHMM).default(''),
        endTime: blankOr(HHMM).default(''),
        /** `venue:<uuid>` or `bundle:<uuid>`, or '' for none yet. */
        target: z.string().max(60).default(''),
        pax: z.number().int().nonnegative().default(0),
        tierId: z.string().max(40).default(''),
        /** Category name → the dishes picked in it. */
        dishes: z.record(z.string(), z.array(z.string())).default({}),
      }),
    )
    .max(30)
    .default([]),
  rooms: z
    .array(
      z.object({
        unitId: z.uuid(),
        roomType: z.string().min(1).max(40),
        count: z.number().int().positive(),
        nights: z.number().int().positive(),
      }),
    )
    .max(50)
    .default([]),
})
export type InstantDraft = z.infer<typeof draftSchema>

export const nameSchema = z.string().trim().min(1, 'Give the instant proposal a name').max(160)

export type InstantRow = {
  id: string
  name: string
  draft: InstantDraft
  convertedEventId: string | null
  convertedCode: string | null
  createdByName: string
  updatedAt: string
}

const columns = {
  id: schema.instantProposals.id,
  name: schema.instantProposals.name,
  draft: schema.instantProposals.draft,
  convertedEventId: schema.instantProposals.convertedEventId,
  convertedCode: schema.events.code,
  createdByName: schema.users.fullName,
  updatedAt: schema.instantProposals.updatedAt,
}

function base() {
  return db
    .select(columns)
    .from(schema.instantProposals)
    .innerJoin(schema.users, eq(schema.users.id, schema.instantProposals.createdBy))
    .leftJoin(schema.events, eq(schema.events.id, schema.instantProposals.convertedEventId))
}

export async function listInstantProposals(): Promise<InstantRow[]> {
  const rows = await base().orderBy(desc(schema.instantProposals.updatedAt)).limit(200)
  return rows.map((r) => ({ ...r, draft: draftSchema.parse(r.draft) }))
}

export async function getInstantProposal(id: string): Promise<InstantRow> {
  const [row] = await base().where(eq(schema.instantProposals.id, id)).limit(1)
  if (!row) throw notFound('Instant proposal not found')
  return { ...row, draft: draftSchema.parse(row.draft) }
}

export async function createInstantProposal(actor: Actor, name: string, draft: InstantDraft): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.instantProposals)
      .values({ name, draft, createdBy: actor.id })
      .returning({ id: schema.instantProposals.id })
    await audit(tx, actor, {
      entity: 'instant_proposals',
      entityId: row!.id,
      action: 'insert',
      field: 'name',
      newValue: name,
    })
    return row!.id
  })
}

export async function updateInstantProposal(actor: Actor, id: string, name: string, draft: InstantDraft): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        name: schema.instantProposals.name,
        draft: schema.instantProposals.draft,
        convertedEventId: schema.instantProposals.convertedEventId,
      })
      .from(schema.instantProposals)
      .where(eq(schema.instantProposals.id, id))
      .for('update')
    if (!before) throw notFound('Instant proposal not found')
    if (before.convertedEventId) throw conflict('This instant proposal has been converted — edit the real proposal instead.')

    // Both through the schema: jsonb hands keys back in its own order, not the one written.
    const oldDraft = JSON.stringify(draftSchema.parse(before.draft))
    const newDraft = JSON.stringify(draftSchema.parse(draft))
    if (before.name === name && oldDraft === newDraft) return

    await tx
      .update(schema.instantProposals)
      .set({ name, draft, updatedAt: new Date().toISOString() })
      .where(eq(schema.instantProposals.id, id))
    const entries = []
    if (before.name !== name) {
      entries.push({ field: 'name', oldValue: before.name, newValue: name })
    }
    if (oldDraft !== newDraft) entries.push({ field: 'draft', oldValue: oldDraft, newValue: newDraft })
    await audit(
      tx,
      actor,
      entries.map((e) => ({ ...e, entity: 'instant_proposals', entityId: id, action: 'update' as const })),
    )
  })
}

/** Records the real enquiry an instant became. Once only — a second conversion would duplicate it. */
export async function markConverted(actor: Actor, id: string, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ convertedEventId: schema.instantProposals.convertedEventId })
      .from(schema.instantProposals)
      .where(eq(schema.instantProposals.id, id))
      .for('update')
    if (!before) throw notFound('Instant proposal not found')
    if (before.convertedEventId) throw conflict('This instant proposal has already been converted.')
    const now = new Date().toISOString()
    await tx
      .update(schema.instantProposals)
      .set({ convertedEventId: eventId, convertedAt: now, updatedAt: now })
      .where(eq(schema.instantProposals.id, id))
    await audit(tx, actor, {
      entity: 'instant_proposals',
      entityId: id,
      eventId,
      action: 'status',
      field: 'converted_event_id',
      newValue: eventId,
    })
  })
}
