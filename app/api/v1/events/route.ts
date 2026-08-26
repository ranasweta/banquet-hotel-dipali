import type { NextRequest } from 'next/server'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { getCurrentUser, requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { badRequest, ok, route, unauthorized } from '@/lib/api'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const createSchema = z
  .object({
    guest_name: z.string().trim().min(1).max(160),
    event_type: z.string().min(1),
    // The proposal's declared run (client, 22 Jul 2026): rooms are bounded by this window.
    from_date: z.string().regex(ISO_DATE).optional(),
    to_date: z.string().regex(ISO_DATE).optional(),
    contacts: z
      .array(z.object({
        // Indian mobile numbers are exactly 10 digits (client, 22 Jul 2026).
        phone: z.string().trim().regex(/^\d{10}$/, 'Enter a 10-digit mobile number'),
        label: z.string().max(40).optional(),
      }))
      .min(1)
      .max(6),
  })
  .refine((v) => !v.from_date || !v.to_date || v.to_date >= v.from_date, {
    message: 'The To date cannot be before the From date',
  })

/** POST /events — create an enquiry with its guest contacts (FR-1.11). */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const input = createSchema.parse(await req.json())

  const [et] = await db
    .select({ contactNumbers: schema.eventTypes.contactNumbers })
    .from(schema.eventTypes)
    .where(eq(schema.eventTypes.code, input.event_type))
    .limit(1)
  if (!et) throw badRequest('Unknown event type')

  // De-dupe phones (event_contacts PK is (event_id, phone)).
  const contacts = [...new Map(input.contacts.map((c) => [c.phone, c])).values()]
  if (contacts.length < et.contactNumbers) {
    throw badRequest(
      `${et.contactNumbers} contact number${et.contactNumbers > 1 ? 's are' : ' is'} required for this event type`,
    )
  }

  const created = await db.transaction(async (tx) => {
    const [code] = (await tx.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as {
      code: string
    }[]
    const [event] = await tx
      .insert(schema.events)
      .values({
        code: code!.code,
        guestName: input.guest_name,
        eventType: input.event_type,
        plannedFrom: input.from_date ?? null,
        plannedTo: input.to_date ?? null,
        createdBy: actor.id,
      })
      .returning({ id: schema.events.id, code: schema.events.code })

    await tx.insert(schema.eventContacts).values(
      contacts.map((c) => ({ eventId: event!.id, phone: c.phone, label: c.label ?? null })),
    )
    await audit(tx, actor, {
      entity: 'events',
      entityId: event!.id,
      eventId: event!.id,
      action: 'insert',
      field: 'guest_name',
      newValue: input.guest_name,
    })
    return event!
  })

  return ok({ event: { id: created.id, code: created.code, status: 'enquiry' } }, 201)
})

const STALE_DAYS = 7

/** GET /events — dashboard list, filterable by status/date and `mine`. */
export const GET = route(async (req: NextRequest) => {
  const user = await getCurrentUser()
  if (!user) throw unauthorized()
  await requirePermission('bookings', 'view')

  const params = new URL(req.url).searchParams
  const status = params.get('status')
  const from = params.get('from')
  const to = params.get('to')
  const mine = params.get('mine') === 'true'
  const q = params.get('q')?.trim()
  const eventType = params.get('type')

  // WHEN THE BOOKING ACTUALLY RUNS. `first_date`/`last_date` are caches written at confirm and
  // can be NULL on a booking that has functions, so filtering on them quietly drops proposals
  // that plainly fall inside the range. The functions' own dates decide; the declared run
  // answers for a proposal that has none yet, and the caches are the last resort.
  const spanStart = sql`COALESCE((SELECT min(se.event_date) FROM sub_events se WHERE se.event_id = ${schema.events.id}),
                                 ${schema.events.plannedFrom}, ${schema.events.firstDate})`
  const spanEnd = sql`COALESCE((SELECT max(se.event_date) FROM sub_events se WHERE se.event_id = ${schema.events.id}),
                               ${schema.events.plannedTo}, ${schema.events.lastDate})`

  const conditions = []
  if (status) conditions.push(eq(schema.events.status, status as typeof schema.events.status.enumValues[number]))
  // Overlap, not containment: a wedding running 28–30 Jan belongs in a search for the 29th.
  if (from && ISO_DATE.test(from)) conditions.push(sql`${spanEnd} >= ${from}::date`)
  if (to && ISO_DATE.test(to)) conditions.push(sql`${spanStart} <= ${to}::date`)
  if (mine) conditions.push(eq(schema.events.createdBy, user.id))
  if (eventType) conditions.push(eq(schema.events.eventType, eventType))
  // Searched SERVER-side, so it reaches past the 200 most recent rather than filtering the
  // page you happen to be looking at — the whole point of searching an old proposal. The code
  // is matched too: staff quote "E-1065" to each other far more than they type a full name.
  if (q) {
    // % and _ are LIKE wildcards; a guest who types one should match that character, not
    // everything. Backslash is Postgres's default LIKE escape.
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    conditions.push(sql`(${schema.events.guestName} ILIKE ${like} OR ${schema.events.code} ILIKE ${like})`)
  }

  const rows = await db
    .select({
      id: schema.events.id,
      code: schema.events.code,
      guestName: schema.events.guestName,
      eventType: schema.events.eventType,
      status: schema.events.status,
      firstDate: schema.events.firstDate,
      lastDate: schema.events.lastDate,
      // The span the date filter matches on, so a row found by date can actually show its
      // dates. `first_date` is NULL on plenty of enquiries that plainly have functions.
      startDate: sql<string | null>`(${spanStart})::text`,
      endDate: sql<string | null>`(${spanEnd})::text`,
      proposalTotalPaise: schema.events.proposalTotalPaise,
      updatedAt: schema.events.updatedAt,
      // Who took the enquiry. The list is read by people who did not take it, and "whose
      // proposal is this?" was being answered by opening the trail (client, 26 Aug 2026).
      createdByName: schema.users.fullName,
      // Stale: an enquiry untouched for STALE_DAYS days (FR-1.8).
      stale: sql<boolean>`(${schema.events.status} = 'enquiry' AND ${schema.events.updatedAt} < now() - (${STALE_DAYS} || ' days')::interval)`,
    })
    .from(schema.events)
    .innerJoin(schema.users, eq(schema.users.id, schema.events.createdBy))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.events.createdAt))
    .limit(200)

  // The filter's options, so the screen offers every configured type rather than only the ones
  // that happen to appear in this page of results.
  const types = await db
    .select({ code: schema.eventTypes.code, displayName: schema.eventTypes.displayName })
    .from(schema.eventTypes)
    .orderBy(schema.eventTypes.displayName)

  return ok({ events: rows, eventTypes: types })
})
