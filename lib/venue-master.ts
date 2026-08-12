import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { assertPaise } from '@/lib/money'
import { BOOKABLE_EVENT_TYPES, eventTypeLabel } from '@/lib/event-types'

/**
 * The venue master (client, 12 Aug 2026) — "we will give whole centre point to set whatever he
 * gets ... to keep all things transparent and configured".
 *
 * The halls, the bundles the Auditor makes out of them, and what each costs per event type.
 * Everything the pricing code reads about venues is editable here, which is the point: the
 * rule that an "Other" booking pays no standalone hall charge is not a branch in TypeScript,
 * it is a row of zeroes the Auditor can see and change (migration 0029).
 *
 * TWO KINDS OF "NO CHARGE", AND THEY MUST NOT BE CONFUSED:
 *
 *   rate 0      A DECISION. The venue is offered, costs nothing for that event type, and
 *               confirmation proceeds.
 *   no row      A GATE (BR-R1). Nobody has priced it; confirm is blocked until the Authority
 *               approves a manual rate, and the venue is not even offered standalone.
 *
 * Deleting a rate is therefore a very different act from setting it to zero, and the screen
 * says so. Rates are EFFECTIVE-DATED like menu prices: a new price is a new row, so what a
 * hall cost last March is still on record and last March's bill can still be explained.
 * Confirmed bookings are unaffected either way — `confirmEvent` snapshots the rate onto the
 * sub-event.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Postgres unique-violation, unwrapped from Drizzle's wrapper (see menu-master.ts). */
function isUnique(err: unknown): boolean {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && (cur as { code: unknown }).code === '23505') return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

// ── Read ─────────────────────────────────────────────────────────────────────

export type MasterRate = { eventType: string; ratePaise: number; effectiveFrom: string; current: boolean }
export type MasterVenue = {
  id: string
  name: string
  propertyName: string
  kind: string
  isActive: boolean
  /** Rates in force today, one per event type. Absent = a gate, not a zero. */
  rates: MasterRate[]
  /** Bookings already made here. Their snapshots are unaffected by anything on this screen. */
  bookings: number
}
export type MasterBundle = {
  id: string
  name: string
  members: { id: string; name: string }[]
  rates: MasterRate[]
  bookings: number
}
export type VenueCatalog = {
  properties: { id: string; name: string }[]
  eventTypes: { code: string; displayName: string }[]
  venues: MasterVenue[]
  bundles: MasterBundle[]
}

/** Rates in force today for every venue and bundle, keyed by target id. */
async function currentRates(): Promise<Map<string, MasterRate[]>> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(venue_id, bundle_id)::text AS "targetId", event_type AS "eventType",
           rate_paise AS "ratePaise", effective_from::text AS "effectiveFrom",
           effective_from = (
             SELECT max(r2.effective_from) FROM venue_rate_cards r2
              WHERE r2.event_type = r.event_type
                AND r2.venue_id IS NOT DISTINCT FROM r.venue_id
                AND r2.bundle_id IS NOT DISTINCT FROM r.bundle_id
                AND r2.effective_from <= CURRENT_DATE
           ) AS current
    FROM venue_rate_cards r
    ORDER BY event_type, effective_from DESC
  `)) as unknown as (MasterRate & { targetId: string })[]

  const byTarget = new Map<string, MasterRate[]>()
  for (const r of rows) {
    const { targetId, ...rest } = r
    byTarget.set(targetId, [...(byTarget.get(targetId) ?? []), { ...rest, ratePaise: Number(rest.ratePaise) }])
  }
  return byTarget
}

export async function getVenueCatalog(): Promise<VenueCatalog> {
  const [properties, eventTypes, venues, bundles, members, rates] = await Promise.all([
    db.execute(sql`SELECT id, name FROM properties ORDER BY name`) as unknown as Promise<{ id: string; name: string }[]>,
    // The two a booking can actually be made as — Wedding and Others. The table holds six,
    // but the other four are unreachable from the wizard, and a price nobody can select is
    // four extra columns to read past on every venue.
    db.execute(sql`
      SELECT code, display_name AS "displayName" FROM event_types
       WHERE code IN (${sql.join(BOOKABLE_EVENT_TYPES.map((c) => sql`${c}`), sql`, `)})
       ORDER BY is_wedding DESC, display_name
    `) as unknown as Promise<{ code: string; displayName: string }[]>,
    db.execute(sql`
      SELECT v.id, v.name, v.kind, v.is_active AS "isActive", p.name AS "propertyName",
             (SELECT count(*)::int FROM sub_events se WHERE se.venue_id = v.id) AS bookings
      FROM venues v JOIN properties p ON p.id = v.property_id
      ORDER BY p.name, v.name
    `) as unknown as Promise<Omit<MasterVenue, 'rates'>[]>,
    db.execute(sql`
      SELECT b.id, b.name,
             (SELECT count(*)::int FROM sub_events se WHERE se.bundle_id = b.id) AS bookings
      FROM venue_bundles b ORDER BY b.name
    `) as unknown as Promise<Omit<MasterBundle, 'rates' | 'members'>[]>,
    db.execute(sql`
      SELECT m.bundle_id AS "bundleId", v.id, v.name
      FROM venue_bundle_members m JOIN venues v ON v.id = m.venue_id
      ORDER BY v.name
    `) as unknown as Promise<{ bundleId: string; id: string; name: string }[]>,
    currentRates(),
  ])

  const membersByBundle = new Map<string, { id: string; name: string }[]>()
  for (const m of members) {
    membersByBundle.set(m.bundleId, [...(membersByBundle.get(m.bundleId) ?? []), { id: m.id, name: m.name }])
  }

  return {
    properties,
    // "Others", not "Other" — the word the hotel uses and the word the wizard's dropdown shows.
    eventTypes: eventTypes.map((t) => ({ ...t, displayName: eventTypeLabel(t.code, t.displayName) })),
    venues: venues.map((v) => ({ ...v, rates: rates.get(v.id) ?? [] })),
    bundles: bundles.map((b) => ({
      ...b,
      members: membersByBundle.get(b.id) ?? [],
      rates: rates.get(b.id) ?? [],
    })),
  }
}

// ── Venues ───────────────────────────────────────────────────────────────────

/**
 * Adds a hall or a lawn.
 *
 * NO CAPACITY IS ASKED FOR (client, 13 Aug 2026: "why are u taking seats?"). It gates nothing
 * — rule 13 removed the last capacity check — and it is displayed nowhere, so the form was
 * collecting two numbers that do nothing. The columns stay NULL rather than defaulting to some
 * invented range: "nobody wrote it down" is the truth, and 1–100 would be seed data invented
 * through the back door. The seeded venues keep the real figures they came with.
 */
export async function createVenue(
  actor: Actor,
  input: { propertyId: string; name: string; kind: string },
): Promise<{ id: string }> {
  const name = input.name.trim()
  if (!name) throw badRequest('A venue needs a name.')
  if (!['hall', 'lawn'].includes(input.kind)) throw badRequest('A venue is a hall or a lawn.')

  return db.transaction(async (tx) => {
    try {
      const [v] = await tx
        .insert(schema.venues)
        .values({ propertyId: input.propertyId, name, kind: input.kind })
        .returning({ id: schema.venues.id })
      await audit(tx, actor, {
        entity: 'venues', entityId: v!.id, action: 'insert', field: 'name', newValue: name,
      })
      // Deliberately NO rate card. A new venue is a gate until somebody prices it (BR-R1) —
      // creating one at zero would put a free hall on the board that nobody chose to give away.
      return { id: v!.id }
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${name}" already exists at that property.`)
      throw e
    }
  })
}

export async function updateVenue(
  actor: Actor,
  venueId: string,
  patch: { name?: string; kind?: string; isActive?: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [v] = await tx.select().from(schema.venues).where(eq(schema.venues.id, venueId)).limit(1)
    if (!v) throw notFound('Venue not found')

    const name = patch.name?.trim() ?? v.name
    if (!name) throw badRequest('A venue needs a name.')
    // Capacity is not editable here for the same reason it is not asked for on creation: it
    // gates nothing and is shown nowhere. The seeded figures are left exactly as they are.
    const next = {
      name,
      kind: patch.kind ?? v.kind,
      isActive: patch.isActive ?? v.isActive,
    }
    try {
      await tx.update(schema.venues).set(next).where(eq(schema.venues.id, venueId))
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${name}" already exists at that property.`)
      throw e
    }
    // Renaming does not touch a booked event: the bill reads the venue's name through the
    // booking, and confirmed events carry their own snapshotted rate.
    await audit(tx, actor, {
      entity: 'venues', entityId: venueId, action: 'update', field: 'venue',
      oldValue: `${v.name}${v.isActive ? '' : ' (retired)'}`,
      newValue: `${next.name}${next.isActive ? '' : ' (retired)'}`,
    })
  })
}

// ── Bundles ──────────────────────────────────────────────────────────────────

async function writeMembers(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  bundleId: string,
  venueIds: string[],
): Promise<void> {
  if (venueIds.length < 2) throw badRequest('A bundle needs at least two venues — one hall is not a bundle.')
  if (new Set(venueIds).size !== venueIds.length) throw badRequest('That venue is in the bundle twice.')
  await tx.delete(schema.venueBundleMembers).where(eq(schema.venueBundleMembers.bundleId, bundleId))
  await tx.insert(schema.venueBundleMembers).values(venueIds.map((venueId) => ({ bundleId, venueId })))
}

export async function createBundle(
  actor: Actor,
  input: { name: string; venueIds: string[] },
): Promise<{ id: string }> {
  const name = input.name.trim()
  if (!name) throw badRequest('A bundle needs a name.')

  return db.transaction(async (tx) => {
    let bundleId: string
    try {
      const [b] = await tx.insert(schema.venueBundles).values({ name }).returning({ id: schema.venueBundles.id })
      bundleId = b!.id
    } catch (e) {
      if (isUnique(e)) throw conflict(`A bundle called "${name}" already exists.`)
      throw e
    }
    await writeMembers(tx, bundleId, input.venueIds)
    await audit(tx, actor, {
      entity: 'venue_bundles', entityId: bundleId, action: 'insert', field: 'name',
      newValue: `${name} (${input.venueIds.length} venues)`,
    })
    return { id: bundleId }
  })
}

/**
 * Renames a bundle and/or replaces its membership.
 *
 * Changing members changes what booking it BLOCKS (FR-2.3) — a bundle holds every member
 * venue — so it is refused once anything has been booked against it. Make a new bundle
 * instead; the old one keeps explaining the bookings that used it.
 */
export async function updateBundle(
  actor: Actor,
  bundleId: string,
  patch: { name?: string; venueIds?: string[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [b] = await tx.select().from(schema.venueBundles).where(eq(schema.venueBundles.id, bundleId)).limit(1)
    if (!b) throw notFound('Bundle not found')

    if (patch.venueIds) {
      const [{ n }] = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM sub_events WHERE bundle_id = ${bundleId}
      `)) as unknown as { n: number }[]
      if (n > 0) {
        throw conflict(
          `${b.name} is on ${n} booking(s), so its venues can no longer be changed — ` +
            `it decides which halls those bookings hold. Make a new bundle instead.`,
        )
      }
      await writeMembers(tx, bundleId, patch.venueIds)
    }

    const name = patch.name?.trim() ?? b.name
    if (!name) throw badRequest('A bundle needs a name.')
    if (name !== b.name) {
      try {
        await tx.update(schema.venueBundles).set({ name }).where(eq(schema.venueBundles.id, bundleId))
      } catch (e) {
        if (isUnique(e)) throw conflict(`A bundle called "${name}" already exists.`)
        throw e
      }
    }
    await audit(tx, actor, {
      entity: 'venue_bundles', entityId: bundleId, action: 'update', field: 'bundle',
      oldValue: b.name,
      newValue: patch.venueIds ? `${name} (${patch.venueIds.length} venues)` : name,
    })
  })
}

// ── Rates ────────────────────────────────────────────────────────────────────

/**
 * Sets what a venue or bundle costs for one event type, from a date.
 *
 * ZERO IS ALLOWED AND MEANS FREE — that is how "an Other booking pays no standalone hall
 * charge" is expressed. Removing the rate is `clearRate`, and it means something else
 * entirely (see the module comment).
 */
export async function setRate(
  actor: Actor,
  target: { venueId?: string; bundleId?: string },
  input: { eventType: string; ratePaise: number; effectiveFrom: string },
): Promise<void> {
  if (Boolean(target.venueId) === Boolean(target.bundleId)) {
    throw badRequest('A rate belongs to a venue or a bundle, not both and not neither.')
  }
  assertPaise(input.ratePaise)
  if (input.ratePaise < 0) throw badRequest('A rate cannot be negative. Zero means free.')
  if (!ISO_DATE.test(input.effectiveFrom)) throw badRequest('Effective-from must be YYYY-MM-DD.')

  await db.transaction(async (tx) => {
    const [existing] = (await tx.execute(sql`
      SELECT rate_paise AS "ratePaise" FROM venue_rate_cards
       WHERE venue_id IS NOT DISTINCT FROM ${target.venueId ?? null}::uuid
         AND bundle_id IS NOT DISTINCT FROM ${target.bundleId ?? null}::uuid
         AND event_type = ${input.eventType}
         AND effective_from = ${input.effectiveFrom}::date
    `)) as unknown as { ratePaise: number }[]

    // No unique constraint covers (venue, bundle, type, date) — bundle_id is NULL for a venue
    // row and NULLs are distinct — so the upsert is done by hand rather than ON CONFLICT.
    if (existing) {
      await tx.execute(sql`
        UPDATE venue_rate_cards SET rate_paise = ${input.ratePaise}
         WHERE venue_id IS NOT DISTINCT FROM ${target.venueId ?? null}::uuid
           AND bundle_id IS NOT DISTINCT FROM ${target.bundleId ?? null}::uuid
           AND event_type = ${input.eventType}
           AND effective_from = ${input.effectiveFrom}::date
      `)
    } else {
      await tx.execute(sql`
        INSERT INTO venue_rate_cards (venue_id, bundle_id, event_type, rate_paise, effective_from)
        VALUES (${target.venueId ?? null}::uuid, ${target.bundleId ?? null}::uuid,
                ${input.eventType}, ${input.ratePaise}, ${input.effectiveFrom}::date)
      `)
    }

    await audit(tx, actor, {
      entity: 'venue_rate_cards',
      entityId: (target.venueId ?? target.bundleId)!,
      action: existing ? 'update' : 'insert',
      field: `${input.eventType} rate from ${input.effectiveFrom}`,
      oldValue: existing ? String(existing.ratePaise) : null,
      newValue: String(input.ratePaise),
    })
  })
}

/**
 * Removes a rate entirely, turning that venue + event type back into a GATE (BR-R1).
 *
 * Not the same as setting zero, and the caller must have said so out loud: an unpriced venue
 * disappears from the standalone picker and blocks confirmation until the Authority approves a
 * manual rate. That is occasionally what you want — a hall withdrawn from sale for weddings —
 * and never what you want by accident.
 */
export async function clearRate(
  actor: Actor,
  target: { venueId?: string; bundleId?: string },
  eventType: string,
): Promise<void> {
  if (Boolean(target.venueId) === Boolean(target.bundleId)) {
    throw badRequest('A rate belongs to a venue or a bundle, not both and not neither.')
  }
  await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM venue_rate_cards
       WHERE venue_id IS NOT DISTINCT FROM ${target.venueId ?? null}::uuid
         AND bundle_id IS NOT DISTINCT FROM ${target.bundleId ?? null}::uuid
         AND event_type = ${eventType}
      RETURNING rate_paise AS "ratePaise"
    `)) as unknown as { ratePaise: number }[]
    if (rows.length === 0) throw notFound('There is no rate to remove.')

    await audit(tx, actor, {
      entity: 'venue_rate_cards',
      entityId: (target.venueId ?? target.bundleId)!,
      action: 'delete',
      field: `${eventType} rate`,
      oldValue: rows.map((r) => String(r.ratePaise)).join(', '),
    })
  })
}
