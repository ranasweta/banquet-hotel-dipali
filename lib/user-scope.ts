import 'server-only'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest } from '@/lib/api'

/**
 * Which unit a user is responsible for, written from the Users screen.
 *
 * The two scopes are deliberately different shapes, and this module keeps them that way:
 *
 *   Lodge Manager    `users.lodging_unit_id`        one lodge, held on the user (mig 0013)
 *   Banquet Manager  `properties.banquet_manager_id` several properties, held on each
 *                                                   property (mig 0017) — the Regency
 *                                                   manager also covers Dipali Grand, which
 *                                                   a column on the user could not express
 *
 * Assigning a property that another manager holds moves it: the column takes one owner. That
 * is the intended behaviour (a handover), and the audit row records who lost it, so the
 * screen shows the current holder beside each property rather than hiding the transfer.
 *
 * Changing someone's role RELEASES the scope the new role cannot use. Otherwise a Lodge
 * Manager promoted to Booking Manager would keep a dangling lodge, and their old lodge board
 * would still answer to a user who no longer reads it.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type ScopeInput = {
  /** The lodge a Lodge Manager answers for. `undefined` leaves it as it is. */
  lodgingUnitId?: string | null
  /** The properties a Banquet Manager answers for. `undefined` leaves them as they are. */
  propertyIds?: string[]
}

/**
 * Applies (or releases) a user's unit scope inside the caller's transaction, auditing every
 * change. Throws a 400 if a Lodge Manager would be left without a lodge — that state is a
 * configuration mistake that surfaces much later as "no rooms visible", so it is refused at
 * the point it is made rather than at the point it hurts.
 */
export async function applyUserScope(
  tx: Tx,
  actor: Actor,
  userId: string,
  roleName: string,
  input: ScopeInput,
): Promise<void> {
  await applyLodgeScope(tx, actor, userId, roleName, input.lodgingUnitId)
  await applyBanquetScope(tx, actor, userId, roleName, input.propertyIds)
}

async function applyLodgeScope(
  tx: Tx,
  actor: Actor,
  userId: string,
  roleName: string,
  requested: string | null | undefined,
): Promise<void> {
  const [before] = await tx
    .select({ lodgingUnitId: schema.users.lodgingUnitId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)

  const isLodge = roleName === 'lodge_manager'
  const next = isLodge ? (requested !== undefined ? requested : (before?.lodgingUnitId ?? null)) : null

  if (isLodge && !next) {
    throw badRequest('A Lodge Manager needs a lodge — pick one, or they will see no rooms.')
  }
  if (next) {
    const [unit] = await tx
      .select({ id: schema.lodgingUnits.id })
      .from(schema.lodgingUnits)
      .where(eq(schema.lodgingUnits.id, next))
      .limit(1)
    if (!unit) throw badRequest('That lodge does not exist')
  }
  if ((before?.lodgingUnitId ?? null) === next) return

  await tx.update(schema.users).set({ lodgingUnitId: next }).where(eq(schema.users.id, userId))
  await audit(tx, actor, {
    entity: 'users',
    entityId: userId,
    action: 'update',
    field: 'lodging_unit_id',
    oldValue: before?.lodgingUnitId ?? null,
    newValue: next,
  })
}

async function applyBanquetScope(
  tx: Tx,
  actor: Actor,
  userId: string,
  roleName: string,
  requested: string[] | undefined,
): Promise<void> {
  const isBanquet = roleName === 'banquet_manager'
  // A Banquet Manager with no property is allowed: Residency is lodging only, so its manager
  // owns no venues yet (mig 0017). An empty board is legible; a lodge with no rooms is not.
  const next = isBanquet ? (requested ?? undefined) : []
  if (next === undefined) return

  const held = await tx
    .select({ id: schema.properties.id, name: schema.properties.name })
    .from(schema.properties)
    .where(eq(schema.properties.banquetManagerId, userId))
  const heldIds = new Set(held.map((p) => p.id))

  const releasing = held.filter((p) => !next.includes(p.id))
  const taking = next.filter((id) => !heldIds.has(id))

  if (releasing.length > 0) {
    await tx
      .update(schema.properties)
      .set({ banquetManagerId: null })
      .where(inArray(schema.properties.id, releasing.map((p) => p.id)))
  }

  // Read the previous holder before overwriting it, so the audit row names who lost the
  // property rather than only who gained it.
  const previous = new Map<string, string | null>()
  if (taking.length > 0) {
    const rows = await tx
      .select({ id: schema.properties.id, banquetManagerId: schema.properties.banquetManagerId })
      .from(schema.properties)
      .where(inArray(schema.properties.id, taking))
    if (rows.length !== taking.length) throw badRequest('One of those properties does not exist')
    for (const r of rows) previous.set(r.id, r.banquetManagerId)

    await tx
      .update(schema.properties)
      .set({ banquetManagerId: userId })
      .where(inArray(schema.properties.id, taking))
  }

  await audit(tx, actor, [
    ...releasing.map((p) => ({
      entity: 'properties',
      entityId: p.id,
      action: 'update' as const,
      field: 'banquet_manager_id',
      oldValue: userId,
      newValue: null,
    })),
    ...taking.map((id) => ({
      entity: 'properties',
      entityId: id,
      action: 'update' as const,
      field: 'banquet_manager_id',
      oldValue: previous.get(id) ?? null,
      newValue: userId,
    })),
  ])
}
