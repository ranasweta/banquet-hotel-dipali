import 'server-only'
import webpush from 'web-push'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'

/**
 * Web push to the installed app.
 *
 * WHY THIS IS NOT WIRED INTO `lib/notifications.ts`. That module DERIVES the bell's feed on
 * every poll — it recomputes eleven queries and returns what is currently true. There is no
 * moment at which a notification is "created", so there is nothing there to push from. Push is
 * therefore raised at the WRITE that makes the news true, which is also the only place that
 * knows it is news rather than a repeat.
 *
 * The role sets those write sites use are imported from the same modules the bell and the
 * routes import, never re-declared. That mistake has already been made once here: the decider
 * sets were duplicated and the feed silently disagreed with the routes the moment change
 * requests passed from the Banquet Manager to the Authority.
 *
 * WHAT A PAYLOAD MAY CONTAIN. A push is rendered on a locked screen that anyone standing
 * nearby can read, so it carries the shape of the news and where to go — never a guest's
 * name, number, or what they are paying. `href` takes the reader to the screen where the
 * detail lives behind their own session.
 *
 * DELIVERY IS BEST-EFFORT AND NEVER BLOCKS A WRITE. A push that fails must not roll back the
 * approval that triggered it, so this is called after the transaction commits and every error
 * is swallowed apart from the two that mean "this device is gone", which prune the row.
 */

export type PushPayload = {
  title: string
  body: string
  href: string
  /** Same tag replaces rather than stacks — five reminders for one booking are one banner. */
  tag?: string
}

/** Configured only when both keys are present; without them push is silently inert. */
function configured(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return false
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@hoteldipali.example', pub, priv)
  return true
}

/**
 * Sends to every device belonging to these users. Returns how many were delivered — useful in
 * tests, ignored by callers, who must not care whether a phone was reachable.
 *
 * `410 Gone` and `404` are the browser telling us the subscription is dead (the app was
 * uninstalled, or the push service expired it). Those rows are deleted rather than retried:
 * keeping them means every later push pays for a failure that can never succeed.
 */
export async function pushToUsers(userIds: string[], payload: PushPayload): Promise<number> {
  try {
    return await deliver(userIds, payload)
  } catch {
    // Including its own database read. This function is called after a committed write, and
    // the ONLY contract it has is that it cannot damage that write — a call site forced to
    // wrap it in a try/catch would eventually be written without one.
    return 0
  }
}

async function deliver(userIds: string[], payload: PushPayload): Promise<number> {
  if (userIds.length === 0 || !configured()) return 0

  const subs = await db
    .select({
      id: schema.pushSubscriptions.id,
      endpoint: schema.pushSubscriptions.endpoint,
      p256dh: schema.pushSubscriptions.p256Dh,
      auth: schema.pushSubscriptions.auth,
    })
    .from(schema.pushSubscriptions)
    .where(inArray(schema.pushSubscriptions.userId, userIds))
  if (subs.length === 0) return 0

  const body = JSON.stringify(payload)
  const dead: string[] = []
  let sent = 0

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        )
        sent += 1
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) dead.push(s.id)
        // Anything else — a push service having a bad minute — is dropped. The bell still
        // shows the item, so the news is not lost, only its banner.
      }
    }),
  )

  if (dead.length > 0) {
    await db.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.id, dead))
  }
  return sent
}

/** Every user holding one of these roles, for pushes aimed at a queue rather than a person. */
export async function usersInRoles(roles: string[]): Promise<string[]> {
  if (roles.length === 0) return []
  try {
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
      .where(and(inArray(schema.roles.name, roles), eq(schema.users.isActive, true)))
    return rows.map((r) => r.id)
  } catch {
    return []
  }
}

/**
 * Who raised these asks, so a decision can be sent back to them. Exceptions and change
 * requests name their raiser in different columns, which is why this is one place rather than
 * a join at each call site.
 */
export async function raisersOf(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  try {
    const rows = (await db.execute(sql`
      SELECT raised_by AS id FROM exceptions WHERE id IN ${sql`(${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`}
      UNION
      SELECT requested_by AS id FROM change_requests WHERE id IN ${sql`(${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`}
    `)) as unknown as { id: string }[]
    return rows.map((r) => r.id)
  } catch {
    return []
  }
}

/**
 * Records a device against the signed-in user. Re-subscribing on a device someone else used
 * re-points the row: staff share phones at a counter, and the endpoint is the device, not the
 * person.
 */
export async function saveSubscription(
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string | null,
): Promise<void> {
  await db
    .insert(schema.pushSubscriptions)
    .values({
      userId,
      endpoint: sub.endpoint,
      p256Dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: {
        userId,
        p256Dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: userAgent ?? null,
        lastSeen: new Date().toISOString(),
      },
    })
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint))
}
